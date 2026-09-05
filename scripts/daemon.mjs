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
// Optional suffix appended to conversation filenames, e.g. " (WhatsApp)".
// Empty by default so existing installs are untouched. Set it in the daemon
// plist to disambiguate WhatsApp files from other notes in a shared vault.
// The read-back below strips it, so contact lookup works either way.
const INBOX_SUFFIX = process.env.WA_INBOX_SUFFIX || ''
// Every file this process creates is private to this user. Baileys rewrites
// the Signal key files every few minutes via plain writeFile with no mode, so
// they were born 0644 and a reactive chmod could never win the race: on
// 2026-09-05 a chmod of 145 key files was undone within minutes. umask is the
// only fix that holds, because it constrains a writer we do not control.
process.umask(0o077)

const AUTH_DIR = path.join(__dir, 'baileys_auth')
const STORE_FILE = path.join(__dir, 'baileys_store.json')
const STATE_FILE = path.join(__dir, '.daemon_state.json')
const LOCK_FILE = path.join(__dir, '.daemon.lock')
// The socket accepts `send` with no authentication, so its directory is the
// only access control there is. /tmp is mode 1777 — every user and every
// process on the machine can reach a socket there. A private run directory
// under the connector is the containment boundary.
const RUN_DIR = path.join(__dir, '.run')
const SOCKET_PATH = process.env.WA_SOCKET_PATH || path.join(RUN_DIR, 'daemon.sock')
const LEGACY_SOCKET_PATH = '/tmp/whatsapp-daemon.sock'
const MSGSTORE_FILE = path.join(__dir, '.message_store.json')
const HEARTBEAT_FILE = path.join(__dir, '.daemon_heartbeat')

// Tunables. Lower keepAlive than Baileys default (30s) reduces 408 timeouts
// because WhatsApp's server-side timeout is ~30s; missing one ping is fatal.
const KEEPALIVE_INTERVAL_MS = 10_000
const CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_QUERY_TIMEOUT_MS = 60_000
const SEND_ACK_TIMEOUT_MS = 15_000
const MSGSTORE_SAVE_INTERVAL_MS = 30_000
// Heartbeat at 10s (down from 30s) gives the watchdog tighter granularity to
// distinguish "main loop momentarily saturated" from "main loop genuinely
// stuck." Async write (vs sync) prevents the heartbeat itself from contributing
// to event-loop pressure during heavy history-sync processing.
const HEARTBEAT_INTERVAL_MS = 10_000

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
// Capacity raised 2026-05-31 from 5,000 → 50,000. Previous cap was tight enough
// that retries for messages older than ~24h could MISS, leaving the recipient
// stuck on "waiting for this message" forever. On-disk cost scales linearly
// (~10MB at 5K → ~100MB at 50K), well within budget for any modern machine.
const MESSAGE_STORE_MAX = 50000
let startedAt = new Date().toISOString()
let reconnectDelay = 3000
let connecting = false          // single-flight guard for connect()
let contactsLoaded = false      // contact store is ~316 MB; parse it once
let reconnectScheduled = false  // exactly one pending reconnect timer
let disconnectedSince = null

// Disconnect codes worth acting on differently. Deliberately SHORT: a full
// code->action table was tested against this vault's own history and refuted —
// July 2026 was a healthy month (18,900 messages) and still produced 337
// `500 badSession` closes. Treating 500 as "session invalid" and giving up
// would have killed a working connector hundreds of times. So we classify and
// log everything, but only two codes change behaviour.
const DISCONNECT_ACTIONS = {
  515: { klass: 'EXPECTED',  delayMs: 0,      note: 'restartRequired after pairing — reconnect at once' },
  440: { klass: 'CONFLICT',  delayMs: 120000, note: 'connectionReplaced — another device took the slot; back off' },
}

