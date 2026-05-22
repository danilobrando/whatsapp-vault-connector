#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * WhatsApp Vault Daemon
 *
 * Persistent process that maintains a Baileys connection,
 * listens for real-time messages, and appends them to vault
 * markdown files. Also exposes a Unix socket for sending.
 *
 * Managed by launchd (label configurable per install; default
 * com.whatsapp-connector.daemon).
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidGroup,
  isJidStatusBroadcast,
  isJidNewsletter,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { fileURLToPath } from 'url'

const __dir = path.dirname(fileURLToPath(import.meta.url))
// Standard install path: <vault>/connectors/whatsapp/  (this file lives 2 dirs deep)
const VAULT_ROOT = process.env.VAULT_ROOT || path.resolve(__dir, '..', '..')
// Inbox can be overridden via env (e.g. for upgrades from legacy installs that
// kept conversation files under ⚙️ Meta/whatsapp-inbox/).
const WA_INBOX = process.env.WA_INBOX_PATH || path.join(VAULT_ROOT, '⚙️ Meta', 'whatsapp-inbox')
const AUTH_DIR = path.join(__dir, 'baileys_auth')
const STORE_FILE = path.join(__dir, 'baileys_store.json')
const STATE_FILE = path.join(__dir, '.daemon_state.json')
const LOCK_FILE = path.join(__dir, '.daemon.lock')
const SOCKET_PATH = '/tmp/whatsapp-daemon.sock'
const MSGSTORE_FILE = path.join(__dir, '.message_store.json')
const HEARTBEAT_FILE = path.join(__dir, '.daemon_heartbeat')

// Tunables. Lower keepAlive than Baileys default (30s) reduces 408 timeouts
// because WhatsApp's server-side timeout is ~30s; missing one ping is fatal.
const KEEPALIVE_INTERVAL_MS = 10_000
const CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_QUERY_TIMEOUT_MS = 60_000
const SEND_ACK_TIMEOUT_MS = 15_000
const MSGSTORE_SAVE_INTERVAL_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 30_000

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino/file',
    options: { destination: path.join(__dir, 'logs', 'daemon.log') },
  },
})

// ── State ────────────────────────────────────────────────────────────────────

let sock = null
let connected = false
let contacts = {}
let jidToFile = new Map()
let processedIds = new Map()
let messageStore = new Map()
const MESSAGE_STORE_MAX = 5000
let startedAt = new Date().toISOString()
let lastMessageAt = null
let reconnectDelay = 3000

// ── Formatting (timezone + own-sender name configurable via env) ────────────

const TZ = process.env.WA_TZ || 'America/Bogota'
const SENDER_NAME = process.env.WA_SENDER_NAME || 'Me'

function formatTime(unix) {
  return new Date(Number(unix) * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ,
  })
}

function formatDate(unix) {
  return new Date(Number(unix) * 1000).toLocaleDateString('sv-SE', { timeZone: TZ })
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ })
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>[\]]/g, '-').trim() || 'Unknown'
}

// ── Message text extraction (same as sync.mjs) ──────────────────────────────

function extractText(msg) {
  if (!msg?.message) return null
  const m = msg.message
  if (m.conversation)              return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage)              return m.imageMessage.caption ? `[Image: ${m.imageMessage.caption}]` : '[Image]'
  if (m.videoMessage)              return m.videoMessage.caption ? `[Video: ${m.videoMessage.caption}]` : '[Video]'
  if (m.audioMessage)              return m.audioMessage.ptt ? '[Voice note]' : '[Audio]'
  if (m.documentMessage)           return `[Document: ${m.documentMessage.fileName || 'file'}]`
  if (m.stickerMessage)            return '[Sticker]'
  if (m.contactMessage)            return `[Contact shared: ${m.contactMessage.displayName}]`
  if (m.locationMessage)           return '[Location]'
  if (m.pollCreationMessage)       return `[Poll: ${m.pollCreationMessage.name}]`
  if (m.ephemeralMessage)          return extractText({ message: m.ephemeralMessage.message })
  if (m.viewOnceMessage)           return '[View-once media]'
  if (m.viewOnceMessageV2)         return '[View-once media]'
  if (m.reactionMessage)           return null
  if (m.protocolMessage)           return null
  if (m.pollUpdateMessage)         return null
  return null
}

