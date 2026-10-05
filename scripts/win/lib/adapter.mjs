/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * The real Baileys adapter — the only file in `win/` that imports the WhatsApp
 * library. Everything else talks to the object this returns, which is why the
 * test suite can run the whole CLI against a double with no network.
 *
 * It is read-only by construction: there is no `send`, no `sendMessage` call and
 * no IPC that accepts a message. The build script enforces that absence at
 * package time (`check-readonly.mjs`).
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { rmrf } from './fsutil.mjs'

const require = createRequire(import.meta.url)

async function loadBaileys() {
  const baileys = await import('@whiskeysockets/baileys')
  const makeWASocket = baileys.makeWASocket ?? baileys.default?.default ?? baileys.default
  if (typeof makeWASocket !== 'function') {
    const err = new Error('Baileys makeWASocket not found')
    err.kind = 'bad-session'
    throw err
  }
  return { baileys, makeWASocket }
}

function tagged(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}

function maskFromJid(jid) {
  const digits = String(jid || '').split(/[:@]/)[0].replace(/\D/g, '')
  if (!digits) return null
  return `+${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

function readCreds(authDir, BufferJSON) {
  const file = path.join(authDir, 'creds.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'), BufferJSON.reviver)
  } catch {
    return null
  }
}

// ── Message mapping ──────────────────────────────────────────────────────────

function extractDocument(m) {
  const d = m.documentMessage
  if (!d) return null
  return { kind: 'document', fileName: d.fileName || 'documento', mime: d.mimetype || null, raw: d }
}

function extractAttachment(m) {
  if (m.documentMessage) return extractDocument(m)
  if (m.imageMessage) return { kind: 'image', fileName: 'imagen.jpg', mime: m.imageMessage.mimetype || null }
  if (m.videoMessage) return { kind: 'video', fileName: 'video.mp4', mime: m.videoMessage.mimetype || null }
  if (m.audioMessage) return { kind: 'audio', fileName: m.audioMessage.ptt ? 'nota-de-voz.opus' : 'audio.opus', mime: m.audioMessage.mimetype || null }
  if (m.stickerMessage) return { kind: 'sticker', fileName: 'sticker.webp', mime: m.stickerMessage.mimetype || null }
  return null
}

const SILENT_LOGGER = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } }

async function downloadDocument(sock, msg, baileys) {
  try {
    return await baileys.downloadMediaMessage(msg, 'buffer', {}, { logger: SILENT_LOGGER, reuploadRequest: sock.updateMediaMessage })
  } catch {
    return null
  }
}

function extractText(m) {
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage) return m.imageMessage.caption || ''
  if (m.videoMessage) return m.videoMessage.caption || ''
  if (m.documentMessage) return m.documentMessage.caption || ''
  return ''
}

function authorFor(msg, contacts, senderName) {
  if (msg.key?.fromMe) return senderName
  const jid = msg.key?.participant || msg.key?.remoteJid
  const bare = String(jid || '').split('@')[0]
  const c = contacts[jid] || contacts[`${bare}@s.whatsapp.net`]
  return msg.pushName || c?.notify || c?.name || `+${bare}`
}

async function mapMessage(sock, msg, contacts, senderName, baileys) {
  const ts = Number(msg.messageTimestamp) || 0
  const m = msg.message || {}
  const attachment = extractAttachment(m)
  const text = extractText(m)
  const fromMe = !!msg.key?.fromMe
  const author = authorFor(msg, contacts, senderName)

  if (attachment && attachment.kind === 'document' && fromMe) {
    // Documents arrive from the send path; in read-only mode we still receive
    // third-party documents, so only fetch for inbound messages.
  }
  if (attachment && attachment.kind === 'document') {
    attachment.data = await downloadDocument(sock, msg, baileys)
    delete attachment.raw
  }

  if (!text && !attachment) return null
  return { ts, fromMe, author, text, system: false, attachment }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export async function createAdapter({ paths, tz = 'America/Bogota', env = process.env, senderName = 'Me' }) {
  const { baileys, makeWASocket } = await loadBaileys()
  const { useAtomicMultiFileAuthState, cleanupAuthTemps } = await import('../../atomic-auth-state.mjs')

  function assertNetwork(err) {
    const msg = String(err && err.message || err)
    if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|fetch failed|network|getaddrinfo/i.test(msg)) {
      return tagged('no-net', msg)
    }
    return err
  }

  async function newSocket(onEvent) {
    fs.mkdirSync(paths.authDir, { recursive: true })
    let auth
    try {
      auth = await useAtomicMultiFileAuthState(paths.authDir)
    } catch (err) {
      throw tagged('bad-session', `Auth store unreadable: ${err.message}`)
    }
    let version
    try {
      version = (await baileys.fetchLatestBaileysVersion()).version
    } catch (err) {
      throw assertNetwork(tagged('no-net', `Cannot determine WhatsApp version: ${err.message}`))
    }
    const sock = makeWASocket({
      version,
      auth: auth.state,
      logger: SILENT_LOGGER,
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      browser: ['Vault Connector', 'Chrome', '120.0.0'],
    })
    sock.ev.on('creds.update', auth.saveCreds)
    if (onEvent) onEvent(sock)
    return sock
  }

  function attachCollectors(sock) {
    const contacts = {}
    const chats = new Map()
    const mergeContacts = (list) => { for (const c of list || []) if (c.id) contacts[c.id] = { ...contacts[c.id], ...c } }
    sock.ev.on('contacts.set', ({ contacts: list }) => mergeContacts(list))
    sock.ev.on('contacts.upsert', (list) => mergeContacts(list))
    const mergeMessages = (list) => {
      for (const msg of list || []) {
        const jid = msg.key?.remoteJid
        if (!jid) continue
        if (!chats.has(jid)) chats.set(jid, [])
        const arr = chats.get(jid)
        if (!arr.find((m) => m.key?.id === msg.key?.id)) arr.push({ __raw: msg })
      }
    }
    sock.ev.on('messaging-history.set', ({ contacts: c, messages }) => { mergeContacts(c || []); mergeMessages(messages || []) })
    sock.ev.on('messages.upsert', ({ messages }) => mergeMessages(messages || []))
    return { contacts, chats }
  }

  async function toModel(sock, contacts, chats) {
    const out = []
    for (const [jid, list] of chats) {
      const isGroup = baileys.isJidGroup(jid) || jid.includes('@broadcast')
      const bare = jid.split('@')[0]
      const name = isGroup
        ? (contacts[jid]?.name || contacts[jid]?.notify || bare)
        : (contacts[jid]?.notify || contacts[jid]?.name || `+${bare}`)
      const mensajes = []
      for (const entry of list) {
        const mapped = await mapMessage(sock, entry.__raw, contacts, senderName, baileys)
        if (mapped) mensajes.push(mapped)
      }
      mensajes.sort((a, b) => a.ts - b.ts)
      out.push({ jid, nombre: name, es_grupo: isGroup, mensajes })
    }
    return out
  }

  function awaitConnection(sock, { onQR, onCode, phone, timeoutMs = 180000 }) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
      sock.ev.on('creds.update', () => {})
      sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u
        if (qr && onQR) onQR(qr)
        if (qr && phone && onCode) {
          try {
            const code = await sock.requestPairingCode(phone)
            onCode(code)
          } catch (err) { finish(reject, assertNetwork(err)) }
        }
        if (connection === 'open') finish(resolve, { jid: sock.user?.id || null })
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode
          if (code === baileys.DisconnectReason.loggedOut) {
            finish(reject, tagged('bad-session', 'Logged out by WhatsApp'))
          } else if (code === baileys.DisconnectReason.restartRequired) {
            // benign; Baileys will reconnect
          } else {
            finish(reject, assertNetwork(tagged('no-net', `Connection closed (${code})`)))
          }
        }
      })
      setTimeout(() => finish(reject, tagged('no-net', 'Timed out waiting for WhatsApp')), timeoutMs)
    })
  }

  return {
    name: 'baileys',
    async linked() {
      const creds = readCreds(paths.authDir, baileys.BufferJSON)
      return !!(creds && creds.registered)
    },
    async account() {
      const creds = readCreds(paths.authDir, baileys.BufferJSON)
      const id = creds?.me?.id || creds?.me?.jid || null
      if (!id) return null
      return { jid: id, mask: maskFromJid(id) }
    },
    async linkQR({ onQR } = {}) {
      const sock = await newSocket()
      const { contacts, chats } = attachCollectors(sock)
      void contacts; void chats
      await awaitConnection(sock, { onQR })
      return this.account()
    },
    async linkCode(phone, { onCode } = {}) {
      const sock = await newSocket()
      attachCollectors(sock)
      await awaitConnection(sock, { phone, onCode })
      return this.account()
    },
    async fetchChats() {
      const sock = await newSocket()
      const { contacts, chats } = attachCollectors(sock)
      let done = false
      await new Promise((resolve) => {
        const idle = () => { if (!done) { done = true; resolve() } }
        let timer = setTimeout(idle, 30000)
        sock.ev.on('messaging-history.set', () => { clearTimeout(timer); timer = setTimeout(idle, 3000) })
        sock.ev.on('connection.update', (u) => {
          if (u.connection === 'open') { clearTimeout(timer); timer = setTimeout(idle, 30000) }
          if (u.connection === 'close') {
            const code = u.lastDisconnect?.error?.output?.statusCode
            if (code === baileys.DisconnectReason.loggedOut) {
              done = true
              resolve(tagged('bad-session', 'Logged out by WhatsApp'))
            }
          }
        })
      }).then((err) => { if (err) throw err })
      const model = await toModel(sock, contacts, chats)
      try { await sock.end(undefined) } catch { sock.ws?.close?.() }
      return model
    },
    async logout() {
      try {
        const sock = await newSocket()
        await sock.logout().catch(() => {})
        try { sock.ws?.close?.() } catch {}
      } catch { /* fall through to local wipe */ }
      rmrf(paths.authDir)
      try { await cleanupAuthTemps(paths.authDir) } catch {}
    },
    async stop() {
      fs.writeFileSync(paths.stopFile, String(Date.now()))
      return { stopRequested: true }
    },
  }
}

export const _internal = { maskFromJid, readCreds, extractAttachment }