// ── Inbound/outbound signal separation ───────────────────────────────────────
// Added 2026-09-05 after a 28-day outage in which reception was completely
// dead while the daemon reported connected=true the whole time.
//
// The old `lastMessageAt` was written from BOTH the IPC send path and the
// message-ingest path. Because this vault also sends itself scheduled
// reminders, that single field stayed fresh for 28 days of total deafness —
// the alert channel was feeding the blindness. It is deliberately deleted
// rather than reinterpreted: while it exists, someone will use it again.
//
// `lastInboundRealAt` moves ONLY for a message from a third party. Echoes of
// our own phone (fromMe) and our own number are tracked separately: they
// prove the phone<->companion link is alive, but they are NOT evidence that
// anyone reached us.
let lastInboundRealAt = null   // third-party message actually written to vault
let lastOwnEchoAt = null       // echo of a message sent from the user's phone
let lastOutboundAt = null      // message we sent via IPC
let ownJidBare = null          // our own number, resolved on connect
// When the inbound signal first started collecting. The 24h counters are only
// trustworthy once a full window has actually been observed; without this a
// fresh deploy looks identical to a dead connector (zero traffic recorded)
// and would raise a false alarm on its first quiet night. Persisted, so it
// survives the frequent watchdog restarts.
let signalSince = null
const inboundRing = []         // [{ts, jid}] real inbound, pruned to 24h
const decryptFailRing = []     // [{ts, jid, reason}] Signal failures, pruned to 24h
const RING_WINDOW_MS = 24 * 60 * 60 * 1000