// ── Contact resolution ───────────────────────────────────────────────────────

function getContactName(jid) {
  const bare = jid.split('@')[0]
  const c = contacts[jid]
           || contacts[bare + '@s.whatsapp.net']
           || contacts[bare + '@c.us']
  return c?.notify || c?.name || c?.pushName || ('+' + bare)
}

function getSenderName(msg, isGroup) {
  if (msg.key?.fromMe) return SENDER_NAME
  if (isGroup && msg.key?.participant) {
    return msg.pushName || getContactName(msg.key.participant)
  }
  return msg.pushName || getContactName(msg.key?.remoteJid)
}

// ── JID-to-file index ────────────────────────────────────────────────────────

function buildFileIndex() {
  jidToFile.clear()
  if (!fs.existsSync(WA_INBOX)) return

  const phoneToFiles = new Map()

  for (const file of fs.readdirSync(WA_INBOX)) {
    if (!file.endsWith('.md')) continue
    const fullPath = path.join(WA_INBOX, file)
    let content
    try { content = fs.readFileSync(fullPath, 'utf8') } catch { continue }

    const jidMatch = content.match(/jid:\s*"?([^\s"]+)"?/)
    if (jidMatch) {
      jidToFile.set(jidMatch[1], fullPath)
      continue
    }

    const phoneMatch = content.match(/phone:\s*"?\+?(\d+)"?/)
    if (phoneMatch) {
      const phone = phoneMatch[1]
      const jid = phone + '@s.whatsapp.net'
      const countMatch = content.match(/message_count:\s*(\d+)/)
      const count = countMatch ? parseInt(countMatch[1]) : 0

      if (!phoneToFiles.has(phone)) phoneToFiles.set(phone, [])
      phoneToFiles.get(phone).push({ path: fullPath, count })
    }
  }

  for (const [phone, files] of phoneToFiles) {
    files.sort((a, b) => b.count - a.count)
    const jid = phone + '@s.whatsapp.net'
    if (!jidToFile.has(jid)) {
      jidToFile.set(jid, files[0].path)
    }
  }

  logger.info({ indexSize: jidToFile.size }, 'File index built')
}

function resolveFilePath(jid, displayName) {
  if (jidToFile.has(jid)) return jidToFile.get(jid)

  fs.mkdirSync(WA_INBOX, { recursive: true })
  const phone = jid.split('@')[0]
  const isGroup = isJidGroup(jid) || jid.includes('@broadcast')
  const today = todayStr()

  const frontmatter = [
    '---',
    `type: whatsapp-conversation`,
    `contact: "${displayName}"`,
    isGroup ? `jid: "${jid}"` : `phone: "+${phone}"`,
    `message_count: 0`,
    `first_message: ${today}`,
    `last_message: ${today}`,
    `last_sync: ${today}`,
    `status: pending`,
    '---',
    '',
    `# WhatsApp — ${displayName}`,
    '',
    '## Mensajes',
    '',
  ].join('\n')

  const filePath = path.join(WA_INBOX, sanitizeFilename(displayName) + '.md')
  fs.writeFileSync(filePath, frontmatter, 'utf8')
  jidToFile.set(jid, filePath)
  logger.info({ jid, file: path.basename(filePath) }, 'Created new conversation file')
  return filePath
}

// ── Append message to vault file ─────────────────────────────────────────────

function appendMessage(jid, senderName, text, timestamp) {
  const isGroup = isJidGroup(jid) || jid.includes('@broadcast')
  const displayName = isGroup
    ? (contacts[jid]?.name || contacts[jid]?.notify || jid.split('@')[0])
    : getContactName(jid)

  const filePath = resolveFilePath(jid, displayName)
  let content = fs.readFileSync(filePath, 'utf8')

  const date = formatDate(timestamp)
  const time = formatTime(timestamp)
  const line = `**${time}** ${senderName}: ${text}`

  const dateHeader = `### ${date}`
  if (content.includes(dateHeader)) {
    const headerIdx = content.indexOf(dateHeader)
    const nextHeaderIdx = content.indexOf('\n### ', headerIdx + dateHeader.length)
    if (nextHeaderIdx === -1) {
      content = content.trimEnd() + '\n' + line + '\n'
    } else {
      content = content.slice(0, nextHeaderIdx).trimEnd() + '\n' + line + '\n' + content.slice(nextHeaderIdx)
    }
  } else {
    content = content.trimEnd() + '\n\n' + dateHeader + '\n\n' + line + '\n'
  }

  // Update frontmatter counters
  content = content.replace(/message_count:\s*\d+/, (m) => {
    const old = parseInt(m.split(':')[1])
    return `message_count: ${old + 1}`
  })
  content = content.replace(/last_message:\s*\S+/, `last_message: ${date}`)
  content = content.replace(/last_sync:\s*\S+/, `last_sync: ${todayStr()}`)

  fs.writeFileSync(filePath, content, 'utf8')
}

