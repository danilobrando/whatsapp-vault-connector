#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Windows read-only control contract. The production entry point has a static
 * adapter import; test doubles enter only through win/test/cli-con-doble.mjs,
 * which the artifact builder excludes.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createAdapter as createProductionAdapter } from './lib/adapter.mjs'
import { EXIT, UsageError, NotLinkedError, exitCodeFor } from './lib/errors.mjs'
import { VERSION, versionPayload } from './lib/contract.mjs'
import { defaultStateDir, statePaths, resolveBandeja } from './lib/paths.mjs'
import { readState, writeState } from './lib/store.mjs'
import { loadAllowList, parseAllowList } from './lib/allowlist.mjs'
import { writeTray } from './lib/tray.mjs'
import { cleanScopedTemps, ensureDir, rmrf, writeFileAtomic } from './lib/fsutil.mjs'

const COMMANDS = new Set(['version', 'link', 'chats', 'allow', 'status', 'sync-once', 'run', 'stop', 'logout', 'uninstall'])
const ALLOWED_FLAGS = {
  version: new Set(['json']),
  link: new Set(['qr', 'code', 'state', 'tz']),
  chats: new Set(['json', 'state', 'tz']),
  allow: new Set(['set', 'state']),
  status: new Set(['json', 'state']),
  'sync-once': new Set(['bandeja', 'state', 'tz']),
  run: new Set(['bandeja', 'state', 'tz']),
  stop: new Set(['state']),
  logout: new Set(['state']),
  uninstall: new Set(['yes', 'state']),
}

export function parseArgv(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--qr') flags.qr = true
    else if (arg === '--json') flags.json = true
    else if (arg === '--yes' || arg === '-y') flags.yes = true
    else if (arg === '--set') flags.set = argv[++i]
    else if (arg === '--code') flags.code = argv[++i]
    else if (arg === '--bandeja') flags.bandeja = argv[++i]
    else if (arg === '--state') flags.state = argv[++i]
    else if (arg === '--tz') flags.tz = argv[++i]
    else if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg.startsWith('--')) throw new UsageError(`Unknown option: ${arg}`)
    else positional.push(arg)
  }
  for (const key of ['set', 'code', 'bandeja', 'state', 'tz']) {
    if (flags[key] == null || flags[key] === '') {
      if (argv.includes(`--${key}`)) throw new UsageError(`Option --${key} requires a value`)
    }
  }
  return { flags, positional }
}

function validateCommand(command, flags, positional) {
  if (!command || !COMMANDS.has(command)) throw new UsageError(`Unknown command: ${command || '(missing)'}`)
  if (positional.length > 1) throw new UsageError('Only one command is accepted')
  const allowed = ALLOWED_FLAGS[command]
  for (const key of Object.keys(flags)) {
    if (key === 'help' || !allowed.has(key)) throw new UsageError(`Option --${key} is not valid for ${command}`)
  }
  if (command === 'link' && (!!flags.qr === !!flags.code)) {
    throw new UsageError('link requires exactly one of --qr or --code <telefono>')
  }
  if (command === 'uninstall' && !flags.yes) throw new UsageError('uninstall requires --yes')
  if (command === 'allow' && !flags.set) throw new UsageError('allow requires --set <archivo.json>')
  if ((command === 'sync-once' || command === 'run') && !flags.bandeja) {
    // WA_BANDEJA is checked after the environment is available.
  }
}

function out(stdout, value) {
  stdout.write(JSON.stringify(value) + '\n')
}

function requireLinked(linked) {
  if (!linked) throw new NotLinkedError()
}

function chatSummary(chat) {
  return { jid: chat.jid, nombre: chat.nombre, es_grupo: !!chat.es_grupo }
}

async function renderQr(qr, paths, stderr) {
  try {
    const qrcodeTerminal = (await import('qrcode-terminal')).default
    qrcodeTerminal.generate(qr, { small: true }, (rendered) => stderr.write(`${rendered}\n`))
  } catch (err) {
    stderr.write(`warning: could not render QR in terminal (${err.message})\n`)
  }
  ensureDir(paths.pairDir)
  writeFileAtomic(paths.qrTextFile, qr, { tempRoot: path.join(paths.stateDir, '.tmp') })
  try {
    const mod = await import('qrcode')
    const QR = mod.default || mod
    await QR.toFile(paths.qrPngFile, qr, { type: 'png', width: 512, margin: 2 })
  } catch (err) {
    stderr.write(`warning: no QR PNG written (${err.message})\n`)
  }
}

