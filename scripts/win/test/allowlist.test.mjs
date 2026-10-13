import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseAllowList, filterAllowed, isAllowed } from '../lib/allowlist.mjs'
import { chatIdForJid, writeTray } from '../lib/tray.mjs'
import { chatsFixture } from './doubles/baileys-double.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-allow-'))
}

function lotes(bandeja, jid) {
  const dir = path.join(bandeja, chatIdForJid(jid))
  return fs.readdirSync(dir).filter((name) => name.startsWith('lote-')).sort().map((name) => path.join(dir, name))
}

test('parses array, object and whitespace allow-lists', () => {
  assert.equal(parseAllowList(['a@s.whatsapp.net']).size, 1)
  assert.equal(parseAllowList('{"jids":["a","b"]}').size, 2)
  assert.equal(parseAllowList('a\nb c').size, 3)
})

test('a group that is not allowed is not written; an allowed one is', () => {
  const bandeja = tmp()
  const allow = parseAllowList(['573001112233@s.whatsapp.net', '120363000000000001@g.us'])
  const stats = writeTray({ bandeja, chats: chatsFixture(), allow, tz: 'America/Bogota', now: new Date('2026-10-06T12:00:00Z') })

  assert.ok(stats.messages > 0, 'expected messages to be processed')
  assert.equal(stats.chatsWritten, 2)
  assert.ok(fs.existsSync(path.join(bandeja, chatIdForJid('573001112233@s.whatsapp.net'), 'chat.json')))
  assert.ok(fs.existsSync(path.join(bandeja, chatIdForJid('120363000000000001@g.us'), 'chat.json')))
  assert.ok(!fs.existsSync(path.join(bandeja, chatIdForJid('120363000000000009@g.us'))))

  const anaLote = lotes(bandeja, '573001112233@s.whatsapp.net')[0]
  const ana = fs.readFileSync(path.join(anaLote, 'chat.txt'), 'utf8')
  assert.match(ana, /<adjunto: 00000001-presupuesto\.pdf>/)
  assert.match(ana, /<adjunto omitido>/)
  assert.ok(fs.existsSync(path.join(anaLote, '00000001-presupuesto.pdf')), 'document must stay inside its lote')

  const contrato = JSON.parse(fs.readFileSync(path.join(bandeja, 'contrato.json'), 'utf8'))
  assert.deepEqual(contrato, {
    contrato: 1,
    origen: 'whatsapp-vault-connector',
    version: '3.0.1',
    formato_fecha: 'dd/mm/aa',
    reloj: '24h',
  })
})

test('two sync passes create two complete, non-overwriting lotes', () => {
  const bandeja = tmp()
  const allow = parseAllowList(['573001112233@s.whatsapp.net'])
  const first = writeTray({ bandeja, chats: chatsFixture(), allow, now: new Date('2026-10-06T12:00:00Z') })
  const second = writeTray({ bandeja, chats: chatsFixture(), allow, now: new Date('2026-10-06T12:00:00Z') })
  assert.ok(first.messages > 0 && second.messages > 0)
  const batches = lotes(bandeja, '573001112233@s.whatsapp.net')
  assert.equal(batches.length, 2)
  for (const batch of batches) {
    assert.ok(fs.readFileSync(path.join(batch, 'chat.txt'), 'utf8').length > 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(batch, 'lote.json'))).mensajes, 5)
  }
})

test('chat folders and attachments remain isolated by lower-case JID hash', () => {
  const bandeja = tmp()
  const a = '120363000000000010@g.us'
  const b = '120363000000000011@g.us'
  const chats = [
    { jid: a, nombre: 'Proyecto', es_grupo: true, mensajes: [{ ts: 1710000000, author: 'A', text: '', attachment: { kind: 'document', fileName: 'acta.pdf', data: Buffer.from('A') } }] },
    { jid: b, nombre: 'proyecto', es_grupo: true, mensajes: [{ ts: 1710000060, author: 'B', text: '', attachment: { kind: 'document', fileName: 'acta.pdf', data: Buffer.from('B') } }] },
  ]
  const allow = parseAllowList([a, b])
  const stats = writeTray({ bandeja, chats, allow, now: new Date('2026-10-06T12:00:00Z') })
  assert.ok(stats.messages > 0)
  assert.notEqual(chatIdForJid(a), chatIdForJid(b))
  for (const [jid, expected] of [[a, 'A'], [b, 'B']]) {
    const chatDir = path.join(bandeja, chatIdForJid(jid))
    const meta = JSON.parse(fs.readFileSync(path.join(chatDir, 'chat.json')))
    assert.deepEqual(meta, { jid, nombre: jid === a ? 'Proyecto' : 'proyecto', tipo: 'grupo' })
    const batch = lotes(bandeja, jid)[0]
    assert.equal(fs.readFileSync(path.join(batch, '00000001-acta.pdf'), 'utf8'), expected)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(batch, '00000001-acta.pdf'))).digest('hex'), crypto.createHash('sha256').update(expected).digest('hex'))
  }
})

test('a residual connector temp does not break the next run', () => {
  const bandeja = tmp()
  fs.mkdirSync(path.join(bandeja, '.tmp', '123-1'), { recursive: true })
  fs.writeFileSync(path.join(bandeja, '.tmp', '123-1', 'leftover'), 'stale')
  const allow = parseAllowList(['573001112233@s.whatsapp.net'])
  const stats = writeTray({ bandeja, chats: chatsFixture(), allow, now: new Date('2026-10-06T12:00:00Z') })
  assert.ok(stats.messages > 0)
  assert.deepEqual(fs.readdirSync(path.join(bandeja, '.tmp')), [])
})

test('an empty allow-list exports no chats (only the contract marker)', () => {
  const bandeja = tmp()
  const stats = writeTray({ bandeja, chats: chatsFixture(), allow: new Set() })
  assert.equal(stats.messages, 0)
  assert.equal(stats.chatsWritten, 0)
  assert.ok(fs.existsSync(path.join(bandeja, 'contrato.json')))
  assert.deepEqual(fs.readdirSync(bandeja).filter((f) => /^[0-9a-f]{16}$/.test(f)), [])
})

test('isAllowed normalises case and whitespace', () => {
  const allow = parseAllowList(['573001112233@s.whatsapp.net'])
  assert.ok(isAllowed(' 573001112233@s.whatsapp.net ', allow))
  assert.equal(filterAllowed(chatsFixture(), allow).length, 1)
})