// ── Dedup tracking ───────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      processedIds = new Map(Object.entries(raw.processedIds || {}))
      return
    } catch { /* corrupt — start fresh */ }
  }
  processedIds = new Map()
}

function saveState() {
  const obj = {}
  for (const [jid, ids] of processedIds) {
    obj[jid] = ids.slice(-200)
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    processedIds: obj,
    startedAt,
    lastMessageAt,
  }), 'utf8')
}

function isProcessed(jid, msgId) {
  const ids = processedIds.get(jid)
  return ids ? ids.includes(msgId) : false
}

function markProcessed(jid, msgId) {
  if (!processedIds.has(jid)) processedIds.set(jid, [])
  const ids = processedIds.get(jid)
  ids.push(msgId)
  if (ids.length > 200) ids.splice(0, ids.length - 200)
}

// ── Persistent messageStore ──────────────────────────────────────────────────
// Baileys' getMessage callback is invoked by WhatsApp when the user's phone
// (or any other companion device) requests a re-send of a message it could
// not decrypt. If we cannot return the original message, the phone is stuck
// on "processing" forever. Persisting the store across restarts is required
// for sender-side sync to survive daemon disconnects.
//
// Buffer fields (e.g. media keys, encrypted payloads) are base64-encoded
// under {__b: '...'} so JSON round-trips losslessly.

function encodeBuffers(value) {
  if (Buffer.isBuffer(value)) return { __b: value.toString('base64') }
  if (value instanceof Uint8Array) return { __b: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(encodeBuffers)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = encodeBuffers(value[k])
    return out
  }
  return value
}

function decodeBuffers(value) {
  if (value && typeof value === 'object') {
    if (typeof value.__b === 'string') return Buffer.from(value.__b, 'base64')
    if (Array.isArray(value)) return value.map(decodeBuffers)
    const out = {}
    for (const k of Object.keys(value)) out[k] = decodeBuffers(value[k])
    return out
  }
  return value
}

function loadMessageStore() {
  if (!fs.existsSync(MSGSTORE_FILE)) return
  try {
    const raw = JSON.parse(fs.readFileSync(MSGSTORE_FILE, 'utf8'))
    let loaded = 0
    for (const [id, msg] of Object.entries(raw)) {
      messageStore.set(id, decodeBuffers(msg))
      loaded++
    }
    logger.info({ loaded }, 'Loaded persistent messageStore (enables getMessage retry across restarts)')
  } catch (err) {
    logger.warn({ err: err.message }, 'messageStore corrupt; starting fresh')
    messageStore = new Map()
  }
}

let _saveMessageStoreInFlight = false
function saveMessageStore() {
  if (_saveMessageStoreInFlight) return
  _saveMessageStoreInFlight = true
  try {
    const obj = {}
    const entries = Array.from(messageStore.entries())
    const keep = entries.slice(-MESSAGE_STORE_MAX)
    for (const [k, v] of keep) obj[k] = encodeBuffers(v)
    const tmp = MSGSTORE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
    fs.renameSync(tmp, MSGSTORE_FILE) // atomic on POSIX
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to save messageStore')
  } finally {
    _saveMessageStoreInFlight = false
  }
}

function rememberMessage(key, message) {
  if (!key?.id || !message) return
  messageStore.set(key.id, message)
  if (messageStore.size > MESSAGE_STORE_MAX) {
    const oldest = messageStore.keys().next().value
    messageStore.delete(oldest)
  }
}

