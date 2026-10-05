import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseAllowList, filterAllowed, isAllowed } from '../lib/allowlist.mjs'
import { writeTray } from '../lib/tray.mjs'
import { chatsFixture } from './doubles/baileys-double.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-allow-'))
}

test('parses array, object and whitespace allow-lists', () => {
  assert.equal(parseAllowList(['a@s.whatsapp.net']).size, 1)
  assert.equal(parseAllowList('{"jids":["a","b"]}').size, 2)
  assert.equal(parseAllowList('a\nb c').size, 3)
})

test('a group that is not allowed is not written; an allowed one is', () => {
  const bandeja = tmp()
  const allow = parseAllowList(['573001112233@s.whatsapp.net', '120363000000000001@g.us'])
  const stats = writeTray({ bandeja, chats: chatsFixture(), allow, tz: 'America/Bogota' })

  assert.ok(stats.messages > 0, 'expected messages to be processed')
  assert.equal(stats.chatsWritten, 2)

  assert.ok(fs.existsSync(path.join(bandeja, 'Ana.txt')), 'allowed individual must be written')
  assert.ok(fs.existsSync(path.join(bandeja, 'Equipo.txt')), 'allowed group must be written')
  assert.ok(!fs.existsSync(path.join(bandeja, 'No permitido.txt')), 'disallowed group must not be written')
  assert.ok(!fs.existsSync(path.join(bandeja, 'Desconocido.txt')), 'disallowed individual must not be written')

  const ana = fs.readFileSync(path.join(bandeja, 'Ana.txt'), 'utf8')
  assert.match(ana, /<adjunto: 00000001-presupuesto\.pdf>/)
  assert.match(ana, /<adjunto omitido>/)
  assert.ok(fs.existsSync(path.join(bandeja, '00000001-presupuesto.pdf')), 'document must be written beside the chat')

  const contrato = JSON.parse(fs.readFileSync(path.join(bandeja, 'contrato.json'), 'utf8'))
  assert.deepEqual(contrato, { contrato: 1, origen: 'whatsapp-vault-connector', version: '3.0.0' })
})

test('an empty allow-list exports no chats (only the contract marker)', () => {
  const bandeja = tmp()
  const stats = writeTray({ bandeja, chats: chatsFixture(), allow: new Set(), tz: 'America/Bogota' })
  assert.equal(stats.messages, 0)
  assert.equal(stats.chatsWritten, 0)
  assert.ok(fs.existsSync(path.join(bandeja, 'contrato.json')))
  assert.deepEqual(fs.readdirSync(bandeja).filter((f) => f.endsWith('.txt')), [])
})

test('isAllowed normalises case and whitespace', () => {
  const allow = parseAllowList(['573001112233@s.whatsapp.net'])
  assert.ok(isAllowed(' 573001112233@s.whatsapp.net ', allow))
  assert.equal(filterAllowed(chatsFixture(), allow).length, 1)
})
