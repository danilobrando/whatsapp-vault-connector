/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * whatsapp-vault-sync (ai-brain-starter edition)
 *
 * Connects to personal WhatsApp via QR code (WhatsApp Web protocol),
 * pulls full chat history, and writes one markdown file per contact
 * to your Obsidian vault. Re-runs are incremental — only new messages.
 *
 * Usage:
 *   cd scripts/whatsapp && npm install
 *   node sync.mjs
 *   node sync.mjs --groups   # include group chats
 *
 * Session is saved in baileys_auth/ — no re-scan on subsequent runs.
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidGroup,
} from '@whiskeysockets/baileys'
import qrcodeTerminal from 'qrcode-terminal'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ── Config ────────────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url))
const INCLUDE_GROUPS = process.argv.includes('--groups')

// Standard install path: <vault>/connectors/whatsapp/  (this file lives 2 dirs deep)
const VAULT_ROOT = process.env.VAULT_ROOT || path.resolve(__dir, '..', '..')
// Must match the daemon's WA_INBOX_SUFFIX, or the pairing history export would
// write to different filenames than the daemon and fork every conversation.
const INBOX_SUFFIX = process.env.WA_INBOX_SUFFIX || ''

const OUTPUT_DIR = path.join(VAULT_ROOT, process.env.WA_OUTPUT || '⚙️ Meta/whatsapp-inbox')
const AUTH_DIR   = path.join(__dir, 'baileys_auth')
const STORE_FILE = path.join(__dir, 'baileys_store.json')

const silent = pino({ level: 'silent' })

// ── Store: load / save ────────────────────────────────────────────────────────

function loadStore() {
  if (fs.existsSync(STORE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
      return {
        contacts: raw.contacts || {},
        messages: new Map(Object.entries(raw.messages || {})),
      }
    } catch { /* corrupt — start fresh */ }
  }
  return { contacts: {}, messages: new Map() }
}

function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify({
    contacts: store.contacts,
    messages: Object.fromEntries(store.messages),
  }), 'utf8')
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

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>[\]]/g, '-').trim() || 'Unknown'
}

function getContactName(jid, contacts) {
  const bare = jid.split('@')[0]
  const c = contacts[jid]
           || contacts[bare + '@c.us']
           || contacts[bare + '@s.whatsapp.net']
  return c?.notify || c?.name || ('+' + bare)
}

// ── Message text extraction ───────────────────────────────────────────────────

function extractText(msg) {
  if (!msg?.message) return null
  const m = msg.message

  if (m.conversation)              return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage)              return m.imageMessage.caption  ? `[Image: ${m.imageMessage.caption}]`  : '[Image]'
  if (m.videoMessage)              return m.videoMessage.caption  ? `[Video: ${m.videoMessage.caption}]`  : '[Video]'
  if (m.audioMessage)              return m.audioMessage.ptt      ? '[Voice note]'                        : '[Audio]'
  if (m.documentMessage)           return `[Document: ${m.documentMessage.fileName || 'file'}]`
  if (m.stickerMessage)            return '[Sticker]'
  if (m.contactMessage)            return `[Contact shared: ${m.contactMessage.displayName}]`
  if (m.locationMessage)           return '[Location]'
  if (m.pollCreationMessage)       return `[Poll: ${m.pollCreationMessage.name}]`
  if (m.ephemeralMessage)          return extractText({ message: m.ephemeralMessage.message })
  if (m.viewOnceMessage)           return '[View-once media]'
  if (m.reactionMessage)           return null
  if (m.protocolMessage)           return null
  if (m.pollUpdateMessage)         return null
  return null
}

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown(displayName, phone, messages, jid = null, isGroup = false) {
  const byDate = {}
  let count = 0

  for (const msg of messages) {
    const ts = Number(msg.messageTimestamp)
    if (!ts || ts < 1000) continue
    const text = extractText(msg)
    if (!text) continue

    const date = formatDate(ts)
    if (!byDate[date]) byDate[date] = []
    byDate[date].push(`**${formatTime(ts)}** ${msg.key?.fromMe ? SENDER_NAME : displayName}: ${text}`)
    count++
  }

  const dates = Object.keys(byDate).sort()
  if (dates.length === 0) return null

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: TZ })

  const lines = [
    '---',
    `type: whatsapp-conversation`,
    `contact: "${displayName}"`,
    // Groups MUST carry `jid:`, not `phone:`. The daemon's file index maps a
    // `phone:` value to `<digits>@s.whatsapp.net`, which can never match a real
    // `@g.us` group — so a group file written with `phone:` is invisible to the
    // index, and the daemon would treat the conversation as new and overwrite
    // this file, destroying the exported history.
    isGroup ? `jid: "${jid}"` : `phone: "+${phone}"`,
    `message_count: ${count}`,
    `first_message: ${dates[0]}`,
    `last_message: ${dates[dates.length - 1]}`,
    `last_sync: ${today}`,
    `status: pending`,
    '---',
    '',
    `# WhatsApp — ${displayName}`,
    '',
    '## Mensajes',
    '',
  ]

  for (const date of dates) {
    lines.push(`### ${date}`, '', ...byDate[date], '')
  }

  return lines.join('\n')
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportToVault(store) {
  console.log('\nExporting to vault...')
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  let synced = 0
  let preserved = 0, skippedGroups = 0, skippedEmpty = 0

  for (const [jid, messages] of store.messages) {
    const isGroup = isJidGroup(jid) || jid.includes('@broadcast')
    if (isGroup && !INCLUDE_GROUPS) { skippedGroups++; continue }

    const phone       = jid.split('@')[0]
    const displayName = isGroup
      ? (store.contacts[jid]?.name || store.contacts[jid]?.notify || jid.split('@')[0])
      : getContactName(jid, store.contacts)

    if (!messages?.length) { skippedEmpty++; continue }

    const markdown = buildMarkdown(displayName, phone, messages, jid, isGroup)
    if (!markdown) { skippedEmpty++; continue }

    // NEVER overwrite an existing conversation. This script is the documented
    // recovery step, and it used to clobber the vault's history with whatever
    // Baileys happened to hold — so the act of recovering could destroy the
    // record of what was lost. If a file exists, the export lands beside it and
    // a human decides what to merge.
    const target = path.join(OUTPUT_DIR, sanitizeFilename(displayName) + INBOX_SUFFIX + '.md')
    if (fs.existsSync(target)) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const side = target.replace(/\.md$/, `.imported-${stamp}.md`)
      fs.writeFileSync(side, markdown, 'utf8')
      preserved++
    } else {
      fs.writeFileSync(target, markdown, 'utf8')
    }
    synced++
    if (synced % 25 === 0) process.stdout.write(`  ${synced} written...\r`)
  }

  saveStore(store)
  fs.writeFileSync(path.join(__dir, '.last_sync'), new Date().toISOString())

  console.log(`\nDone.`)
  console.log(`  ${synced} conversations → ${OUTPUT_DIR}`)
  if (skippedGroups > 0) console.log(`  ${skippedGroups} groups skipped  (re-run with --groups to include)`)
  console.log(`\nSafe to close this window.`)
}