// ── Lock file ────────────────────────────────────────────────────────────────

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    try {
      process.kill(parseInt(pid), 0)
      logger.fatal({ pid }, 'Another daemon is running')
      process.exit(1)
    } catch {
      logger.warn({ stalePid: pid }, 'Removing stale lock file')
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid))
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE) } catch {}
}

// ── Contact search (for IPC send) ───────────────────────────────────────────
//
// Recognizes both individuals (phone <17 digits → @s.whatsapp.net) and groups
// (jid: field or phone field ≥17 digits → @g.us). See mcp-server.mjs for the
// same convention; kept duplicated here so the daemon doesn't depend on the
// MCP layer.

const GROUP_ID_MIN_DIGITS = 17

function _kindFromDigits(digits) {
  return digits.length >= GROUP_ID_MIN_DIGITS ? 'group' : 'individual'
}

function _toJid(idOrPhone, kind) {
  if (kind === 'group' || idOrPhone.length >= GROUP_ID_MIN_DIGITS) {
    return idOrPhone + '@g.us'
  }
  return idOrPhone + '@s.whatsapp.net'
}

function searchContacts(query) {
  const results = []
  const q = query.toLowerCase()

  if (fs.existsSync(WA_INBOX)) {
    for (const file of fs.readdirSync(WA_INBOX)) {
      if (!file.endsWith('.md')) continue
      const name = file.replace('.md', '').replace(/ \(\d+\)$/, '')
      if (!name.toLowerCase().includes(q)) continue
      const content = fs.readFileSync(path.join(WA_INBOX, file), 'utf8')

      const jidMatch = content.match(/jid:\s*"?([^\s"]+)"?/)
      if (jidMatch) {
        const raw = jidMatch[1]
        const fullJid = raw.includes('@') ? raw : raw + '@g.us'
        const kind = fullJid.endsWith('@g.us') ? 'group' : 'individual'
        results.push({ name, jid: fullJid, kind })
        continue
      }

      const phoneMatch = content.match(/phone:\s*"?\+?(\d+)"?/)
      if (phoneMatch) {
        const digits = phoneMatch[1]
        const kind = _kindFromDigits(digits)
        const entry = { name, jid: _toJid(digits, kind), kind }
        if (kind === 'individual') entry.phone = digits
        results.push(entry)
      }
    }
  }

  // Also fold in raw Baileys contact-store entries (live names from WhatsApp)
  for (const [jid, c] of Object.entries(contacts)) {
    const name = c.name || c.notify || ''
    if (name.toLowerCase().includes(q)) {
      if (!results.find(r => r.jid === jid)) {
        const kind = jid.endsWith('@g.us') ? 'group' : 'individual'
        const entry = { name, jid, kind }
        if (kind === 'individual') entry.phone = jid.split('@')[0]
        results.push(entry)
      }
    }
  }

  return results
}

function resolveContact(nameOrPhone) {
  const raw = String(nameOrPhone || '').trim()
  if (!raw) return null

  // Explicit JID
  if (/@(s\.whatsapp\.net|g\.us|lid|broadcast)$/.test(raw)) {
    return {
      jid: raw,
      displayName: raw.split('@')[0],
      kind: raw.endsWith('@g.us') ? 'group' : 'individual',
    }
  }

  // All-digits: distinguish phone vs group ID by length
  const clean = raw.replace(/[+\-\s]/g, '')
  if (/^\d{7,}$/.test(clean)) {
    const kind = _kindFromDigits(clean)
    return {
      jid: _toJid(clean, kind),
      displayName: kind === 'group' ? 'Group ' + clean : '+' + clean,
      kind,
    }
  }

  const results = searchContacts(raw)
  if (results.length === 0) return null
  return { jid: results[0].jid, displayName: results[0].name, kind: results[0].kind }
}

// ── Unix socket IPC server ───────────────────────────────────────────────────

function startIPC() {
  try { fs.unlinkSync(SOCKET_PATH) } catch {}

  const server = net.createServer((conn) => {
    let buffer = ''
    conn.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        handleIPCCommand(line.trim(), conn)
      }
    })
  })

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, '600')
    logger.info({ socket: SOCKET_PATH }, 'IPC server listening')
  })

  server.on('error', (err) => {
    logger.error({ err }, 'IPC server error')
  })

  return server
}

