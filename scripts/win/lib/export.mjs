/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * The read-only tray writer.
 *
 * The tray mimics WhatsApp's own "export chat" in Spanish, because the
 * product's importer already understands that format and a bespoke one would
 * silently diverge the first time WhatsApp changes something. Concretely:
 *
 *   - one `.txt` per chat;
 *   - header lines `dd/mm/aa, hh:mm - Nombre: mensaje`, 24-hour clock;
 *   - multi-line messages keep their newlines, so continuation lines carry no
 *     timestamp (exactly as the official export does);
 *   - system messages have no `Nombre:` prefix;
 *   - documents (pdf, docx, xlsx, pptx, txt, csv, md) are written beside the
 *     chat as `<8-digit index>-<original name>` and referenced as
 *     `<adjunto: 00000012-file.pdf>`;
 *   - every other attachment is recorded as `<adjunto omitido>`.
 *
 * Everything here is pure: it takes an already-fetched chat and returns text
 * plus the attachments to persist. That is what makes the format testable
 * against a hand-written fixture without a network.
 */
import path from 'path'
import { ATTACHMENT_OMITTED } from './constants.mjs'

export { ATTACHMENT_OMITTED }

const DOC_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'csv', 'md'])
const MEDIA_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'mp4', 'mov', '3gp', 'opus', 'ogg', 'm4a', 'mp3', 'wav', 'webp'])

const formatterCache = new Map()
function formatterFor(tz) {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(tz, f)
  }
  return f
}

function partsFor(unixSeconds, tz) {
  const date = new Date(Number(unixSeconds) * 1000)
  const parts = Object.fromEntries(
    formatterFor(tz).formatToParts(date).map((p) => [p.type, p.value]),
  )
  return parts
}

/** `dd/mm/aa, hh:mm` — the export's timestamp, in the caller's timezone. */
export function formatExportTimestamp(unixSeconds, tz) {
  const p = partsFor(unixSeconds, tz)
  return `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute}`
}

export function extensionOf(fileName) {
  const ext = path.extname(String(fileName || '')).slice(1).toLowerCase()
  return ext
}

export function isDocumentAttachment(fileName) {
  return DOC_EXTENSIONS.has(extensionOf(fileName))
}

export function isMediaAttachment(fileName) {
  return MEDIA_EXTENSIONS.has(extensionOf(fileName))
}

export function sanitizeName(name) {
  return String(name || 'archivo')
    .replace(/[/\\?%*:|"<>[\]]/g, '-')
    .trim() || 'archivo'
}

/** `<8-digit index>-<original name>`; the naming the Spanish export uses. */
export function documentFileName(index, fileName) {
  return `${String(index).padStart(8, '0')}-${sanitizeName(fileName)}`
}

function validMessage(msg) {
  const ts = Number(msg && msg.ts)
  return Number.isFinite(ts) && ts >= 1000
}

function lineFor(msg, tz) {
  const stamp = formatExportTimestamp(msg.ts, tz)
  const author = String(msg.author || msg.from || '+').trim()
  const attachment = msg.attachment

  if (attachment && attachment.kind === 'document') {
    // Resolved by the caller, which tracks the per-chat attachment index.
    return { kind: 'document', stamp, author, text: `<adjunto: ${attachment.__exportName}>`, caption: msg.text || '' }
  }
  if (attachment) {
    return { kind: 'media', stamp, author, text: ATTACHMENT_OMITTED, caption: msg.text || '' }
  }
  return { kind: 'text', stamp, author, text: msg.text == null ? '' : String(msg.text) }
}

/**
 * Render one chat to the export's text plus the attachments to persist.
 *
 * `chat` is `{ jid, nombre, es_grupo, mensajes: [...] }`. Returns
 * `{ text, attachments, messageCount }`, where each attachment is
 * `{ exportName, sourceName, data }` and `data` is whatever the adapter
 * fetched (a Buffer, a path, or null when the caller downloads lazily).
 */
export function renderChat(chat, { tz = 'America/Bogota' } = {}) {
  const lines = []
  const attachments = []
  let count = 0
  let docIndex = 0

  for (const msg of chat.mensajes || []) {
    if (!validMessage(msg)) continue

    if (msg.system) {
      lines.push(`${formatExportTimestamp(msg.ts, tz)} - ${String(msg.text || '')}`)
      count++
      continue
    }

    const attachment = msg.attachment
    let resolved = msg
    if (attachment && attachment.kind === 'document') {
      docIndex += 1
      const exportName = documentFileName(docIndex, attachment.fileName || 'documento')
      attachments.push({
        exportName,
        sourceName: attachment.fileName || 'documento',
        mime: attachment.mime || null,
        data: attachment.data ?? null,
      })
      resolved = { ...msg, attachment: { ...attachment, __exportName: exportName } }
    }

    const line = lineFor(resolved, tz)
    const prefix = line.author ? `${line.stamp} - ${line.author}: ` : `${line.stamp} - `
    lines.push(`${prefix}${line.text}`)
    if (line.caption) lines.push(String(line.caption))
    count++
  }

  return { text: lines.length ? lines.join('\n') + '\n' : '', attachments, messageCount: count }
}

export const EXPORT = { DOC_EXTENSIONS, MEDIA_EXTENSIONS }
