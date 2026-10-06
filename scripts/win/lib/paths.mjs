/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Where every piece of Windows runtime state lives.
 *
 * On Windows 10/11 the install is fully per-user: everything sits under
 * `%LOCALAPPDATA%\System3\whatsapp\<version>\` so the connector never needs
 * administrator rights, a Windows service, a scheduled task, or a machine-wide
 * registry key. That constraint is the whole reason this port exists; do not
 * introduce a fallback to `Program Files` or HKLM.
 *
 * On non-Windows hosts (development and the test suite) the same layout is
 * recreated under an XDG-style directory, and `WA_WIN_STATE` overrides it
 * outright. The tray (bandeja) is never state: it is supplied by the caller
 * with `--bandeja` or `WA_BANDEJA`, because the product's launcher owns the
 * vault location, not this connector.
 */
import path from 'path'
import os from 'os'
import { VERSION } from './contract.mjs'

export function defaultStateDir(env = process.env, platform = process.platform) {
  if (env.WA_WIN_STATE) return env.WA_WIN_STATE
  const home = env.USERPROFILE || env.HOME || os.homedir()
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return path.join(base, 'System3', 'whatsapp', VERSION, 'state')
  }
  return path.join(home, '.local', 'share', 'System3', 'whatsapp', VERSION, 'state')
}

export function statePaths(stateDir) {
  return {
    stateDir,
    authDir: path.join(stateDir, 'baileys_auth'),
    allowFile: path.join(stateDir, 'allow.json'),
    stateFile: path.join(stateDir, 'state.json'),
    pairDir: path.join(stateDir, '.pair'),
    qrTextFile: path.join(stateDir, '.pair', 'qr-raw.txt'),
    qrPngFile: path.join(stateDir, '.pair', 'qr.png'),
    stopFile: path.join(stateDir, '.stop'),
    logsDir: path.join(stateDir, 'logs'),
  }
}

/** Resolve the tray from an explicit flag first, then the environment. */
export function resolveBandeja({ bandejaFlag, env = process.env } = {}) {
  const value = bandejaFlag || env.WA_BANDEJA || ''
  if (!value) return null
  return path.resolve(value)
}