// Bare number/id of a jid: "15551234567@s.whatsapp.net" -> "15551234567"
function jidBare(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

// Record a Signal decryption failure. This is the EARLIEST possible signal of
// session drift — it fires within minutes, where inbound silence takes hours.
function pushDecryptFail(jid, reason) {
  decryptFailRing.push({ ts: Date.now(), jid: jidBare(jid), reason: String(reason || 'unknown') })
}

// Prune both rings. Called from the heartbeat tick (every 10s), never from the
// messages.upsert hot path — that handler already rewrites the conversation
// file and serialises the message store, and extra work there would push the
// event loop past the watchdog's staleness threshold. The observer must not
// degrade the observed.
function pruneRings() {
  const cutoff = Date.now() - RING_WINDOW_MS
  while (inboundRing.length && inboundRing[0].ts < cutoff) inboundRing.shift()
  while (decryptFailRing.length && decryptFailRing[0].ts < cutoff) decryptFailRing.shift()
}

function countSince(ring, ms) {
  const cutoff = Date.now() - ms
  let n = 0
  for (let i = ring.length - 1; i >= 0 && ring[i].ts >= cutoff; i--) n++
  return n
}

// Health snapshot shared by the heartbeat file and the IPC status response, so
// both surfaces can never disagree about what "healthy" means.
function inboundHealth() {
  return {
    lastInboundRealAt,
    lastOwnEchoAt,
    lastOutboundAt,
    inboundReal1h: countSince(inboundRing, 60 * 60 * 1000),
    inboundReal24h: inboundRing.length,
    inboundRealJids24h: new Set(inboundRing.map(e => e.jid)).size,
    decryptFail1h: countSince(decryptFailRing, 60 * 60 * 1000),
    decryptFail24h: decryptFailRing.length,
    daemonStartedAt: startedAt,
    disconnectedSince,
    signalSince,
    signalWindowComplete: Boolean(signalSince && (Date.now() - new Date(signalSince).getTime()) >= RING_WINDOW_MS),
  }
}

// Recover the display name from a conversation filename, tolerating both the
// configured suffix and the legacy " (2)" disambiguation counter.
function stripInboxSuffix(file) {
  let name = file.replace(/\.md$/, '')
  if (INBOX_SUFFIX && name.endsWith(INBOX_SUFFIX)) name = name.slice(0, -INBOX_SUFFIX.length)
  return name.replace(/ \(WhatsApp\)$/, '').replace(/ \(\d+\)$/, '')
}

// ── Explicit daemon state machine ────────────────────────────────────────────
// Added 2026-05-31 after observing that under recurring session drift the
// daemon happily accepted IPC sends that would silently end up in "waiting
// for this message" on the user's phone. With explicit DRIFT_DETECTED, the
// daemon now refuses sends with a clear error pointing to `wa-fix repair`
// instead of leaving messages in undefined-behaviour limbo.
//
// States:
//   STARTING       — process boot, before first connection.update
//   CONNECTED      — handshake OK, sends allowed
//   RECONNECTING   — socket closed, waiting on backoff
//   DRIFT_DETECTED — >N reconnects in window with no successful sends; sends rejected
const DAEMON_STATE = {
  STARTING: 'STARTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  DRIFT_DETECTED: 'DRIFT_DETECTED',
}
let daemonState = DAEMON_STATE.STARTING

// Drift detection: rolling timestamps of recent reconnects and successful sends.
// If reconnects >= DRIFT_RECONNECT_THRESHOLD within DRIFT_WINDOW_MS AND no send
// has succeeded in the same window, the daemon is almost certainly drift-stuck —
// it can connect but encrypted payloads aren't decoding on the peer side.
const DRIFT_WINDOW_MS = 5 * 60 * 1000  // 5 minutes
const DRIFT_RECONNECT_THRESHOLD = 4
const recentReconnects = []  // array of unix ms timestamps
const recentSuccessfulSends = []  // array of unix ms timestamps

function _trimWindow(arr, now) {
  const cutoff = now - DRIFT_WINDOW_MS
  while (arr.length > 0 && arr[0] < cutoff) arr.shift()
}

function _recomputeDaemonState(reason) {
  const prev = daemonState
  const now = Date.now()
  _trimWindow(recentReconnects, now)
  _trimWindow(recentSuccessfulSends, now)

  let next = daemonState
  if (!connected) {
    next = DAEMON_STATE.RECONNECTING
  } else {
    // Connected. Drift only flags when we've reconnected a lot AND haven't
    // managed to actually send anything successfully through the new sessions.
    if (recentReconnects.length >= DRIFT_RECONNECT_THRESHOLD &&
        recentSuccessfulSends.length === 0) {
      next = DAEMON_STATE.DRIFT_DETECTED
    } else {
      next = DAEMON_STATE.CONNECTED
    }
  }

  if (next !== prev) {
    daemonState = next
    logger.warn({
      from: prev, to: next, reason,
      reconnectsInWindow: recentReconnects.length,
      successfulSendsInWindow: recentSuccessfulSends.length,
    }, 'Daemon state transition')
  }
}

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

  let filePath = path.join(WA_INBOX, sanitizeFilename(displayName) + INBOX_SUFFIX + '.md')

  // NEVER clobber an existing conversation. Reaching here means the index has
  // no entry for this jid — but a file can exist at the computed path anyway if
  // its frontmatter was unreadable, was written by an older version, or came
  // from a history export that recorded the id differently. Blindly writing the
  // empty frontmatter over it would silently destroy months of conversation.
  // Adopt the file if it turns out to be the same conversation; otherwise step
  // aside to a suffixed name and let the human reconcile.
  if (fs.existsSync(filePath)) {
    try {
      const head = fs.readFileSync(filePath, 'utf8').slice(0, 600)
      const known = head.match(/jid:\s*"?([^\s"]+)"?/)?.[1]
        || (head.match(/phone:\s*"?\+?(\d+)"?/)?.[1] ?? null)
      if (known && (known === jid || known === phone)) {
        logger.info({ jid, file: path.basename(filePath) }, 'Adopted existing conversation file')
        jidToFile.set(jid, filePath)
        return filePath
      }
    } catch { /* unreadable — fall through to the safe rename below */ }
    let n = 2
    while (fs.existsSync(path.join(WA_INBOX, sanitizeFilename(displayName) + INBOX_SUFFIX + ` (${n})` + '.md'))) n++
    filePath = path.join(WA_INBOX, sanitizeFilename(displayName) + INBOX_SUFFIX + ` (${n})` + '.md')
    logger.warn({ jid, file: path.basename(filePath) },
                'Name collision with a different conversation; wrote to a new file instead of overwriting')
  }

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

  // Atomic: write a sibling temp file, then rename. A conversation file can be
  // megabytes, and the watchdog may SIGKILL this process at any moment — a
  // partial write would truncate months of a real conversation with no backup.
  // rename(2) within the same directory is atomic, so a reader sees either the
  // old file or the complete new one.
  const tmpPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

