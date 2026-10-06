import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { rmrf } from '../lib/fsutil.mjs'

test('uninstall removal retries realistic EPERM/EBUSY before declaring success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rm-'))
  const target = path.join(root, 'state')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'state.json'), '{}')
  let attempts = 0
  rmrf(target, {
    remove: (name, options) => {
      attempts += 1
      if (attempts === 1 || attempts === 2) {
        const err = new Error(attempts === 1 ? 'permission denied' : 'busy')
        err.code = attempts === 1 ? 'EPERM' : 'EBUSY'
        throw err
      }
      fs.rmSync(name, options)
    },
  })
  assert.equal(attempts, 3)
  assert.equal(fs.existsSync(target), false)
})
