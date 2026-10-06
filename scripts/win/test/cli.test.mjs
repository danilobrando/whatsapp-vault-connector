import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { chatIdForJid } from '../lib/tray.mjs'

const CLI = fileURLToPath(new URL('./cli-con-doble.mjs', import.meta.url))

function run(args, { mode = 'ok', state, env = {} } = {}) {
  const merged = { ...process.env, WA_DOUBLE_MODE: mode, ...env }
  if (state) merged.WA_WIN_STATE = state
  return spawnSync(process.execPath, [CLI, ...args], { env: merged, encoding: 'utf8' })
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeAllow(file, jids) {
  fs.writeFileSync(file, JSON.stringify({ jids }, null, 2))
}

function oneJsonLine(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout)
  return JSON.parse(result.stdout)
}

test('version reports the tray contract without a session', () => {
  const res = run(['version'])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(oneJsonLine(res), { version: '3.0.0', contrato_bandeja: 1, readonly: true })
})

test('chats --json returns the complete metadata inventory, regardless of allow-list', () => {
  const state = tmp('wa-cli-state-')
  const input = path.join(tmp('wa-cli-input-'), 'allow.json')
  writeAllow(input, ['573001112233@s.whatsapp.net'])
  assert.equal(run(['allow', '--set', input], { state }).status, 0)

  const chats = run(['chats', '--json'], { state })
  assert.equal(chats.status, 0, chats.stderr)
  const list = oneJsonLine(chats)
  assert.equal(list.length, 4)
  assert.ok(list.every((chat) => Object.keys(chat).sort().join(',') === 'es_grupo,jid,nombre'))
  assert.deepEqual(list.map((c) => c.nombre).sort(), ['Ana', 'Desconocido', 'Equipo', 'No permitido'])
  assert.equal(chats.stderr, '')
})

test('sync-once writes chat metadata, a lote, documents and contrato.json', () => {
  const state = tmp('wa-cli-state-')
  const bandeja = tmp('wa-bandeja-')
  const input = path.join(tmp('wa-cli-input-'), 'allow.json')
  writeAllow(input, ['573001112233@s.whatsapp.net', '120363000000000001@g.us'])
  assert.equal(run(['allow', '--set', input], { state }).status, 0)

  const res = run(['sync-once', '--bandeja', bandeja], { state })
  assert.equal(res.status, 0, res.stderr)
  const stats = oneJsonLine(res)
  assert.ok(stats.messages > 0, 'expected messages to be processed')

  const anaDir = path.join(bandeja, chatIdForJid('573001112233@s.whatsapp.net'))
  const lotes = fs.readdirSync(anaDir).filter((name) => name.startsWith('lote-'))
  assert.equal(lotes.length, 1)
  const lote = path.join(anaDir, lotes[0])
  assert.ok(fs.existsSync(path.join(anaDir, 'chat.json')))
  assert.ok(fs.existsSync(path.join(lote, 'chat.txt')))
  assert.ok(fs.existsSync(path.join(lote, '00000001-presupuesto.pdf')))
  assert.ok(fs.existsSync(path.join(bandeja, 'contrato.json')))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(anaDir, 'chat.json'))), {
    jid: '573001112233@s.whatsapp.net', nombre: 'Ana', tipo: 'individual',
  })
  assert.equal(JSON.parse(fs.readFileSync(path.join(bandeja, 'contrato.json'))).formato_fecha, 'dd/mm/aa')
  assert.ok(!fs.existsSync(path.join(bandeja, chatIdForJid('120363000000000009@g.us'))))

  const status = run(['status', '--json'], { state })
  assert.equal(status.status, 0, status.stderr)
  const parsed = oneJsonLine(status)
  assert.deepEqual(Object.keys(parsed).sort(), ['cuenta_enmascarada', 'pendientes', 'ultima_sync', 'vinculado'])
  assert.equal(parsed.vinculado, true)
  assert.ok(parsed.ultima_sync, 'sync must be recorded')
  assert.equal(parsed.pendientes, 0)
})

test('logout clears the session; uninstall --yes removes only state, not program or tray', () => {
  const state = tmp('wa-cli-state-')
  const bandeja = tmp('wa-bandeja-')
  fs.writeFileSync(path.join(bandeja, 'keep.txt'), 'do not touch')
  fs.writeFileSync(path.join(state, 'program-marker.txt'), 'must survive explicit state cleanup')

  const logout = run(['logout'], { state })
  assert.equal(logout.status, 0, logout.stderr)
  assert.equal(oneJsonLine(logout).vinculado, false)
  assert.ok(fs.existsSync(path.join(state, 'program-marker.txt')))

  const uninstall = run(['uninstall', '--yes'], { state })
  assert.equal(uninstall.status, 0, uninstall.stderr)
  assert.ok(fs.existsSync(path.join(state, 'program-marker.txt')))
  assert.ok(fs.existsSync(path.join(bandeja, 'keep.txt')), 'tray must be untouched')
})

test('run and stop are foreground control commands with one JSON line each', () => {
  const state = tmp('wa-cli-state-')
  const bandeja = tmp('wa-cli-run-')
  const runResult = run(['run', '--bandeja', bandeja], { state })
  assert.equal(runResult.status, 0, runResult.stderr)
  assert.ok(oneJsonLine(runResult).messages > 0)
  const stopResult = run(['stop'], { state })
  assert.equal(stopResult.status, 0, stopResult.stderr)
  assert.equal(oneJsonLine(stopResult).stopRequested, true)
})