// ── Dedup tracking ───────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      processedIds = new Map(Object.entries(raw.processedIds || {}))
      // Restore the inbound signal across restarts. Without this the silence
      // clock resets every time the watchdog kickstarts the daemon, and a
      // detector with an 18h threshold could never reach 18h.
      signalSince = raw.signalSince || null
      lastInboundRealAt = raw.lastInboundRealAt || null
      lastOwnEchoAt = raw.lastOwnEchoAt || null
      lastOutboundAt = raw.lastOutboundAt || null
      const cutoff = Date.now() - RING_WINDOW_MS
      for (const e of raw.inboundRing || []) if (e && e.ts > cutoff) inboundRing.push(e)
      for (const e of raw.decryptFailRing || []) if (e && e.ts > cutoff) decryptFailRing.push(e)
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
    signalSince,
    lastInboundRealAt,
    lastOwnEchoAt,
    lastOutboundAt,
    inboundRing,
    decryptFailRing,
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
      const name = stripInboxSuffix(file)
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
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(RUN_DIR, 0o700) } catch {}
  try { fs.unlinkSync(SOCKET_PATH) } catch {}
  // Remove any socket left behind at the old world-reachable location so no
  // client keeps talking to a stale endpoint.
  try { fs.unlinkSync(LEGACY_SOCKET_PATH) } catch {}

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
    // chmod after bind leaves a window in which the socket exists with looser
    // permissions. umask closes it: the socket is never briefly world-usable.
    try { fs.chmodSync(SOCKET_PATH, 0o600) } catch {}
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
      state: daemonState,
      reconnectsInWindow: recentReconnects.length,
      successfulSendsInWindow: recentSuccessfulSends.length,
      uptime: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
      ...inboundHealth(),
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
    // Block sends when drift is detected: the underlying Signal sessions are
    // out of sync with the peer, and any message we transmit will silently
    // end up as "waiting for this message" on the recipient. Refuse loudly
    // instead so the caller can either back off or trigger a re-pair.
    if (daemonState === DAEMON_STATE.DRIFT_DETECTED) {
      conn.write(JSON.stringify({
        ok: false,
        error: 'Daemon in DRIFT_DETECTED state. Sends would silently fail on the recipient. ' +
               'Run `python3 wa-fix.py repair` to re-pair and reset Signal sessions.',
        state: daemonState,
      }) + '\n')
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
      // Record the successful send so the daemon can leave DRIFT_DETECTED when
      // conditions recover. NOTE: a successful send does NOT prove reception
      // works. Outbound succeeded every single day of the 28-day Aug-2026
      // deafness; only `lastInboundRealAt` speaks to reception.
      recentSuccessfulSends.push(Date.now())
      _recomputeDaemonState('send.success')
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
        lastOutboundAt = new Date().toISOString()
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

  if (cmd.cmd === 'list_groups_live') {
    // Ask Baileys for the canonical list of all groups the user is in.
    // Useful when a group hasn't yet shown up in the vault (no incoming
    // message has triggered file creation) but we still need to address it.
    if (!sock || !connected) {
      conn.write(JSON.stringify({ ok: false, error: 'WhatsApp not connected' }) + '\n')
      return
    }
    try {
      const meta = await sock.groupFetchAllParticipating()
      const q = (cmd.query || '').toLowerCase()
      const groups = []
      for (const [jid, g] of Object.entries(meta || {})) {
        const subject = g.subject || ''
        if (q && !subject.toLowerCase().includes(q)) continue
        groups.push({
          name: subject,
          jid,
          kind: 'group',
          size: (g.participants || []).length,
        })
      }
      groups.sort((a, b) => a.name.localeCompare(b.name))
      conn.write(JSON.stringify({ ok: true, groups, total: groups.length }) + '\n')
    } catch (err) {
      conn.write(JSON.stringify({ ok: false, error: err.message }) + '\n')
    }
    return
  }

  conn.write(JSON.stringify({ ok: false, error: `Unknown command: ${cmd.cmd}` }) + '\n')
}

