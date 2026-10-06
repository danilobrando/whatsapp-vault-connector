/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Publish the read-only tray contract. Every chat has a stable, opaque folder
 * derived from its lower-case JID; every sync gets a fresh lote directory.
 * Attachments are written below that lote, so equal display names can never
 * make bytes cross from one chat into another.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { filterAllowed, normalizeJid } from './allowlist.mjs'
import { renderChat } from './export.mjs'
import { contratoJson } from './contract.mjs'
import { cleanScopedTemps, ensureDir, rmrf, writeFileAtomic } from './fsutil.mjs'

let batchSequence = 0

export function chatIdForJid(jid) {
  return crypto.createHash('sha256').update(normalizeJid(jid), 'utf8').digest('hex').slice(0, 16)
}

function tipoFor(chat) {
  return chat.es_grupo || /@g\.us$/i.test(String(chat.jid || '')) ? 'grupo' : 'individual'
}

function stampFor(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function nextLoteName(chatDir, stamp) {
  let n = 1
  let name
  do {
    name = `lote-${stamp}-${n}`
    n += 1
  } while (fs.existsSync(path.join(chatDir, name)))
  return name
}

function isoBounds(messages) {
  const timestamps = (messages || [])
    .map((m) => Number(m.ts))
    .filter((ts) => Number.isFinite(ts) && ts >= 1000)
  if (!timestamps.length) return { desde_iso: null, hasta_iso: null }
  return {
    desde_iso: new Date(Math.min(...timestamps) * 1000).toISOString(),
    hasta_iso: new Date(Math.max(...timestamps) * 1000).toISOString(),
  }
}

function writeChatMetadata(chatDir, chat) {
  const target = path.join(chatDir, 'chat.json')
  if (fs.existsSync(target)) return
  const data = JSON.stringify({ jid: chat.jid, nombre: chat.nombre, tipo: tipoFor(chat) }) + '\n'
  writeFileAtomic(target, data)
}

/**
 * Write all new lotes below bandeja/.tmp/<pid>-<n> first, then rename each
 * complete lote into its chat folder. Stale connector-owned temp directories
 * are safe to remove before and after a run.
 */
export function writeTray({ bandeja, chats, allow, tz = 'America/Bogota', now = new Date() }) {
  if (!bandeja) return { ok: false, error: 'no bandeja', chatsWritten: 0, messages: 0, attachments: 0 }

  ensureDir(bandeja)
  const tempRoot = path.join(bandeja, '.tmp')
  ensureDir(tempRoot)
  cleanScopedTemps(tempRoot)
  batchSequence += 1
  const batchDir = path.join(tempRoot, `${process.pid}-${batchSequence}`)
  const stamp = stampFor(now)
  const permitted = filterAllowed(chats, allow)
  let chatsWritten = 0
  let messages = 0
  let attachments = 0

  try {
    for (const chat of permitted) {
      const rendered = renderChat(chat, { tz })
      if (rendered.messageCount === 0) continue

      const chatId = chatIdForJid(chat.jid)
      const chatDir = path.join(bandeja, chatId)
      const loteName = nextLoteName(chatDir, stamp)
      const loteTemp = path.join(batchDir, chatId, loteName)
      ensureDir(loteTemp)

      fs.writeFileSync(path.join(loteTemp, 'chat.txt'), rendered.text)
      for (const doc of rendered.attachments) {
        if (doc.data == null) continue
        fs.writeFileSync(path.join(loteTemp, doc.exportName), doc.data)
      }

      const bounds = isoBounds(chat.mensajes)
      fs.writeFileSync(path.join(loteTemp, 'lote.json'), JSON.stringify({
        desde_iso: bounds.desde_iso,
        hasta_iso: bounds.hasta_iso,
        mensajes: rendered.messageCount,
        adjuntos: rendered.attachments.length,
      }) + '\n')

      ensureDir(chatDir)
      writeChatMetadata(chatDir, chat)
      fs.renameSync(loteTemp, path.join(chatDir, loteName))
      chatsWritten += 1
      messages += rendered.messageCount
      attachments += rendered.attachments.filter((doc) => doc.data != null).length
    }

    writeFileAtomic(path.join(bandeja, 'contrato.json'), JSON.stringify(contratoJson()) + '\n')
    return { ok: true, chatsWritten, messages, attachments, permitted: permitted.length }
  } finally {
    rmrf(batchDir)
    cleanScopedTemps(tempRoot)
  }
}
