#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Build `whatsapp-connector-win-readonly-v3.0.0.zip`.
 *
 * The artifact is what the product's launcher downloads onto a Windows 11
 * machine with no administrator: portable Node (documented in
 * `windows/NODE-VERSION`) plus this read-only connector and its already-resolved
 * production dependencies. `sharp` is excluded — it is a peer dependency Baileys
 * only needs for media it does not use here, and shipping it would drag in
 * native binaries for no reason.
 *
 * Reproducibility is a feature: entries are sorted, timestamps fixed and stored
 * uncompressed, so two builds of the same tree hash identically. If that ever
 * breaks, the build says so instead of quietly producing a new hash.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { writeZip } from './lib/zip.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..') // repository root
const SCRIPTS = path.join(ROOT, 'scripts')

const EXCLUDE_DIRS = new Set(['sharp', '.bin', '.cache'])
const EXCLUDE_PREFIX = ['@img']
const FORBIDDEN_FILE = /(^|\/)send[a-z-]*\.mjs$/i

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      if (EXCLUDE_PREFIX.some((p) => rel === p || rel.startsWith(p + '/'))) continue
      walk(full, base, out)
    } else if (entry.isFile()) {
      if (FORBIDDEN_FILE.test(rel)) continue
      out.push({ rel, full })
    }
  }
  return out
}

function collect() {
  const entries = []

  // Connector source (kept under win/ so its relative imports resolve).
  for (const f of walk(path.join(SCRIPTS, 'win'))) entries.push({ name: `win/${f.rel}`, full: f.full })
  // The atomic auth writer the adapter reuses, and the package manifest.
  entries.push({ name: 'atomic-auth-state.mjs', full: path.join(SCRIPTS, 'atomic-auth-state.mjs') })
  entries.push({ name: 'package.json', full: path.join(SCRIPTS, 'package.json') })
  // Portable Node version contract.
  const nodeVersion = path.join(ROOT, 'windows', 'NODE-VERSION')
  if (fs.existsSync(nodeVersion)) entries.push({ name: 'NODE-VERSION', full: nodeVersion })
  // Production dependencies, minus the excluded native peer.
  for (const f of walk(path.join(SCRIPTS, 'node_modules'))) {
    if (FORBIDDEN_FILE.test(f.rel)) continue
    entries.push({ name: `node_modules/${f.rel}`, full: f.full })
  }
  return entries
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'package.json'), 'utf8'))
  const version = pkg.version
  const outDir = arg('--out', path.join(ROOT, 'windows'))
  const name = `whatsapp-connector-win-readonly-v${version}.zip`
  const outFile = path.join(outDir, name)

  const files = collect().map((e) => ({ name: e.name, data: fs.readFileSync(e.full) }))
  const zip = writeZip(files)

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outFile, zip)
  const sha = crypto.createHash('sha256').update(zip).digest('hex')
  fs.writeFileSync(`${outFile}.sha256`, `${sha}  ${name}\n`)

  process.stdout.write(`built ${name}\n`)
  process.stdout.write(`  files:  ${files.length}\n`)
  process.stdout.write(`  bytes:  ${zip.length}\n`)
  process.stdout.write(`  sha256: ${sha}\n`)
  process.stdout.write(`  out:    ${outFile}\n`)
}

main()
