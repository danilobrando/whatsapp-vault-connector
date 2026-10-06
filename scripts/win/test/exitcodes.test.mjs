import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const CLI = fileURLToPath(new URL('./cli-con-doble.mjs', import.meta.url))

function run(args, { mode = 'ok', state, env = {} } = {}) {
  const merged = { ...process.env, WA_DOUBLE_MODE: mode, ...env }
  if (state) merged.WA_WIN_STATE = state
  return spawnSync(process.execPath, [CLI, ...args], { env: merged, encoding: 'utf8' })
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exit-'))
}

function assertOneLineJson(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout)
  assert.doesNotThrow(() => JSON.parse(result.stdout))
}

test('exit 0 for a healthy command and stdout is one JSON line', () => {
  const res = run(['version'])
  assert.equal(res.status, 0)
  assertOneLineJson(res)
})

test('exit 2 for usage errors and unknown commands do not create state', () => {
  const state = path.join(tmp(), 'state')
  assert.equal(run(['nonsense', '--state', state]).status, 2)
  assert.equal(run(['version', '--bogus', '--state', state]).status, 2)
  assert.equal(run(['link']).status, 2)
  assert.equal(run(['sync-once'], { state: tmp() }).status, 2)
  assert.equal(run(['uninstall'], { state: tmp() }).status, 2)
  assert.equal(fs.existsSync(state), false, 'usage errors must have no filesystem effect')
})

test('exit 3 when no session is linked', () => {
  const state = tmp()
  assert.equal(run(['chats', '--json'], { mode: 'unlinked', state }).status, 3)
  assert.equal(run(['sync-once', '--bandeja', tmp()], { mode: 'unlinked', state }).status, 3)
})

test('exit 4 for network closures 408 and timeouts', () => {
  const state = tmp()
  assert.equal(run(['chats', '--json'], { mode: 'close-408', state }).status, 4)
  assert.equal(run(['chats', '--json'], { mode: 'no-net', state }).status, 4)
})

test('exit 5 for an invalid 500 session', () => {
  const state = tmp()
  const res = run(['chats', '--json'], { mode: 'close-500', state })
  assert.equal(res.status, 5, res.stderr)
})

test('exit 10 for an unexpected internal error', () => {
  const state = tmp()
  const res = run(['chats', '--json'], { mode: 'boom', state })
  assert.equal(res.status, 10, res.stderr)
})
