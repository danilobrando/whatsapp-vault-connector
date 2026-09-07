/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Atomic replacement for Baileys' useMultiFileAuthState.
 *
 * Baileys writes the Signal key files with a plain `writeFile`. A crash or a
 * SIGKILL landing between truncate and flush leaves a half-written creds.json
 * or session file, and the only recovery from a corrupt auth store is a full
 * QR re-pair. That is not hypothetical here: the watchdog's job is to kill a
 * wedged daemon, and it had been doing so with SIGKILL over an auth store being
 * rewritten every few minutes.
 *
 * This module owns ONLY the I/O. Credential shape, serialisation and protobuf
 * decoding are still Baileys' own (`initAuthCreds`, `BufferJSON`, `proto`), so
 * an upstream change to the state format does not silently diverge here — and
 * if those imports ever fail, daemon.mjs falls back to the stock
 * implementation rather than refusing to start.
 *
 * Writes go to a sibling temp file and are renamed into place. rename(2) within
 * a directory is atomic, so a reader sees either the previous complete file or
 * the new complete file, never a truncated one.
 */

import { mkdir, readFile, rename, unlink, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { Mutex } from 'async-mutex'
import * as baileys from '@whiskeysockets/baileys'

const { initAuthCreds, BufferJSON } = baileys
// `proto` moved: it is a top-level export up to 6.7.x and lives under `WAProto`
// from 6.17.x on. Resolve it from either rather than pinning this module to one
// version — the whole point of borrowing Baileys' own types is that they keep
// working when Baileys moves.
const proto = baileys.proto ?? baileys.WAProto?.proto ?? baileys.WAProto
if (!proto?.Message?.AppStateSyncKeyData) {
  throw new Error('Cannot locate Baileys proto definitions; refusing to write auth state blindly')
}

const locks = new Map()
const lockFor = (p) => {
  let m = locks.get(p)
  if (!m) { m = new Mutex(); locks.set(p, m) }
  return m
}

// Same mapping Baileys uses, so an existing auth directory keeps working.
const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

export async function useAtomicMultiFileAuthState(folder) {
  const info = await stat(folder).catch(() => undefined)
  if (info && !info.isDirectory()) {
    throw new Error(`${folder} exists and is not a directory`)
  }
  if (!info) await mkdir(folder, { recursive: true, mode: 0o700 })

  const writeData = async (data, file) => {
    const target = join(folder, fixFileName(file))
    const release = await lockFor(target).acquire()
    try {
      const tmp = `${target}.tmp-${process.pid}`
      // mode 0600 explicitly: umask already covers this, but the credential
      // must not depend on the ambient umask being right.
      await writeFile(tmp, JSON.stringify(data, BufferJSON.replacer), { mode: 0o600 })
      await rename(tmp, target)
    } finally {
      release()
    }
  }

  const readData = async (file) => {
    const target = join(folder, fixFileName(file))
    const release = await lockFor(target).acquire()
    try {
      return JSON.parse(await readFile(target, { encoding: 'utf-8' }), BufferJSON.reviver)
    } catch {
      return null
    } finally {
      release()
    }
  }

  const removeData = async (file) => {
    const target = join(folder, fixFileName(file))
    const release = await lockFor(target).acquire()
    try { await unlink(target) } catch { /* already gone */ } finally { release() }
  }

  const creds = (await readData('creds.json')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {}
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`)
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            out[id] = value
          }))
          return out
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const file = `${category}-${id}.json`
              tasks.push(value ? writeData(value, file) : removeData(file))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: async () => writeData(creds, 'creds.json'),
  }
}

/** Remove temp files a previous hard kill left behind. */
export async function cleanupAuthTemps(folder) {
  const { readdir } = await import('fs/promises')
  let n = 0
  try {
    for (const f of await readdir(folder)) {
      if (/\.tmp-\d+$/.test(f)) { await unlink(join(folder, f)).catch(() => {}); n++ }
    }
  } catch { /* nothing to clean */ }
  return n
}
