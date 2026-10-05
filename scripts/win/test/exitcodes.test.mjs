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

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exit-'))
}

test('exit 0 for a healthy command', () => {
  const res = run(['version'])
  assert.equal(res.status, 0)
})

test('exit 2 for usage errors', () => {
  assert.equal(run(['nonsense']).status, 2)
  assert.equal(run(['--bogus', 'version']).status, 2)
  assert.equal(run(['link']).status, 2)
  assert.equal(run(['sync-once'], { state: tmp() }).status, 2, 'missing --bandeja')
  assert.equal(run(['uninstall'], { state: tmp() }).status, 2, 'missing --yes')
})

test('exit 3 when no session is linked', () => {
  const state = tmp()
  assert.equal(run(['chats', '--json'], { mode: 'unlinked', state }).status, 3)
  assert.equal(run(['sync-once', '--bandeja', tmp()], { mode: 'unlinked', state }).status, 3)
})

test('exit 4 when WhatsApp is unreachable', () => {
  const state = tmp()
  const res = run(['chats', '--json'], { mode: 'no-net', state })
  assert.equal(res.status, 4, res.stderr)
})

test('exit 5 when the session is invalid', () => {
  const state = tmp()
  const res = run(['chats', '--json'], { mode: 'bad-session', state })
  assert.equal(res.status, 5, res.stderr)
})

test('exit 10 for an unexpected internal error', () => {
  const state = tmp()
  const res = run(['chats', '--json'], { mode: 'boom', state })
  assert.equal(res.status, 10, res.stderr)
})
