import test from 'node:test'
import assert from 'node:assert/strict'
import { renderChat, formatExportTimestamp, documentFileName } from '../lib/export.mjs'

const chat = {
  jid: '573001112233@s.whatsapp.net',
  nombre: 'Ana',
  es_grupo: false,
  mensajes: [
    { ts: 1710000000, fromMe: false, author: 'Ana', text: 'Hola\n¿cómo estás?' },
    { ts: 1710000060, fromMe: true, author: 'Yo', text: 'Bien, gracias' },
    { ts: 1710000120, system: true, text: 'Los mensajes y las llamadas están cifrados de extremo a extremo.' },
    { ts: 1710000180, fromMe: false, author: 'Ana', text: '', attachment: { kind: 'document', fileName: 'presupuesto.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 fixture') } },
    { ts: 1710000240, fromMe: false, author: 'Ana', text: '', attachment: { kind: 'image', fileName: 'foto.jpg', mime: 'image/jpeg' } },
  ],
}

// Hand-written from the Spanish export format: dd/mm/aa, hh:mm - Nombre: texto,
// with the multi-line body kept as its own continuation line, a system message
// without a name prefix, a document referenced by its indexed filename and every
// other attachment replaced by the omitted marker.
const EXPECTED = [
  '09/03/24, 11:00 - Ana: Hola',
  '¿cómo estás?',
  '09/03/24, 11:01 - Yo: Bien, gracias',
  '09/03/24, 11:02 - Los mensajes y las llamadas están cifrados de extremo a extremo.',
  '09/03/24, 11:03 - Ana: <adjunto: 00000001-presupuesto.pdf>',
  '09/03/24, 11:04 - Ana: <adjunto omitido>',
  '',
].join('\n')

test('formats a chat exactly like the Spanish export fixture', () => {
  const { text, attachments, messageCount } = renderChat(chat, { tz: 'America/Bogota' })
  // The guard the criterion asks for: this must not pass by processing nothing.
  assert.ok(messageCount > 0, 'expected messages to be processed')
  assert.equal(messageCount, 5)
  assert.equal(text, EXPECTED)
  assert.deepEqual(attachments.map((a) => a.exportName), ['00000001-presupuesto.pdf'])
  assert.equal(attachments[0].data.toString('utf8'), '%PDF-1.4 fixture')
})

test('timestamps are dd/mm/aa, hh:mm on a 24-hour clock', () => {
  assert.equal(formatExportTimestamp(1710000000, 'America/Bogota'), '09/03/24, 11:00')
  assert.equal(formatExportTimestamp(1710000000, 'UTC'), '09/03/24, 16:00')
})

test('document filenames are the export 8-digit index', () => {
  assert.equal(documentFileName(1, 'presupuesto.pdf'), '00000001-presupuesto.pdf')
  assert.equal(documentFileName(12, 'a/b.pdf'), '00000012-a-b.pdf')
})

test('a chat with no valid messages renders nothing', () => {
  const { messageCount, text } = renderChat({ mensajes: [{ ts: 1, text: 'too old' }, { ts: 0 }] }, { tz: 'UTC' })
  assert.equal(messageCount, 0)
  assert.equal(text, '')
})
