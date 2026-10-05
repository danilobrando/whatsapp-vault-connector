/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

import fs from 'fs'
import path from 'path'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Write via a sibling temp file and a rename. rename(2) within a directory is
 * atomic on both NTFS and POSIX, so a reader (the product's importer) sees the
 * previous complete file or the new complete file, never a truncated one. The
 * tray is re-read by another process while we write; a half-written chat file
 * would be imported as a truncated conversation.
 */
export function writeFileAtomic(file, data) {
  const dir = path.dirname(file)
  ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`)
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJsonAtomic(file, value) {
  // Trailing newline keeps diffs and editors honest.
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

export function exists(file) {
  try { fs.accessSync(file); return true } catch { return false }
}

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}
