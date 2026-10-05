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
import { readZip } from './lib/zip.mjs'

const FORBIDDEN_FILE = /(^|\/)send[a-z-]*\.mjs$/i
const FORBIDDEN_CONTENT = [
  { label: 'whatsapp_send tool', re: /whatsapp_send/ },
  { label: 'IPC send command', re: /["']?cmd["']?\s*:\s*["']send["']/ },
  { label: 'reachable sendMessage(', re: /sendMessage\s*\(/ },
]
const REQUIRED = ['win/cli.mjs', 'package.json']
const REQUIRED_PREFIX = 'node_modules/@whiskeysockets/baileys/'

export function checkReadonly(zipPath) {
  const buf = fs.readFileSync(zipPath)
  const entries = readZip(buf)
  const findings = []

  if (entries.length === 0) findings.push('archive has no entries — nothing was verified')

  for (const e of entries) {
    if (FORBIDDEN_FILE.test(e.name)) findings.push(`forbidden file: ${e.name}`)
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
