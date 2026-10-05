import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeZip, readZip, listZip, crc32 } from '../lib/zip.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-zip-'))
}

test('round-trips entries through write/read', () => {
  const zip = writeZip([
    { name: 'b.txt', data: Buffer.from('second') },
    { name: 'a.txt', data: Buffer.from('first') },
  ])
  const entries = readZip(zip)
  assert.deepEqual(listZip(zip), ['a.txt', 'b.txt'])
  assert.equal(entries.find((e) => e.name === 'a.txt').data.toString(), 'first')
})

test('is byte-identical regardless of input order (reproducible)', () => {
  const a = writeZip([{ name: 'b', data: Buffer.from('2') }, { name: 'a', data: Buffer.from('1') }])
  const b = writeZip([{ name: 'a', data: Buffer.from('1') }, { name: 'b', data: Buffer.from('2') }])
  assert.ok(a.equals(b), 'same tree must produce the same bytes')
})

test('crc32 matches a known value', () => {
  // crc32("123456789") = 0xCBF43926
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('rejects a non-zip buffer', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')))
})
