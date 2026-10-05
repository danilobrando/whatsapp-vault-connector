import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeZip } from '../lib/zip.mjs'
import { checkReadonly } from '../check-readonly.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ro-'))
}

const CLEAN = [
  { name: 'win/cli.mjs', data: Buffer.from('export const cli = 1\n') },
  { name: 'win/lib/adapter.mjs', data: Buffer.from('export async function createAdapter() {}\n') },
  { name: 'package.json', data: Buffer.from('{"version":"3.0.0"}\n') },
  // Baileys itself defines sendMessage; the content scan is scoped so this is fine.
  { name: 'node_modules/@whiskeysockets/baileys/lib/index.js', data: Buffer.from('function sendMessage(jid, msg) {}\n') },
]

function zipTo(entries) {
  const file = path.join(tmp(), 'artifact.zip')
  fs.writeFileSync(file, writeZip(entries))
  return file
}

test('passes a clean read-only artifact', () => {
  const result = checkReadonly(zipTo(CLEAN))
  assert.equal(result.ok, true, result.findings.join('; '))
  assert.ok(result.count > 0)
})

test('fails when send.mjs is injected (negative test)', () => {
  const file = zipTo([...CLEAN, { name: 'win/send.mjs', data: Buffer.from('export function send() {}\n') }])
  const result = checkReadonly(file)
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /forbidden file: win\/send\.mjs/)
})

test('fails when the connector gains a reachable sendMessage call', () => {
  const file = zipTo([...CLEAN, { name: 'win/lib/leak.mjs', data: Buffer.from('await sock.sendMessage(jid, { text })\n') }])
  const result = checkReadonly(file)
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /sendMessage/)
})

test('fails when the whatsapp_send tool or IPC send reappears', () => {
  const file = zipTo([...CLEAN, { name: 'win/lib/mcp.mjs', data: Buffer.from('const name = "whatsapp_send"\nconst cmd = { cmd: "send" }\n') }])
  const result = checkReadonly(file)
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /whatsapp_send|IPC send/)
})

test('fails on an empty archive instead of passing vacuously', () => {
  const result = checkReadonly(zipTo([]))
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /no entries|missing required/)
})
