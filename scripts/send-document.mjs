/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * send-document.mjs — Send a WhatsApp document/PDF using existing Baileys session.
 *
 * Usage:
 *   node send-document.mjs --jid "120363407929115487@g.us" --file "/tmp/foo.pdf" --caption "Hola"
 *   node send-document.mjs --jid "15551234567" --file "/tmp/foo.pdf"
 *
 * Group JIDs end in @g.us. Personal JIDs end in @s.whatsapp.net.
 * Requires an existing baileys_auth/ session.
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(__dir, 'baileys_auth')

const silent = pino({ level: 'silent' })

function parseArgs() {
  const args = process.argv.slice(2)
  const parsed = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    parsed[key] = args[i + 1]
  }
  return parsed
}

function normalizeJid(input) {
  if (!input) return null
  if (input.includes('@')) return input
  // Strip + - whitespace
  const cleaned = input.replace(/[+\-\s]/g, '')
  // If it looks like a group id (long numerical, 18+ digits) → group
  if (/^\d{18,}$/.test(cleaned)) return `${cleaned}@g.us`
  // Otherwise personal
  return `${cleaned}@s.whatsapp.net`
}

async function main() {
  const args = parseArgs()
  if (!args.jid || !args.file) {
    console.error('Usage: node send-document.mjs --jid "<jid>" --file "<path>" [--caption "<text>"] [--filename "<name>"] [--mimetype "application/pdf"]')
    process.exit(1)
  }
  const jid = normalizeJid(args.jid)
  const filePath = path.resolve(args.file)
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }
  if (!fs.existsSync(AUTH_DIR)) {
    console.error('No baileys_auth/ found. Run sync.mjs first to authenticate.')
    process.exit(1)
  }

  const fileBuffer = fs.readFileSync(filePath)
  const fileName = args.filename || path.basename(filePath)
  const mimetype = args.mimetype || (fileName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream')

  console.log(`Sending document to: ${jid}`)
  console.log(`File: ${filePath} (${fileBuffer.length} bytes, mimetype=${mimetype})`)
  if (args.caption) console.log(`Caption: ${args.caption}`)

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: silent,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ['WhatsApp Vault Document Send', 'Desktop', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      try {
        const message = {
          document: fileBuffer,
          mimetype,
          fileName,
        }
        if (args.caption) message.caption = args.caption
        await sock.sendMessage(jid, message)
        console.log(`\n✓ Sent.`)
      } catch (err) {
        console.error(`\n✗ Failed: ${err.message}`)
        process.exit(1)
      }
      setTimeout(() => process.exit(0), 3_000)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.error('Session expired. Run sync.mjs to re-authenticate.')
        process.exit(1)
      }
    }
  })
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
