/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * send.mjs — Send a WhatsApp message using existing Baileys session.
 *
 * Usage:
 *   node send.mjs --to "15551234567" --msg "Hola!"
 *   node send.mjs --to "573164060562@s.whatsapp.net" --msg "Hola!"
 *   node send.mjs --search "Nelly" --msg "Hola!"
 *
 * Requires an existing baileys_auth/ session (run sync.mjs first).
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
const STORE_FILE = path.join(__dir, 'baileys_store.json')
const VAULT_DIR = path.resolve(__dir, '..', '..', '..', '⚙️ Meta', 'whatsapp-inbox')

const silent = pino({ level: 'silent' })

// ── Parse args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  const parsed = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    parsed[key] = args[i + 1]
  }
  return parsed
}

// ── Resolve JID from --to or --search ────────────────────────────────────────

function resolveJid(args) {
  if (args.to) {
    let to = args.to.replace(/[+\-\s]/g, '')
    if (!to.includes('@')) to += '@s.whatsapp.net'
    return { jid: to, displayName: args.to }
  }

  if (args.search) {
    const query = args.search.toLowerCase()

    // Search in vault files (most reliable — has phone + name)
    if (fs.existsSync(VAULT_DIR)) {
      for (const file of fs.readdirSync(VAULT_DIR)) {
        if (!file.endsWith('.md') || file.startsWith('+')) continue
        const name = file.replace('.md', '').replace(/ \(\d+\)$/, '')
        if (name.toLowerCase().includes(query)) {
          const content = fs.readFileSync(path.join(VAULT_DIR, file), 'utf8')
          const phoneMatch = content.match(/phone:\s*"?\+?(\d+)"?/)
          if (phoneMatch) {
            const jid = phoneMatch[1] + '@s.whatsapp.net'
            return { jid, displayName: name }
          }
        }
      }
    }

    // Search in Baileys store
    if (fs.existsSync(STORE_FILE)) {
      const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
      for (const [jid, c] of Object.entries(store.contacts || {})) {
        const name = c.name || c.notify || ''
        if (name.toLowerCase().includes(query)) {
          return { jid, displayName: name }
        }
      }
    }

    console.error(`Contact "${args.search}" not found.`)
    process.exit(1)
  }

  console.error('Usage: node send.mjs --to "15551234567" --msg "text"')
  console.error('       node send.mjs --search "Nelly" --msg "text"')
  process.exit(1)
}

// ── Send ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs()

  if (!args.msg) {
    console.error('Missing --msg parameter.')
    process.exit(1)
  }

  if (!fs.existsSync(AUTH_DIR)) {
    console.error('No baileys_auth/ found. Run sync.mjs first to authenticate.')
    process.exit(1)
  }

  const { jid, displayName } = resolveJid(args)

  console.log(`Sending to: ${displayName} (${jid})`)
  console.log(`Message: ${args.msg}`)

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: silent,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ['WhatsApp Vault Send', 'Desktop', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      try {
        await sock.sendMessage(jid, { text: args.msg })
        console.log(`\n✓ Sent.`)
      } catch (err) {
        console.error(`\n✗ Failed: ${err.message}`)
        process.exit(1)
      }

      setTimeout(() => process.exit(0), 2_000)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.error('Session expired. Run sync.mjs to re-authenticate.')
        process.exit(1)
      }
      console.error('Connection failed.')
      process.exit(1)
    }
  })
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
