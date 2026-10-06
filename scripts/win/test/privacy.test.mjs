import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createAdapter, doubleMetrics } from './doubles/baileys-double.mjs'
import { statePaths } from '../lib/paths.mjs'

const CLI = fileURLToPath(new URL('./cli-con-doble.mjs', import.meta.url))

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function run(args, { mode = 'unlinked', state } = {}) {
  const env = { ...process.env, WA_DOUBLE_MODE: mode, WA_WIN_STATE: state }
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
}

test('sync passes the allow-list to the adapter before mapping or downloading', async () => {
  const paths = statePaths(tmp('wa-privacy-state-'))
  const adapter = await createAdapter({ env: { WA_DOUBLE_MODE: 'ok' }, paths })
  const chats = await adapter.fetchChats({ allow: new Set(['573001112233@s.whatsapp.net', '120363000000000001@g.us']) })
  assert.ok(chats.length > 0)
  assert.equal(chats.some((chat) => chat.nombre === 'No permitido'), false)
  assert.equal(doubleMetrics.mappedMessages, 6, 'only allowed messages may be mapped')
  assert.equal(doubleMetrics.downloadCalls, 1, 'the disallowed PDF must never be downloaded')
})

test('link QR and pairing-code paths purge pair material on success and failure', () => {
  const successState = tmp('wa-link-qr-')
  const success = run(['link', '--qr'], { state: successState })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(success.stdout.trim().split('\n').length, 1)
  const successPayload = JSON.parse(success.stdout)
  assert.equal('qr_png' in successPayload, false)
  assert.equal(fs.existsSync(path.join(successState, '.pair')), false)
  assert.deepEqual(fs.readdirSync(successState).sort(), ['state.json'], 'link must not persist history or attachments')

  for (const mode of ['qr-error', 'qr-timeout']) {
    const state = tmp(`wa-link-${mode}-`)
    const failed = run(['link', '--qr'], { mode, state })
    assert.notEqual(failed.status, 0)
    assert.equal(fs.existsSync(path.join(state, '.pair')), false, `${mode} must purge QR files`)
  }

  const codeState = tmp('wa-link-code-')
  const code = run(['link', '--code', '+573001112233'], { state: codeState })
  assert.equal(code.status, 0, code.stderr)
  const codePayload = JSON.parse(code.stdout)
  assert.equal(codePayload.codigo_emparejamiento, '1234-5678')
  assert.equal(code.stdout.trim().split('\n').length, 1)
  assert.equal(fs.existsSync(path.join(codeState, '.pair')), false)
})