// ── Connection ────────────────────────────────────────────────────────────────

async function connect() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  const isFirstRun = !fs.existsSync(STORE_FILE)
  const store      = loadStore()

  console.log(isFirstRun
    ? 'First run — requesting full history from WhatsApp...'
    : 'Previous session found — fetching new messages only...')
  console.log(`Output: ${OUTPUT_DIR}\n`)

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version }          = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth:                state,
    logger:              silent,
    printQRInTerminal:   false,
    syncFullHistory:     true,
    markOnlineOnConnect: false,
    // Same identity as daemon.mjs: 'Chrome' puts us in the web-session
    // companion slot, separate from the official WhatsApp Desktop app slot.
    // The platform is locked in during pairing — sync.mjs and daemon.mjs MUST
    // agree, otherwise a daemon-side identity change is silently ignored by
    // the server until the next re-pair.
    browser:             ['Vault Sync', 'Chrome', '120.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  const mergeContacts = (contacts) => {
    for (const c of contacts || []) {
      if (c.id) store.contacts[c.id] = { ...store.contacts[c.id], ...c }
    }
  }
  sock.ev.on('contacts.set',    ({ contacts }) => mergeContacts(contacts))
  sock.ev.on('contacts.upsert', (contacts)     => mergeContacts(contacts))

  const mergeMessages = (msgs) => {
    for (const msg of msgs || []) {
      const jid = msg.key?.remoteJid
      if (!jid) continue
      if (!store.messages.has(jid)) store.messages.set(jid, [])
      const arr = store.messages.get(jid)
      if (!arr.find(m => m.key?.id === msg.key?.id)) arr.push(msg)
    }
  }
  sock.ev.on('messages.set', ({ messages }) => mergeMessages(messages))

  let historyDone = false
  let idleTimer   = null

  const scheduleIdleCheck = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!historyDone) {
        historyDone = true
        exportToVault(store)
        process.exit(0)
      }
    }, 45_000)
  }

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
    mergeContacts(contacts || [])
    mergeMessages(messages || [])

    let totalMsgs = 0
    for (const [, msgs] of store.messages) totalMsgs += msgs.length
    process.stdout.write(
      `  History: ${store.messages.size} chats | ${totalMsgs} total msgs | +${(messages || []).length} batch\r`
    )

    // Don't trust isLatest — WhatsApp often sends it before all history arrives.
    // Rely on idle timeout instead: export only when no new batches for 45s.
    if (isLatest) {
      console.log(`\n  WhatsApp signaled isLatest — waiting 45s for any remaining batches...`)
    }

    scheduleIdleCheck()
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      process.stdout.write('\x1Bc')
      console.log('────────────────────────────────────────────────────────')
      console.log('  whatsapp-vault-sync — Scan to connect')
      console.log('────────────────────────────────────────────────────────')
      console.log('  On your phone:')
      console.log('  Settings › Linked Devices › Link a Device\n')
      qrcodeTerminal.generate(qr, { small: true })
      console.log('\n  (QR expires in ~20 s and refreshes automatically)\n')
      // Persist the raw QR string so external tools (PNG renderer, browser preview)
      // can pick it up without parsing the terminal ASCII art. The file is rewritten
      // on every QR rotation, so consumers should watch its mtime.
      // The QR is a live credential: whoever scans it while valid links their own
    // device to this account. Never write it to /tmp (mode 1777).
    try {
      const qrPath = process.env.WA_QR_PATH || path.join(__dir, '.pair', 'qr-raw.txt')
      fs.mkdirSync(path.dirname(qrPath), { recursive: true, mode: 0o700 })
      fs.writeFileSync(qrPath, qr, { mode: 0o600 })
    } catch {}
    }

    if (connection === 'open') {
      console.log('\nConnected. Receiving history...\n')
      setTimeout(() => {
        if (!historyDone) {
          historyDone = true
          if (idleTimer) clearTimeout(idleTimer)
          exportToVault(store)
          process.exit(0)
        }
      }, 120_000)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('\nLogged out. Delete baileys_auth/ and run again.')
        process.exit(1)
      }
      console.log('Connection dropped — reconnecting...')
      setTimeout(connect, 3_000)
    }
  })
}

connect().catch(err => {
  console.error('\nFatal error:', err.message)
  process.exit(1)
})
