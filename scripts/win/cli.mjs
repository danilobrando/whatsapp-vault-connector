#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Control contract for the Windows read-only connector.
 *
 *   node cli.mjs version
 *   node cli.mjs link --qr
 *   node cli.mjs link --code <telefono-E164>
 *   node cli.mjs chats --json
 *   node cli.mjs allow --set <archivo.json>
 *   node cli.mjs status --json
 *   node cli.mjs sync-once
 *   node cli.mjs run
 *   node cli.mjs stop
 *   node cli.mjs logout
 *   node cli.mjs uninstall --yes
 *
 * Exit codes: 0 ok · 2 usage · 3 not linked · 4 no network · 5 invalid session
 * · 10 internal. See lib/errors.mjs — they are part of the contract the
 * product's launcher reads.
 *
 * The scheduling lives in the launcher, not here: this connector only knows how
 * to `run` in the foreground and how to `stop`. It never installs a Windows
 * service, a scheduled task or a run-key.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { EXIT, UsageError, NotLinkedError, exitCodeFor } from './lib/errors.mjs'
import { VERSION, versionPayload } from './lib/contract.mjs'
import { defaultStateDir, statePaths, resolveBandeja } from './lib/paths.mjs'
import { readState, writeState } from './lib/store.mjs'
import { loadAllowList, parseAllowList, isAllowed } from './lib/allowlist.mjs'
import { writeTray } from './lib/tray.mjs'
import { ensureDir, writeFileAtomic, rmrf } from './lib/fsutil.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function parseArgv(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--qr') flags.qr = true
    else if (a === '--json') flags.json = true
    else if (a === '--yes' || a === '-y') flags.yes = true
    else if (a === '--help' || a === '-h') flags.help = true
    else if (a === '--set') flags.set = argv[++i]
    else if (a === '--code') flags.code = argv[++i]
    else if (a === '--bandeja') flags.bandeja = argv[++i]
    else if (a === '--state') flags.state = argv[++i]
    else if (a === '--tz') flags.tz = argv[++i]
    else if (a.startsWith('--')) throw new UsageError(`Unknown option: ${a}`)
    else positional.push(a)
  }
  return { flags, positional }
}

async function loadAdapterFactory(env) {
  const spec = env.WA_WIN_ADAPTER || './lib/adapter.mjs'
  const url = spec.startsWith('.') ? new URL(spec, import.meta.url).href : spec
  const mod = await import(url)
  if (typeof mod.createAdapter !== 'function') {
    throw new UsageError(`Adapter module ${spec} does not export createAdapter`)
  }
  return mod.createAdapter
}

function chatSummary(chat) {
  const mensajes = (chat.mensajes || [])
    .slice(-20)
    .map((m) => ({
      ts: m.ts,
      autor: m.system ? null : (m.author || null),
      de_sistema: !!m.system,
      texto: m.system ? m.text : (m.attachment ? (m.attachment.kind === 'document' ? `<adjunto: ${m.attachment.fileName}>` : '<adjunto omitido>') : m.text),
      adjunto: m.attachment ? { tipo: m.attachment.kind, nombre: m.attachment.fileName || null } : null,
    }))
  return { jid: chat.jid, nombre: chat.nombre, es_grupo: !!chat.es_grupo, ultimos_mensajes: mensajes }
}

async function renderQr(qr, paths, stderr) {
  try {
    const qrcodeTerminal = (await import('qrcode-terminal')).default
    qrcodeTerminal.generate(qr, { small: true })
  } catch { /* terminal rendering is best-effort */ }
  ensureDir(paths.pairDir)
  writeFileAtomic(paths.qrTextFile, qr)
  try {
    const mod = await import('qrcode')
    const QR = mod.default || mod
    await QR.toFile(paths.qrPngFile, qr, { type: 'png', width: 512, margin: 2 })
  } catch (err) {
    stderr.write(`warning: no QR PNG written (${err.message})\n`)
  }
}

function requireLinked(linked) {
  if (!linked) throw new NotLinkedError()
}