// ── Baileys connection ───────────────────────────────────────────────────────

// Schedule exactly one reconnect. Every path that wants to retry goes through
// here, so a burst of `close` events cannot start overlapping chains — two
// concurrent connect() calls would have two sockets writing the same
// baileys_auth/ directory, which is one way session state drifts.
function scheduleReconnect(delayMs, reason) {
  if (reconnectScheduled || connecting) return
  reconnectScheduled = true
  const jittered = Math.max(0, Math.round(delayMs * (1 + (Math.random() - 0.5) * 0.5)))
  logger.warn({ reason, reconnectIn: jittered }, 'Reconnect scheduled')
  setTimeout(() => {
    reconnectScheduled = false
    connect().catch((err) => {
      // This catch is the difference between a connector that recovers and one
      // that dies silently. The previous code retried once and then swallowed
      // the error, so after two consecutive failures the chain ended forever
      // while the process stayed alive and the heartbeat stayed fresh — the
      // watchdog, the doctor and `ps` would all still call it healthy.
      reconnectDelay = Math.min(reconnectDelay * 2, 60000)
      logger.error({ err, nextDelay: reconnectDelay }, 'Reconnect failed; rescheduling')
      scheduleReconnect(reconnectDelay, 'retry-after-failure')
    })
  }, jittered)
}

async function connect() {
  if (connecting) { logger.warn('connect() re-entered; ignoring'); return }
  connecting = true
  try {
    return await _connect()
  } finally {
    connecting = false
  }
}

