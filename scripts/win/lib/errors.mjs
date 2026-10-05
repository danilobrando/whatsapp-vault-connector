/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Exit-code contract for the Windows read-only connector.
 *
 *   0  ok
 *   2  usage error (bad command, missing flag, malformed allowlist file)
 *   3  not linked (no WhatsApp session on this machine)
 *   4  no network (cannot reach WhatsApp / the update endpoint)
 *   5  invalid session (credentials present but rejected or unrecoverable)
 *  10  any other internal error
 *
 * These are what the product's launcher reads to decide whether to retry,
 * re-link or surface a message. They are part of the public contract and are
 * asserted by the test suite; do not renumber without a major bump.
 */

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  NO_LINK: 3,
  NO_NET: 4,
  BAD_SESSION: 5,
  INTERNAL: 10,
})

export class CliError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

export class UsageError extends CliError {
  constructor(message) {
    super(message, EXIT.USAGE)
    this.name = 'UsageError'
  }
}

export class NotLinkedError extends CliError {
  constructor(message = 'No WhatsApp session is linked. Run: cli.mjs link --qr') {
    super(message, EXIT.NO_LINK)
    this.name = 'NotLinkedError'
  }
}

export class NoNetworkError extends CliError {
  constructor(message = 'WhatsApp is unreachable from this machine (offline or blocked).') {
    super(message, EXIT.NO_NET)
    this.name = 'NoNetworkError'
  }
}

export class InvalidSessionError extends CliError {
  constructor(message = 'The local session is invalid. Run: cli.mjs logout && cli.mjs link --qr') {
    super(message, EXIT.BAD_SESSION)
    this.name = 'InvalidSessionError'
  }
}

/**
 * Adapters signal the exit class of a failure with `err.kind`. Anything that
 * does not carry a recognised kind is treated as an internal error, never as a
 * success — an unknown failure must not read as healthy.
 */
export function exitCodeFor(err) {
  if (err && typeof err.exitCode === 'number') return err.exitCode
  switch (err && err.kind) {
    case 'usage': return EXIT.USAGE
    case 'no-link': return EXIT.NO_LINK
    case 'no-net': return EXIT.NO_NET
    case 'bad-session': return EXIT.BAD_SESSION
    default: return EXIT.INTERNAL
  }
}