function clearState(paths) {
  // Keep the program, portable Node and tray untouched. The product launcher
  // owns removal of the program tree after this process exits.
  for (const target of [
    paths.authDir,
    paths.allowFile,
    paths.stateFile,
    paths.pairDir,
    paths.stopFile,
    paths.logsDir,
    path.join(paths.stateDir, '.tmp'),
  ]) rmrf(target)
}

function cleanStateTemps(root) {
  cleanScopedTemps(root)
  try {
    if (fs.readdirSync(root).length === 0) rmrf(root)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout
  const stderr = deps.stderr || process.stderr
  const env = deps.env || process.env
  const now = deps.now || (() => new Date())
  const { flags, positional } = parseArgv(argv)
  const command = positional[0]

  if (!command && flags.help) {
    stdout.write(usage())
    return EXIT.OK
  }
  validateCommand(command, flags, positional)

  const stateDir = flags.state || deps.stateDir || defaultStateDir(env)
  const paths = statePaths(stateDir)
  const tz = flags.tz || env.WA_TZ || 'America/Bogota'
  cleanStateTemps(path.join(stateDir, '.tmp'))

  // This cleanup is deliberately in finally: a failed state write must not
  // leave an executable-looking sibling temp file for the next run.
  try {
    const createAdapter = deps.createAdapter || createProductionAdapter
    let adapterInstance
    const getAdapter = async () => {
      if (!adapterInstance) adapterInstance = await createAdapter({ paths, tz, env, senderName: env.WA_SENDER_NAME || 'Me' })
      return adapterInstance
    }

    switch (command) {
      case 'version':
        out(stdout, versionPayload())
        return EXIT.OK

      case 'link': {
        try {
          const adapter = await getAdapter()
          if (await adapter.linked()) {
            const account = await adapter.account()
            out(stdout, { ok: true, ya_vinculado: true, cuenta_enmascarada: account?.mask || null })
            return EXIT.OK
          }
          if (flags.qr) {
            const account = await adapter.linkQR({ onQR: (qr) => renderQr(qr, paths, stderr) })
            const state = readState(paths.stateFile)
            writeState(paths.stateFile, { ...state, vinculado: true, cuenta_enmascarada: account?.mask || null })
            out(stdout, { ok: true, vinculado: true, cuenta_enmascarada: account?.mask || null })
            return EXIT.OK
          }
          const phone = String(flags.code).replace(/[^\d+]/g, '')
          if (!/^\+?\d{7,15}$/.test(phone)) throw new UsageError('link --code requires a phone number in E.164 format')
          let pairingCode = null
          const account = await adapter.linkCode(phone, { onCode: (code) => { pairingCode = String(code) } })
          const state = readState(paths.stateFile)
          writeState(paths.stateFile, { ...state, vinculado: true, cuenta_enmascarada: account?.mask || null })
          out(stdout, { ok: true, vinculado: true, cuenta_enmascarada: account?.mask || null, codigo_emparejamiento: pairingCode })
          return EXIT.OK
        } finally {
          rmrf(paths.pairDir)
        }
      }

      case 'chats': {
        const adapter = await getAdapter()
        requireLinked(await adapter.linked())
        const chats = await adapter.fetchChatInventory()
        out(stdout, chats.map(chatSummary))
        return EXIT.OK
      }

      case 'allow': {
        let raw
        try { raw = fs.readFileSync(flags.set, 'utf8') } catch { throw new UsageError(`Cannot read allowlist file: ${flags.set}`) }
        const allow = parseAllowList(raw)
        ensureDir(stateDir)
        writeFileAtomic(paths.allowFile, JSON.stringify({ jids: [...allow] }, null, 2) + '\n', { tempRoot: path.join(stateDir, '.tmp') })
        out(stdout, { ok: true, count: allow.size, archivo: paths.allowFile })
        return EXIT.OK
      }

      case 'status': {
        const adapter = await getAdapter()
        const linked = await adapter.linked()
        const state = readState(paths.stateFile)
        const allow = loadAllowList(paths.allowFile)
        const pending = [...allow].filter((jid) => !(state.jids_sync || {})[jid]).length
        out(stdout, {
          vinculado: !!linked,
          cuenta_enmascarada: state.cuenta_enmascarada || null,
          ultima_sync: state.ultima_sync || null,
          pendientes: pending,
        })
        return EXIT.OK
      }

      case 'sync-once': {
        const bandeja = resolveBandeja({ bandejaFlag: flags.bandeja, env })
        if (!bandeja) throw new UsageError('sync-once requires --bandeja <ruta> or WA_BANDEJA')
        const adapter = await getAdapter()
        requireLinked(await adapter.linked())
        const allow = loadAllowList(paths.allowFile)
        const chats = await adapter.fetchChats({ allow })
        const stats = writeTray({ bandeja, chats, allow, tz, now: now() })
        const state = readState(paths.stateFile)
        writeState(paths.stateFile, { ...state, vinculado: true, ultima_sync: now().toISOString(), jids_sync: mergeSync(state.jids_sync, chats) })
        out(stdout, { ok: true, bandeja, ...stats })
        return EXIT.OK
      }

      case 'run': {
        const bandeja = resolveBandeja({ bandejaFlag: flags.bandeja, env })
        if (!bandeja) throw new UsageError('run requires --bandeja <ruta> or WA_BANDEJA')
        const adapter = await getAdapter()
        requireLinked(await adapter.linked())
        const allow = loadAllowList(paths.allowFile)
        let stats = null
        if (typeof adapter.runForeground === 'function') {
          const returned = await adapter.runForeground({ bandeja, allow, tz, paths, onSync: (next) => { stats = next } })
          if (returned !== undefined) stats = returned
        } else {
          stats = writeTray({ bandeja, chats: await adapter.fetchChats({ allow }), allow, tz, now: now() })
        }
        out(stdout, { ok: true, ...(stats || {}) })
        return EXIT.OK
      }

      case 'stop': {
        const adapter = await getAdapter()
        const result = typeof adapter.stop === 'function' ? await adapter.stop() : { stopRequested: true }
        out(stdout, { ok: true, ...result })
        return EXIT.OK
      }

      case 'logout': {
        const adapter = await getAdapter()
        await adapter.logout()
        const state = readState(paths.stateFile)
        writeState(paths.stateFile, { ...state, vinculado: false, cuenta_enmascarada: null, jids_sync: {} })
        out(stdout, { ok: true, vinculado: false })
        return EXIT.OK
      }

      case 'uninstall':
        clearState(paths)
        out(stdout, { ok: true, estado_borrado: stateDir })
        return EXIT.OK

      default:
        throw new UsageError(`Unknown command: ${command}`)
    }
  } finally {
    cleanStateTemps(path.join(stateDir, '.tmp'))
  }
}

function mergeSync(prev, chats) {
  const next = { ...(prev || {}) }
  for (const chat of chats || []) {
    let newest = 0
    for (const m of chat.mensajes || []) newest = Math.max(newest, Number(m.ts) || 0)
    next[chat.jid] = Math.max(next[chat.jid] || 0, newest)
  }
  return next
}

export function usage() {
  return `whatsapp-vault-connector (Windows, read-only) ${VERSION}\n\nUsage: node cli.mjs <command> [options]\n\nCommands:\n  version                 Print the control contract\n  link --qr               Link with a QR shown only in the terminal\n  link --code <phone>     Link with a phone pairing code\n  chats --json            List the complete metadata inventory\n  allow --set <file.json> Replace the allow-list of JIDs\n  status --json           Print the four status fields\n  sync-once               Write one new tray lote per permitted chat\n  run                     Keep the session alive in the foreground\n  stop                    Ask a running session to stop\n  logout                  Unlink and delete the local session\n  uninstall --yes         Delete local state only\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${err && err.message ? err.message : err}\n`)
      process.exit(exitCodeFor(err))
    },
  )
}
