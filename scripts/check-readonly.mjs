#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Assert that a Windows artifact cannot send.
 *
 *   node scripts/check-readonly.mjs <artifact.zip>   → 0 clean, 1 violation
 *
 * Match System 3's static rules for every connector-owned file, including
 * comments. Dependency files are checked through their SHA-256 manifest.
 *
 * A missing connector or Baileys is also a failure: an empty archive must not
 * pass as "clean" by having nothing to find.
 */
import fs from 'fs'
import crypto from 'crypto'
import { readZip } from './lib/zip.mjs'

const FORBIDDEN_FILE = /(^|\/)send(?:[-_].*)?\.(?:js|mjs|cjs)$/i
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'dobles', 'doble', 'fixtures'])
const TEST_FILE = /(?:\.(?:test|spec)\.[^.]+$|doble|double|fake|mock)/i
const FORBIDDEN_CONTENT = [
  { label: 'whatsapp_send', re: /whatsapp_send/ },
  { label: 'WA_WIN_ADAPTER', re: /WA_WIN_ADAPTER/ },
  { label: 'comando_send', re: /\bprocess\s*\.\s*send\b|(["'`])send\1/ },
  { label: 'sendMessage', re: /\bsendMessage\s*\(/ },
]
const DYNAMIC_LOAD = /\b(?:import|require)\s*\(\s*([^)]*)\)/gs
const LITERAL_SPECIFIER = /^\s*(["'])[^"'`$]*\1\s*$/
const PROCESS_ENV = /\bprocess\s*\.\s*env\b/
const REQUIRED = ['win/cli.mjs', 'package.json']
const REQUIRED_PREFIX = 'node_modules/@whiskeysockets/baileys/'
const MANIFEST = 'node_modules/.readonly-manifest.sha256'
const PACKAGE_MANIFEST = 'node_modules/.readonly-packages.json'

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function verifyDependencyManifest(entries, findings) {
  const manifest = entries.find((entry) => entry.name === MANIFEST)
  if (!manifest) {
    findings.push(`missing required entry: ${MANIFEST}`)
    return
  }
  const listed = new Map()
  for (const line of manifest.data.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/i)
    if (!match || listed.has(match[2])) {
      findings.push(`invalid dependency manifest line: ${line}`)
      continue
    }
    listed.set(match[2], match[1].toLowerCase())
  }
  const actual = new Map(entries
    .filter((entry) => entry.name.startsWith('node_modules/') && entry.name !== MANIFEST)
    .map((entry) => [entry.name.slice('node_modules/'.length), sha256(entry.data)]))
  for (const [name, digest] of actual) {
    if (listed.get(name) !== digest) findings.push(`dependency hash mismatch: ${name}`)
  }
  for (const name of listed.keys()) {
    if (!actual.has(name)) findings.push(`dependency missing from archive: ${name}`)
  }
}

function verifyPackageManifest(entries, findings) {
  const manifest = entries.find((entry) => entry.name === PACKAGE_MANIFEST)
  if (!manifest) {
    findings.push(`missing required entry: ${PACKAGE_MANIFEST}`)
    return
  }

  let parsed
  try {
    parsed = JSON.parse(manifest.data.toString('utf8'))
  } catch (err) {
    findings.push(`invalid package manifest: ${err.message}`)
    return
  }
  if (parsed.schema !== 1 || !Array.isArray(parsed.packages) || !Array.isArray(parsed.roots)) {
    findings.push(`invalid package manifest: expected schema 1, roots and packages`)
    return
  }

  const allowed = new Map()
  for (const item of parsed.packages) {
    if (!item || typeof item.path !== 'string' || !item.path || allowed.has(item.path)) {
      findings.push(`invalid package manifest entry: ${JSON.stringify(item)}`)
      continue
    }
    allowed.set(item.path, item)
  }

  const controlFiles = new Set([PACKAGE_MANIFEST, MANIFEST])
  const packageRoots = (file) => {
    const parts = file.split('/')
    const roots = []
    const endOfPackageName = (index) => parts[index]?.startsWith('@') ? index + 2 : index + 1
    let end = endOfPackageName(0)
    roots.push(parts.slice(0, end).join('/'))
    for (let i = end; i < parts.length; i++) {
      if (parts[i] !== 'node_modules' || i + 1 >= parts.length) continue
      end = endOfPackageName(i + 1)
      roots.push(parts.slice(0, end).join('/'))
      i = end - 1
    }
    return roots
  }

  const dependencyFiles = entries
    .filter((entry) => entry.name.startsWith('node_modules/'))
    .map((entry) => entry.name.slice('node_modules/'.length))
    .filter((name) => !controlFiles.has(`node_modules/${name}`))

  for (const file of dependencyFiles) {
    for (const pkg of packageRoots(file)) {
      if (!allowed.has(pkg)) findings.push(`dependency outside production closure: ${file}`)
    }
  }

  for (const [pkgPath, item] of allowed) {
    const packageFile = entries.find((entry) => entry.name === `node_modules/${pkgPath}/package.json`)
    if (!packageFile) {
      findings.push(`package missing from archive: ${pkgPath}`)
      continue
    }
    try {
      const packageJson = JSON.parse(packageFile.data.toString('utf8'))
      if (packageJson.name !== item.name || packageJson.version !== item.version) {
        findings.push(`package manifest mismatch: ${pkgPath}`)
      }
    } catch (err) {
      findings.push(`invalid package.json: ${pkgPath} (${err.message})`)
    }
  }
}

export function checkReadonly(zipPath) {
  const buf = Buffer.isBuffer(zipPath) ? zipPath : fs.readFileSync(zipPath)
  const entries = readZip(buf)
  const findings = []

  if (entries.length === 0) findings.push('archive has no entries — nothing was verified')

  const owned = entries.filter((e) => !e.name.startsWith('node_modules/'))
  for (const e of owned) {
    const parts = e.name.split('/')
    if (FORBIDDEN_FILE.test(parts.at(-1))) findings.push(`forbidden file: ${e.name}`)
    if (parts.slice(0, -1).some((part) => TEST_DIRS.has(part.toLowerCase())) || TEST_FILE.test(parts.at(-1))) {
      findings.push(`test entry: ${e.name}`)
    }
    // Latin-1 preserves byte values, matching the product's byte-level scan.
    const text = e.data.toString('latin1')
    for (const { label, re } of FORBIDDEN_CONTENT) {
      if (re.test(text)) findings.push(`${label} in ${e.name}`)
    }
    for (const match of text.matchAll(DYNAMIC_LOAD)) {
      if (PROCESS_ENV.test(match[1]) || (!LITERAL_SPECIFIER.test(match[1]) && PROCESS_ENV.test(text))) {
        findings.push(`carga_entorno in ${e.name}`)
        break
      }
    }
  }

  for (const req of REQUIRED) {
    if (!entries.some((e) => e.name === req)) findings.push(`missing required entry: ${req}`)
  }
  if (!entries.some((e) => e.name.startsWith(REQUIRED_PREFIX))) {
    findings.push(`missing required entry: ${REQUIRED_PREFIX}`)
  }
  verifyPackageManifest(entries, findings)
  verifyDependencyManifest(entries, findings)

  return { ok: findings.length === 0, findings, count: entries.length }
}

function main() {
  const zipPath = process.argv[2]
  if (!zipPath) {
    process.stderr.write('usage: node scripts/check-readonly.mjs <artifact.zip>\n')
    process.exit(2)
  }
  let result
  try {
    result = checkReadonly(zipPath)
  } catch (err) {
    process.stderr.write(`check-readonly: ${err.message}\n`)
    process.exit(1)
  }
  if (result.ok) {
    process.stdout.write(`read-only: OK (${result.count} entries, no send surface)\n`)
    process.exit(0)
  }
  process.stdout.write(`read-only: VIOLATION (${result.findings.length})\n`)
  for (const f of result.findings) process.stdout.write(`  - ${f}\n`)
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('check-readonly.mjs')) main()
