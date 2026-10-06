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
 * The guarantee is structural, not a promise: no `send*.mjs`, no IPC `send`, no
 * `whatsapp_send` tool and no reachable `sendMessage(` in the connector's own
 * code. Third-party libraries (Baileys itself) legitimately contain
 * `sendMessage`, so the content scan is scoped to connector-owned files while
 * the file-name scan covers the whole archive — an injected `send.mjs` anywhere
 * fails, which is exactly the negative test.
 *
 * A missing connector or Baileys is also a failure: an empty archive must not
 * pass as "clean" by having nothing to find.
 */
import fs from 'fs'
import crypto from 'crypto'
import { readZip } from './lib/zip.mjs'

const FORBIDDEN_FILE = /(^|\/)send(?:[-_].+)?\.(?:js|mjs|cjs)$/i
const FORBIDDEN_CONTENT = [
  { label: 'whatsapp_send tool', re: /whatsapp_send/ },
  { label: 'WA_WIN_ADAPTER hook', re: /WA_WIN_ADAPTER/ },
  { label: 'IPC send command', re: /["']?cmd["']?\s*:\s*["']send["']/ },
  { label: 'reachable sendMessage(', re: /sendMessage\s*\(/ },
]
const REQUIRED = ['win/cli.mjs', 'package.json']
const REQUIRED_PREFIX = 'node_modules/@whiskeysockets/baileys/'
const MANIFEST = 'node_modules/.readonly-manifest.sha256'

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

export function checkReadonly(zipPath) {
  const buf = fs.readFileSync(zipPath)
  const entries = readZip(buf)
  const findings = []

  if (entries.length === 0) findings.push('archive has no entries — nothing was verified')

  for (const e of entries) {
    if (!e.name.startsWith('node_modules/') && FORBIDDEN_FILE.test(e.name)) {
      findings.push(`forbidden file: ${e.name}`)
    }
  }

  const owned = entries.filter((e) => !e.name.startsWith('node_modules/'))
  for (const e of owned) {
    if (!/\.(mjs|cjs|js|json|sh|ps1|txt|md)$/i.test(e.name)) continue
    const text = e.data.toString('utf8')
    for (const { label, re } of FORBIDDEN_CONTENT) {
      if (re.test(text)) findings.push(`${label} in ${e.name}`)
    }
  }

  for (const req of REQUIRED) {
    if (!entries.some((e) => e.name === req)) findings.push(`missing required entry: ${req}`)
  }
  if (!entries.some((e) => e.name.startsWith(REQUIRED_PREFIX))) {
    findings.push(`missing required entry: ${REQUIRED_PREFIX}`)
  }
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
