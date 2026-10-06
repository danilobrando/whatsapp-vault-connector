/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * The bandeja contract this connector publishes, and the version it reports.
 *
 * SPEC-0005 fixes the tray (bandeja) contract at `contrato: 1` and requires the
 * connector to announce `readonly: true`. The product's importer reads
 * `contrato.json` before anything else and refuses a tray it does not
 * understand, so these values are part of the frontier, not decoration.
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

export const CONTRATO_BANDEJA = 1
export const READONLY = true
export const ORIGEN = 'whatsapp-vault-connector'

function readPackageVersion() {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg && typeof pkg.version === 'string') return pkg.version
  } catch { /* fall through to the pinned value */ }
  return '3.0.0'
}

export const VERSION = readPackageVersion()

/** The exact JSON the tray carries, one level up from the per-chat files. */
export function contratoJson() {
  return {
    contrato: CONTRATO_BANDEJA,
    origen: ORIGEN,
    version: VERSION,
    formato_fecha: 'dd/mm/aa',
    reloj: '24h',
  }
}

/** The `version` command payload, as required by the control contract. */
export function versionPayload() {
  return { version: VERSION, contrato_bandeja: CONTRATO_BANDEJA, readonly: READONLY }
}