async function _connect() {
  // Tear down any previous socket before building a new one. Without this the
  // old socket keeps its listeners and keeps emitting, inflating the reconnect
  // counter that DRIFT_DETECTED is computed from.
  if (sock) {
    try { sock.ev.removeAllListeners() } catch {}
    try { sock.end(undefined) } catch {}
  }
  if (!fs.existsSync(AUTH_DIR)) {
    logger.fatal('No baileys_auth/ found. Run sync.mjs first.')
    process.exit(1)
  }

  // Create the directory ourselves with an explicit mode; Baileys would create
  // it with whatever the ambient umask allows.
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  // Load contacts ONCE, not on every reconnect. This file is ~316 MB; parsing
  // it on each reconnect blocked the event loop long enough for the watchdog to
  // see a stale heartbeat and kill the daemon — a reconnect storm could feed
  // itself. A failure to parse is logged, not swallowed: an unreadable contact
  // store means every send resolves by number instead of name.
  if (!contactsLoaded && fs.existsSync(STORE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
      contacts = raw.contacts || {}
      contactsLoaded = true
      logger.info({ contactCount: Object.keys(contacts).length }, 'Loaded contacts from store')
    } catch (err) {
      logger.error({ err, store: STORE_FILE }, 'Could not parse contact store; name resolution degraded')
    }
  }

  const baileysLogger = pino({ level: 'warn' })

  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Identify as a Chrome web session, NOT "Desktop". This puts the daemon
    // in a different companion-device slot than the user's WhatsApp Desktop
    // app (Mac/Windows), so both can coexist without WhatsApp evicting the
    // older one. Eviction was the root cause of the 27-may 8:59-9:34 outage
    // (6 disconnects in 4 minutes when Danny opened WhatsApp on Mac).
    browser: ['Vault Daemon', 'Chrome', '120.0.0'],
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

  // Shared message-processing pipeline. Called from BOTH messages.upsert
  // (live, in-band messages) AND messaging-history.set (post-reconnect bulk
  // dump that fills any gap caused by daemon downtime, network drop, or
  // companion-device eviction).
  //
  // Dedup via processedIds guarantees the same msgId is never appended twice,
  // so calling this from multiple event sources is safe.
  //
  // Returns the number of messages actually appended (used for logging the
  // "recovered N messages after reconnect" metric).
  function processMessages(messages, source) {
    let appended = 0
    for (const msg of messages || []) {
      rememberMessage(msg.key, msg.message)

      const jid = msg.key?.remoteJid
      if (!jid) continue
      if (isJidStatusBroadcast(jid)) continue
      if (typeof isJidNewsletter === 'function' && isJidNewsletter(jid)) continue

      const msgId = msg.key?.id
      if (!msgId || isProcessed(jid, msgId)) continue

      // Signal decryption failure. Baileys surfaces these as a CIPHERTEXT stub
      // (messageStubType === 2) on the normal upsert path, carrying the jid and
      // the literal reason. This is the earliest available drift signal: during
      // the Aug-2026 outage it would have fired within the first hour, where
      // inbound silence needs 18h to become conclusive. The old code discarded
      // it one line below, at `if (!text) continue`.
      if (msg.messageStubType === 2) {
        pushDecryptFail(jid, msg.messageStubParameters?.[0] ?? 'unknown')
      }

      const text = extractText(msg)
      if (!text) continue

      const isGroup = isJidGroup(jid) || jid.includes('@broadcast')
      const senderName = getSenderName(msg, isGroup)
      const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)

      try {
        appendMessage(jid, senderName, text, ts)
        markProcessed(jid, msgId)
        // Which lane does this belong to? A message counts as real inbound only
        // if it fails all three ownership tests. Getting this wrong is exactly
        // how the old signal stayed green through a 28-day outage: this vault
        // sends itself scheduled reminders, and they land in the inbox under
        // the user's own push name — not as "Me".
        const isOwn = Boolean(msg.key?.fromMe)
          || (ownJidBare && jidBare(jid) === ownJidBare)
          || senderName === SENDER_NAME
        if (isOwn) {
          lastOwnEchoAt = new Date().toISOString()
        } else {
          lastInboundRealAt = new Date().toISOString()
          inboundRing.push({ ts: Date.now(), jid: jidBare(jid) })
        }
        appended++

        logger.info({
          jid: jid.split('@')[0],
          from: senderName,
          source,
          preview: text.slice(0, 50),
        }, 'Message appended')
      } catch (err) {
        logger.error({ err, jid, msgId, source }, 'Failed to append message')
      }
    }
    return appended
  }

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    processMessages(messages, `upsert:${type}`)
    saveState()
    // Persist messageStore at the end of every inbound batch (instead of
    // waiting up to 30s for the periodic flush). If the daemon dies between
    // a message arriving and the next periodic flush, the recipient of any
    // subsequent retry-request hits getMessage MISS and stays in "waiting".
    // _saveMessageStoreInFlight guards against concurrent writes, so this
    // is cheap to call from a hot handler.
    saveMessageStore()
  })

  // CRITICAL: After every reconnect, WhatsApp re-delivers any messages we
  // missed during the gap via messaging-history.set. Before this handler
  // existed, those messages were dropped on the floor — that's how Alejandra
  // Martinez's 27-may messages were lost (daemon was down 8:59-9:34, came
  // back, never processed the missed inbound).
  //
  // syncType values: 0=FULL, 1=ON_DEMAND, 2=RECENT, 3=PUSH_NAME, 4=NON_BLOCKING_DATA.
  // We process all of them — the dedup map filters duplicates.
  sock.ev.on('messaging-history.set', ({ messages, syncType, isLatest, progress }) => {
    if (!messages || messages.length === 0) return
    const recovered = processMessages(messages, `history:${syncType}`)
    logger.info({
      received: messages.length,
      recovered,
      syncType,
      isLatest,
      progress,
    }, 'History sync processed (gap recovery)')
    saveState()
    saveMessageStore()
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connected = true
      reconnectDelay = 3000
      disconnectedSince = null
      // Resolve our own number so self-sent messages can be excluded from the
      // inbound signal. Without this the vault's own scheduled reminders would
      // register as incoming traffic and mask a total reception outage.
      ownJidBare = jidBare(sock?.user?.id)
      logger.info({ ownJid: ownJidBare }, 'Connected to WhatsApp')
      _recomputeDaemonState('connection.open')
    }

    if (connection === 'close') {
      connected = false
      recentReconnects.push(Date.now())
      _recomputeDaemonState('connection.close')
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        logger.fatal('Logged out by WhatsApp. Re-authenticate with sync.mjs.')
        releaseLock()
        process.exit(2)
      }

      // ±25% jitter on the backoff delay. Without jitter, all companion
      // devices on the same WhatsApp account synchronise their reconnect
      // attempts (thundering herd), which makes each individual retry MORE
      // likely to fail when the server is throttling. Adding jitter spreads
      // retries across a window so each one sees a less-loaded server.
      const action = DISCONNECT_ACTIONS[code]
      disconnectedSince = disconnectedSince || new Date().toISOString()
      if (action) {
        logger.warn({ code, klass: action.klass, note: action.note }, 'Classified disconnect')
        if (action.delayMs === 0) reconnectDelay = 3000
        scheduleReconnect(Math.max(action.delayMs, action.delayMs === 0 ? 0 : reconnectDelay), `code-${code}`)
        if (action.delayMs === 0) return
      } else {
        scheduleReconnect(reconnectDelay, `code-${code ?? 'unknown'}`)
      }
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
  // doesn't catch processes that are alive-but-frozen. Async write so the
  // heartbeat itself doesn't stall the event loop during heavy processing.
  setInterval(() => {
    if (!signalSince) { signalSince = new Date().toISOString(); saveState() }
    pruneRings()
    fs.writeFile(HEARTBEAT_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      connected,
      state: daemonState,
      ...inboundHealth(),
      messageStoreSize: messageStore.size,
      indexSize: jidToFile.size,
      reconnectsInWindow: recentReconnects.length,
      successfulSendsInWindow: recentSuccessfulSends.length,
    }), () => { /* best-effort, errors ignored */ })
  }, HEARTBEAT_INTERVAL_MS)

  // Rotate log if > 10MB
  setInterval(() => {
    const logPath = path.join(__dir, 'logs', 'daemon.log')
    try {
      const stat = fs.statSync(logPath)
      if (stat.size > 10 * 1024 * 1024) {
        // Copy-truncate, never rename. Renaming a file that an open descriptor
        // still points at makes the writer keep filling the renamed inode while
        // the canonical path stays absent — which is exactly how the
        // session-keys check came to report "clean slate" forever, by absence
        // of its own input. Truncating in place keeps the fd valid.
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
        fs.copyFileSync(logPath, `${logPath}.${stamp}`)
        fs.truncateSync(logPath, 0)
        // Keep 5 dated generations. A single .1 destroyed on every cycle gave a
        // forensic window shorter than the 28-day incident it had to explain.
        const dir = path.dirname(logPath)
        const base = path.basename(logPath)
        const olds = fs.readdirSync(dir)
          .filter(f => f.startsWith(base + '.') && /\.\d{12}$/.test(f))
          .sort()
        for (const f of olds.slice(0, Math.max(0, olds.length - 5))) {
          try { fs.unlinkSync(path.join(dir, f)) } catch {}
        }
        logger.info({ generations: Math.min(olds.length + 1, 5) }, 'Log rotated (copy-truncate)')
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