async function handleIPCCommand(raw, conn) {
  let cmd
  try { cmd = JSON.parse(raw) } catch {
    conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n')
    return
  }

  if (cmd.cmd === 'status') {
    conn.write(JSON.stringify({
      ok: true,
      connected,
      uptime: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
      lastMessageAt,
      indexSize: jidToFile.size,
      contactCount: Object.keys(contacts).length,
    }) + '\n')
    return
  }

  if (cmd.cmd === 'send') {
    if (!sock || !connected) {
      conn.write(JSON.stringify({ ok: false, error: 'WhatsApp not connected' }) + '\n')
      return
    }
    const resolved = cmd.jid
      ? {
          jid: cmd.jid,
          displayName: cmd.jid,
          kind: cmd.jid.endsWith('@g.us') ? 'group' : 'individual',
        }
      : resolveContact(cmd.to)
    if (!resolved) {
      conn.write(JSON.stringify({ ok: false, error: `Contact or group "${cmd.to}" not found` }) + '\n')
      return
    }
    try {
      const sentMsg = await sock.sendMessage(resolved.jid, { text: cmd.text })
      // Persist immediately AND save to disk so the next daemon restart can
      // still answer getMessage callbacks for this msgId. Without this, the
      // recipient (or our own phone) gets stuck on "processing" if the
      // daemon disconnects between send and the phone's retry request.
      if (sentMsg?.key?.id && sentMsg.message) {
        rememberMessage(sentMsg.key, sentMsg.message)
        saveMessageStore()
      }
      // Persist outbound message to local inbox so reads reflect what we sent
      try {
        const ts = Math.floor(Date.now() / 1000)
        appendMessage(resolved.jid, SENDER_NAME, cmd.text, ts)
        lastMessageAt = new Date().toISOString()
        logger.info({
          jid: resolved.jid.split('@')[0],
          msgId: sentMsg?.key?.id,
          preview: cmd.text.slice(0, 50),
        }, 'Outbound message sent + persisted')
        saveState()
      } catch (appendErr) {
        logger.error({ err: appendErr, jid: resolved.jid }, 'Failed to append outbound message')
      }
      conn.write(JSON.stringify({ ok: true, jid: resolved.jid, displayName: resolved.displayName, kind: resolved.kind, msgId: sentMsg?.key?.id }) + '\n')
    } catch (err) {
      conn.write(JSON.stringify({ ok: false, error: err.message }) + '\n')
    }
    return
  }

  if (cmd.cmd === 'search') {
    const results = searchContacts(cmd.query || '')
    conn.write(JSON.stringify({ ok: true, results }) + '\n')
    return
  }

  conn.write(JSON.stringify({ ok: false, error: `Unknown command: ${cmd.cmd}` }) + '\n')
}

// ── Baileys connection ───────────────────────────────────────────────────────

