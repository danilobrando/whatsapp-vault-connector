import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { readZip, writeZip } from '../lib/zip.mjs'
import { checkReadonly } from '../check-readonly.mjs'
import { calculateProductionClosure } from '../build-win-readonly.mjs'

const BUILD = fileURLToPath(new URL('../build-win-readonly.mjs', import.meta.url))

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function build(out) {
  const result = spawnSync(process.execPath, [BUILD, '--out', out], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const match = result.stdout.match(/out:\s+(.*)$/m)
  assert.ok(match, result.stdout)
  return { file: match[1].trim(), output: result.stdout }
}

function entry(entries, name) {
  const found = entries.find((item) => item.name === name)
  assert.ok(found, `missing ${name}`)
  return found
}

function extract(zip, dir) {
  for (const item of readZip(fs.readFileSync(zip))) {
    const target = path.join(dir, ...item.name.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, item.data)
  }
}

test('Windows ZIP contains exactly the calculated production closure', () => {
  const output = tmp('wa-build-')
  const { file } = build(output)
  const entries = readZip(fs.readFileSync(file))
  const closure = calculateProductionClosure()
  const manifest = JSON.parse(entry(entries, 'node_modules/.readonly-packages.json').data)

  assert.deepEqual(manifest.roots, closure.roots)
  assert.deepEqual(manifest.packages, closure.packages.map(({ rel, packageJson }) => ({
    path: rel,
    name: packageJson.name,
    version: packageJson.version,
  })))
  assert.equal(entries.some(({ name }) => name.startsWith('node_modules/@modelcontextprotocol/')), false)
  assert.equal(entries.some(({ name }) => name.startsWith('node_modules/express/')), false)
  assert.equal(entries.some(({ name }) => name.startsWith('node_modules/proxy-addr/')), false)

  const packageJson = JSON.parse(entry(entries, 'package.json').data)
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), closure.roots)
  assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], undefined)
  assert.equal(checkReadonly(file).ok, true)
})

test('package-membership verification rejects an injected package', () => {
  const output = tmp('wa-build-injected-')
  const { file } = build(output)
  const entries = readZip(fs.readFileSync(file))
  const injected = writeZip([
    ...entries,
    { name: 'node_modules/not-in-closure/package.json', data: Buffer.from('{"name":"not-in-closure","version":"1.0.0"}\n') },
  ])
  const injectedFile = path.join(output, 'injected.zip')
  fs.writeFileSync(injectedFile, injected)
  const result = checkReadonly(injectedFile)
  assert.equal(result.ok, false)
  assert.match(result.findings.join('\n'), /outside production closure: not-in-closure\/package\.json/)
})

test('built ZIP passes the CLI version smoke test', () => {
  const output = tmp('wa-build-smoke-')
  const { file } = build(output)
  const extracted = path.join(output, 'extracted')
  fs.mkdirSync(extracted)
  extract(file, extracted)
  const result = spawnSync(process.execPath, ['win/cli.mjs', 'version'], {
    cwd: extracted,
    env: { ...process.env, HOME: path.join(extracted, 'home') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim().split('\n').length, 1)
  assert.deepEqual(JSON.parse(result.stdout), { version: '3.0.0', contrato_bandeja: 1, readonly: true })
})

test('two independent Windows builds have the same SHA-256', () => {
  const first = build(tmp('wa-build-a-')).file
  const second = build(tmp('wa-build-b-')).file
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  assert.equal(digest(first), digest(second))
})
