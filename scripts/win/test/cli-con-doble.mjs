#!/usr/bin/env node
/** Test-only entry point. The production CLI has no environment-selected adapter. */
import path from 'path'
import { fileURLToPath } from 'url'
import { main } from '../cli.mjs'
import { createAdapter } from './doubles/baileys-double.mjs'
import { exitCodeFor } from '../lib/errors.mjs'

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.argv.length > 2) {
  main(process.argv.slice(2), { createAdapter }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${err?.message || err}\n`)
      process.exit(exitCodeFor(err))
    },
  )
}