async function connect() {
  if (!fs.existsSync(AUTH_DIR)) {
    logger.fatal('No baileys_auth/ found. Run sync.mjs first.')
    process.exit(1)
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  // Only load contacts from store (skip messages — too large)
  if (fs.existsSync(STORE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
      contacts = raw.contacts || {}
      logger.info({ contactCount: Object.keys(contacts).length }, 'Loaded contacts from store')
    } catch { /* ignore */ }
  }

  const baileysLogger = pino({ level: 'warn' })

  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ['WhatsApp Vault Daemon', 'Desktop', '1.0.0'],
    // Lower keepAlive than the 30s default. WhatsApp's server-side timeout
    // is ~30s; pinging at 10s gives 3 chances before a 408 disconnect.
    keepAliveIntervalMs: KEEPALIVE_INTERVAL_MS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    defaultQueryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    // Critical for sender-side sync: when the user's phone (or another
    // companion device) cannot decrypt a message we sent, WhatsApp calls
    // back here for the original. messageStore is now persisted to disk
    // so this survives daemon restarts. Returning undefined here leaves
    // the phone stuck on "processing" forever — defensive logging below.
    getMessage: async (key) => {
      const msg = messageStore.get(key?.id)
      if (msg) {
        logger.debug({ msgId: key.id }, 'getMessage hit (served from persistent store)')
        return msg
      }
      logger.warn({ msgId: key?.id, remoteJid: key?.remoteJid }, 'getMessage MISS — recipient device may stay on "processing"')
      return undefined
    },
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('contacts.set', ({ contacts: newContacts }) => {
    for (const c of newContacts || []) {
      if (c.id) contacts[c.id] = { ...contacts[c.id], ...c }
    }
  })
  sock.ev.on('contacts.upsert', (newContacts) => {
    for (const c of newContacts || []) {
      if (c.id) contacts[c.id] = { ...contacts[c.id], ...c }
    }
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      rememberMessage(msg.key, msg.message)

      const jid = msg.key?.remoteJid
      if (!jid) continue
      if (isJidStatusBroadcast(jid)) continue
      if (typeof isJidNewsletter === 'function' && isJidNewsletter(jid)) continue

      const msgId = msg.key?.id
      if (!msgId || isProcessed(jid, msgId)) continue

      const text = extractText(msg)
      if (!text) continue

      const isGroup = isJidGroup(jid) || jid.includes('@broadcast')
      const senderName = getSenderName(msg, isGroup)
      const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)

      try {
        appendMessage(jid, senderName, text, ts)
        markProcessed(jid, msgId)
        lastMessageAt = new Date().toISOString()

        logger.info({
          jid: jid.split('@')[0],
          from: senderName,
          type,
          preview: text.slice(0, 50),
        }, 'Message appended')
      } catch (err) {
        logger.error({ err, jid, msgId }, 'Failed to append message')
      }
    }

    saveState()
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connected = true
      reconnectDelay = 3000
      logger.info('Connected to WhatsApp')
    }

    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        logger.fatal('Logged out by WhatsApp. Re-authenticate with sync.mjs.')
        releaseLock()
        process.exit(2)
      }

      logger.warn({ code, reconnectIn: reconnectDelay }, 'Connection closed, reconnecting...')
      setTimeout(() => {
        connect().catch((err) => {
          logger.error({ err }, 'Reconnect failed')
          reconnectDelay = Math.min(reconnectDelay * 2, 60000)
          setTimeout(() => connect().catch(() => {}), reconnectDelay)
        })
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 60000)
    }
  })
}

// ── Periodic tasks ───────────────────────────────────────────────────────────

function startPeriodicTasks() {
  // Rebuild file index every 5 minutes
  setInterval(() => {
    buildFileIndex()
  }, 5 * 60 * 1000)

  // Save state every minute
  setInterval(() => {
    saveState()
  }, 60 * 1000)

  // Persist messageStore to disk every 30s. This is what makes getMessage
  // retries work across daemon restarts (the actual root-cause fix for
  // "messages stuck on processing on sender side").
  setInterval(() => {
    saveMessageStore()
  }, MSGSTORE_SAVE_INTERVAL_MS)

  // Heartbeat: touch a file periodically. An external watchdog can detect
  // a hung (vs dead) daemon by mtime staleness, since launchd's KeepAlive
  // doesn't catch processes that are alive-but-frozen.
  setInterval(() => {
    try {
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        connected,
        lastMessageAt,
        messageStoreSize: messageStore.size,
        indexSize: jidToFile.size,
      }))
    } catch { /* best-effort */ }
  }, HEARTBEAT_INTERVAL_MS)

  // Rotate log if > 10MB
  setInterval(() => {
    const logPath = path.join(__dir, 'logs', 'daemon.log')
    try {
      const stat = fs.statSync(logPath)
      if (stat.size > 10 * 1024 * 1024) {
        const rotated = logPath + '.1'
        try { fs.unlinkSync(rotated) } catch {}
        fs.renameSync(logPath, rotated)
        logger.info('Log rotated')
      }
    } catch {}
  }, 60 * 60 * 1000)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  acquireLock()
  loadState()
  loadMessageStore()
  buildFileIndex()

  const ipcServer = startIPC()
  startPeriodicTasks()

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down...')
    saveState()
    saveMessageStore()
    releaseLock()
    ipcServer.close()
    try { fs.unlinkSync(SOCKET_PATH) } catch {}
    process.exit(0)
  })

  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down...')
    saveState()
    saveMessageStore()
    releaseLock()
    ipcServer.close()
    try { fs.unlinkSync(SOCKET_PATH) } catch {}
    process.exit(0)
  })

  await connect()
  logger.info({ pid: process.pid }, 'Daemon started')
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error')
  releaseLock()
  process.exit(1)
})
