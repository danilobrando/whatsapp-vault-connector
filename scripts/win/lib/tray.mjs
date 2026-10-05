/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Compose the tray: apply the allow-list, render each permitted chat to the
 * Spanish export format, persist its document attachments beside it, and drop
 * the `contrato.json` marker the product's importer reads first. Every write is
 * atomic (temp + rename) so a concurrent importer never sees a partial file.
 */
import path from 'path'
import { filterAllowed } from './allowlist.mjs'
import { renderChat } from './export.mjs'
import { contratoJson } from './contract.mjs'
import { ensureDir, writeFileAtomic } from './fsutil.mjs'

function chatFileName(chat, used) {
  const base = String(chat.nombre || chat.jid || 'chat')
    .replace(/[/\\?%*:|"<>[\]]/g, '-')
    .trim() || 'chat'
  let name = `${base}.txt`
  let n = 2
  while (used.has(name)) {
    name = `${base}-${n}.txt`
    n += 1
  }
  used.add(name)
  return name
}

export function writeTray({ bandeja, chats, allow, tz = 'America/Bogota' }) {
  if (!bandeja) return { ok: false, error: 'no bandeja', chatsWritten: 0, messages: 0, attachments: 0 }

  ensureDir(bandeja)
  const permitted = filterAllowed(chats, allow)
  const usedNames = new Set()
  let chatsWritten = 0
  let messages = 0
  let attachments = 0

  for (const chat of permitted) {
    const { text, attachments: docs, messageCount } = renderChat(chat, { tz })
    // A chat that renders zero messages is not a chat yet; skip it rather than
    // creating an empty file that the importer would read as "no history".
    if (messageCount === 0) continue

    const fileName = chatFileName(chat, usedNames)
    writeFileAtomic(path.join(bandeja, fileName), text)
    chatsWritten += 1
    messages += messageCount

    for (const doc of docs) {
      if (doc.data == null) continue
      writeFileAtomic(path.join(bandeja, doc.exportName), doc.data)
      attachments += 1
    }
  }

  writeFileAtomic(path.join(bandeja, 'contrato.json'), JSON.stringify(contratoJson(), null, 2) + '\n')

  return { ok: true, chatsWritten, messages, attachments, permitted: permitted.length }
}
