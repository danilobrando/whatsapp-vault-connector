/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

import makeWASocket, { useMultiFileAuthState, downloadMediaMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(__dir, 'baileys_auth')
const STORE_FILE = path.join(__dir, 'baileys_store.json')
const OUTPUT = '/tmp/andres_caicedo_speaker.jpg'

const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
const jid = '573007850053@s.whatsapp.net'
const msgs = store.messages[jid] || []

const imgMsg = msgs.find(m => m.message?.imageMessage)
if (!imgMsg) { console.error('No image found'); process.exit(1) }

console.log('Found image, connecting to download...')

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
const sock = makeWASocket({
  auth: state,
  logger: pino({ level: 'silent' }),
  printQRInTerminal: false,
  markOnlineOnConnect: false,
})

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', async ({ connection }) => {
  if (connection === 'open') {
    try {
      const buffer = await downloadMediaMessage(imgMsg, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage,
      })
      fs.writeFileSync(OUTPUT, buffer)
      console.log('Photo saved: ' + OUTPUT + ' (' + buffer.length + ' bytes)')
    } catch (err) {
      console.error('Download failed:', err.message)
    }
    process.exit(0)
  }
})

setTimeout(() => { console.error('Timeout'); process.exit(1) }, 30000)
