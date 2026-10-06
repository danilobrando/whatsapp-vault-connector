/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

import fs from 'fs'
import path from 'path'

let tempSequence = 0

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function nextTempName() {
  tempSequence += 1
  return `${process.pid}-${tempSequence}`
}

/** Remove only connector-owned batch directories, never arbitrary state. */
export function cleanScopedTemps(root) {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+-\d+$/.test(entry.name)) continue
      rmrf(path.join(root, entry.name))
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

/**
 * Write via a sibling temp file and a rename. rename(2) within a directory is
 * atomic on both NTFS and POSIX, so a reader (the product's importer) sees the
 * previous complete file or the new complete file, never a truncated one. The
 * tray is re-read by another process while we write; a half-written chat file
 * would be imported as a truncated conversation.
 */
export function writeFileAtomic(file, data, { tempRoot = null } = {}) {
  const dir = path.dirname(file)
  ensureDir(dir)

  if (tempRoot) {
    ensureDir(tempRoot)
    cleanScopedTemps(tempRoot)
    const work = path.join(tempRoot, nextTempName())
    const tmp = path.join(work, path.basename(file))
    try {
      ensureDir(work)
      fs.writeFileSync(tmp, data)
      fs.renameSync(tmp, file)
    } finally {
      rmrf(work)
    }
    return
  }

  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${nextTempName()}`)
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJsonAtomic(file, value, options = {}) {
  // Trailing newline keeps diffs and editors honest.
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', options)
}

export function exists(file) {
  try { fs.accessSync(file); return true } catch { return false }
}

export function rmrf(target, { remove = fs.rmSync, maxRetries = 5 } = {}) {
  let attempts = 0
  while (true) {
    try {
      remove(target, { recursive: true, force: true, maxRetries, retryDelay: 50 })
      return
    } catch (err) {
      attempts += 1
      if (!['EPERM', 'EBUSY'].includes(err.code) || attempts >= maxRetries) throw err
    }
  }
}