function out(stdout, value) {
  stdout.write(JSON.stringify(value, null, 2) + '\n')
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout
  const stderr = deps.stderr || process.stderr
  const env = deps.env || process.env
  const now = deps.now || (() => new Date())

  const { flags, positional } = parseArgv(argv)
  const command = positional[0]

  const stateDir = flags.state || deps.stateDir || defaultStateDir(env)
  const paths = statePaths(stateDir)
  const tz = flags.tz || env.WA_TZ || 'America/Bogota'

  if (!command || flags.help) {
    stdout.write(usage())
    return EXIT.OK
  }

  const createAdapter = deps.createAdapter || await loadAdapterFactory(env)
  let _adapter = deps.adapter || null
  const adapterInstance = async () => {
    if (!_adapter) _adapter = await createAdapter({ paths, tz, env, senderName: env.WA_SENDER_NAME || 'Me' })
    return _adapter
  }

  switch (command) {
    case 'version': {
      out(stdout, versionPayload())
      return EXIT.OK
    }

    case 'link': {
      const adapter = await adapterInstance()
      if (!flags.qr && !flags.code) throw new UsageError('link requires --qr or --code <telefono>')
      const linked = await adapter.linked()
      if (linked) {
        const account = await adapter.account()
        out(stdout, { ok: true, ya_vinculado: true, cuenta_enmascarada: account?.mask || null })
        return EXIT.OK
      }
      if (flags.qr) {
        const account = await adapter.linkQR({ onQR: (qr) => renderQr(qr, paths, stderr) })
        const state = readState(paths.stateFile)
        writeState(paths.stateFile, { ...state, vinculado: true, cuenta_enmascarada: account?.mask || null })
        out(stdout, { ok: true, vinculado: true, cuenta_enmascarada: account?.mask || null, qr_png: paths.qrPngFile })
        return EXIT.OK
      }
      const phone = String(flags.code).replace(/[^\d+]/g, '')
      const account = await adapter.linkCode(phone, { onCode: (code) => stdout.write(`codigo_de_emparejamiento: ${code}\n`) })
      const state = readState(paths.stateFile)
      writeState(paths.stateFile, { ...state, vinculado: true, cuenta_enmascarada: account?.mask || null })
      out(stdout, { ok: true, vinculado: true, cuenta_enmascarada: account?.mask || null })
      return EXIT.OK
    }

    case 'chats': {
      const adapter = await adapterInstance()
      requireLinked(await adapter.linked())
      const allow = loadAllowList(paths.allowFile)
      const chats = (await adapter.fetchChats()).filter((c) => isAllowed(c.jid, allow))
      out(stdout, chats.map(chatSummary))
      return EXIT.OK
    }

    case 'allow': {
      if (!flags.set) throw new UsageError('allow requires --set <archivo.json>')
      let raw
      try {
        raw = (await import('fs')).readFileSync(flags.set, 'utf8')
      } catch (err) {
        throw new UsageError(`Cannot read allowlist file: ${flags.set}`)
      }
      const allow = parseAllowList(raw)
      ensureDir(stateDir)
      writeFileAtomic(paths.allowFile, JSON.stringify({ jids: [...allow] }, null, 2) + '\n')
      out(stdout, { ok: true, count: allow.size, archivo: paths.allowFile })
      return EXIT.OK
    }

    case 'status': {
      const adapter = await adapterInstance()
      const linked = await adapter.linked()
      const account = linked ? await adapter.account() : null
      const state = readState(paths.stateFile)
      const allow = loadAllowList(paths.allowFile)
      const pending = [...allow].filter((jid) => !(state.jids_sync || {})[jid]).length
      out(stdout, {
        vinculado: !!linked,
        cuenta_enmascarada: (account?.mask) || state.cuenta_enmascarada || null,
        ultima_sync: state.ultima_sync || null,
        pendientes: pending,
      })
      return EXIT.OK
    }

    case 'sync-once': {
      const adapter = await adapterInstance()
      requireLinked(await adapter.linked())
      const bandeja = resolveBandeja({ bandejaFlag: flags.bandeja, env })
      if (!bandeja) throw new UsageError('sync-once requires --bandeja <ruta> or WA_BANDEJA')
      const allow = loadAllowList(paths.allowFile)
      const chats = await adapter.fetchChats()
      const stats = writeTray({ bandeja, chats, allow, tz })
      const state = readState(paths.stateFile)
      writeState(paths.stateFile, { ...state, vinculado: true, ultima_sync: now().toISOString(), jids_sync: mergeSync(state.jids_sync, chats.filter((c) => isAllowed(c.jid, allow))) })
      out(stdout, { ok: true, bandeja, ...stats })
      return EXIT.OK
    }

    case 'run': {
      const adapter = await adapterInstance()
      requireLinked(await adapter.linked())
      const bandeja = resolveBandeja({ bandejaFlag: flags.bandeja, env })
      if (!bandeja) throw new UsageError('run requires --bandeja <ruta> or WA_BANDEJA')
      const allow = loadAllowList(paths.allowFile)
      if (typeof adapter.runForeground === 'function') {
        await adapter.runForeground({ bandeja, allow, tz, paths, onSync: (stats) => out(stdout, { ok: true, ...stats }) })
        return EXIT.OK
      }
      const stats = writeTray({ bandeja, chats: await adapter.fetchChats(), allow, tz })
      out(stdout, { ok: true, ...stats })
      return EXIT.OK
    }

    case 'stop': {
      const adapter = await adapterInstance()
      if (typeof adapter.stop === 'function') await adapter.stop()
      return EXIT.OK
    }

    case 'logout': {
      const adapter = await adapterInstance()
      await adapter.logout()
      const state = readState(paths.stateFile)
      writeState(paths.stateFile, { ...state, vinculado: false, cuenta_enmascarada: null, jids_sync: {} })
      out(stdout, { ok: true, vinculado: false })
      return EXIT.OK
    }

    case 'uninstall': {
      if (!flags.yes) throw new UsageError('uninstall requires --yes')
      rmrf(stateDir)
      out(stdout, { ok: true, estado_borrado: stateDir })
      return EXIT.OK
    }

    default:
      throw new UsageError(`Unknown command: ${command}`)
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
  return `whatsapp-vault-connector (Windows, read-only) ${VERSION}

Usage: node cli.mjs <command> [options]

Commands:
  version                 Print {version, contrato_bandeja, readonly}
  link --qr               Link with a QR (terminal + PNG in the state dir)
  link --code <phone>     Link with a pairing code (E.164 phone)
  chats --json            List permitted chats and their last messages
  allow --set <file.json> Replace the allow-list of JIDs
  status --json           {vinculado, cuenta_enmascarada, ultima_sync, pendientes}
  sync-once               Write the tray once
  run                     Keep the session alive in the foreground
  stop                    Ask a running session to stop
  logout                  Unlink and delete the local session
  uninstall --yes         Delete local state (never touches the tray)

Options:
  --bandeja <path>        Tray directory (or WA_BANDEJA)
  --state <path>          State directory (or WA_WIN_STATE)
  --tz <zone>             Timezone (default America/Bogota)
  --json                  Machine-readable output
`
}

// Only auto-run when executed directly, so tests can import `main`.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${err && err.message ? err.message : err}\n`)
      process.exit(exitCodeFor(err))
    },
  )
}
