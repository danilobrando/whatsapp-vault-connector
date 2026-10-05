import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const ADAPTER = new URL('./doubles/baileys-double.mjs', import.meta.url).href

function run(args, { mode = 'ok', state, env = {} } = {}) {
  const merged = { ...process.env, WA_WIN_ADAPTER: ADAPTER, WA_DOUBLE_MODE: mode, ...env }
  if (state) merged.WA_WIN_STATE = state
  return spawnSync(process.execPath, [CLI, ...args], { env: merged, encoding: 'utf8' })
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeAllow(file, jids) {
  fs.writeFileSync(file, JSON.stringify({ jids }, null, 2))
}

test('version reports the tray contract without a session', () => {
  const res = run(['version'])
  assert.equal(res.status, 0, res.stderr)
  const payload = JSON.parse(res.stdout)
  assert.deepEqual(payload, { version: '3.0.0', contrato_bandeja: 1, readonly: true })
})

test('allow --set then chats --json returns only permitted chats', () => {
  const state = tmp('wa-cli-')
  const allowFile = path.join(state, 'input.json')
  writeAllow(allowFile, ['573001112233@s.whatsapp.net', '120363000000000001@g.us'])

  const allow = run(['allow', '--set', allowFile], { state })
  assert.equal(allow.status, 0, allow.stderr)
  assert.equal(JSON.parse(allow.stdout).count, 2)

  const chats = run(['chats', '--json'], { state })
  assert.equal(chats.status, 0, chats.stderr)
  const list = JSON.parse(chats.stdout)
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((c) => c.nombre).sort(), ['Ana', 'Equipo'])
  assert.ok(list[0].ultimos_mensajes.length > 0, 'expected messages to be returned')
})

test('sync-once writes the tray, the document and contrato.json', () => {
  const state = tmp('wa-cli-')
  const bandeja = tmp('wa-bandeja-')
  const allowFile = path.join(state, 'input.json')
  writeAllow(allowFile, ['573001112233@s.whatsapp.net', '120363000000000001@g.us'])
  assert.equal(run(['allow', '--set', allowFile], { state }).status, 0)

  const res = run(['sync-once', '--bandeja', bandeja], { state })
  assert.equal(res.status, 0, res.stderr)
  const stats = JSON.parse(res.stdout)
  assert.ok(stats.messages > 0, 'expected messages to be processed')

  assert.ok(fs.existsSync(path.join(bandeja, 'Ana.txt')))
  assert.ok(fs.existsSync(path.join(bandeja, '00000001-presupuesto.pdf')))
  assert.ok(fs.existsSync(path.join(bandeja, 'contrato.json')))
  assert.ok(!fs.existsSync(path.join(bandeja, 'No permitido.txt')))

  const status = run(['status', '--json'], { state })
  assert.equal(status.status, 0, status.stderr)
  const parsed = JSON.parse(status.stdout)
  assert.equal(parsed.vinculado, true)
  assert.ok(parsed.ultima_sync, 'sync must be recorded')
  assert.equal(parsed.pendientes, 0)
})

test('logout clears the session; uninstall --yes removes state but not the tray', () => {
  const state = tmp('wa-cli-')
  const bandeja = tmp('wa-bandeja-')
  fs.writeFileSync(path.join(bandeja, 'keep.txt'), 'do not touch')

  const logout = run(['logout'], { state })
  assert.equal(logout.status, 0, logout.stderr)
  assert.equal(JSON.parse(logout.stdout).vinculado, false)

  const uninstall = run(['uninstall', '--yes'], { state })
  assert.equal(uninstall.status, 0, uninstall.stderr)
  assert.ok(!fs.existsSync(state), 'state dir must be removed')
  assert.ok(fs.existsSync(path.join(bandeja, 'keep.txt')), 'tray must be untouched')
})
