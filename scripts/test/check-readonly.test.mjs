import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
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
  { name: 'node_modules/@whiskeysockets/baileys/package.json', data: Buffer.from('{"name":"@whiskeysockets/baileys","version":"6.7.24"}\n') },
  { name: 'node_modules/ws/package.json', data: Buffer.from('{"name":"ws","version":"8.22.0"}\n') },
  {
    name: 'node_modules/.readonly-packages.json',
    data: Buffer.from(JSON.stringify({
      schema: 1,
      roots: ['@whiskeysockets/baileys', 'ws'],
      packages: [
        { path: '@whiskeysockets/baileys', name: '@whiskeysockets/baileys', version: '6.7.24' },
        { path: 'ws', name: 'ws', version: '8.22.0' },
      ],
    }) + '\n'),
  },
  // Baileys itself defines sendMessage; the content scan is scoped so this is fine.
  { name: 'node_modules/@whiskeysockets/baileys/lib/index.js', data: Buffer.from('function sendMessage(jid, msg) {}\n') },
  // Legitimate third-party sender*.js files are positive cases, not violations.
  { name: 'node_modules/ws/lib/sender.js', data: Buffer.from('class Sender {}\n') },
  { name: 'node_modules/ws/lib/sender-queue.js', data: Buffer.from('export const senderQueue = true\n') },
]

function withManifest(entries) {
  const lines = entries
    .filter((entry) => entry.name.startsWith('node_modules/'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${crypto.createHash('sha256').update(entry.data).digest('hex')}  ${entry.name.slice('node_modules/'.length)}`)
  return [...entries, { name: 'node_modules/.readonly-manifest.sha256', data: Buffer.from(lines.join('\n') + '\n') }]
}

function zipTo(entries) {
  const file = path.join(tmp(), 'artifact.zip')
  fs.writeFileSync(file, writeZip(withManifest(entries)))
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

test('fails on each forbidden production filename extension', () => {
  for (const name of ['win/send.js', 'win/send-helper.cjs', 'win/send_helper.mjs']) {
    const result = checkReadonly(zipTo([...CLEAN, { name, data: Buffer.from('export const forbidden = true\n') }]))
    assert.equal(result.ok, false, name)
    assert.match(result.findings.join('\n'), /forbidden file/)
  }
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

test('fails when the test-only adapter hook reappears in production', () => {
  const file = zipTo([...CLEAN, { name: 'win/lib/hook.mjs', data: Buffer.from('const hook = "WA_WIN_ADAPTER"\n') }])
  const result = checkReadonly(file)
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /WA_WIN_ADAPTER/)
})

test('fails when a dependency outside the calculated closure is injected', () => {
  const file = zipTo([...CLEAN,
    { name: 'node_modules/not-in-closure/package.json', data: Buffer.from('{"name":"not-in-closure","version":"1.0.0"}\n') },
    { name: 'node_modules/not-in-closure/index.js', data: Buffer.from('export const injected = true\n') },
  ])
  const result = checkReadonly(file)
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /outside production closure: not-in-closure\/package\.json/)
})

test('fails on an empty archive instead of passing vacuously', () => {
  const result = checkReadonly(zipTo([]))
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /no entries|missing required/)
})
