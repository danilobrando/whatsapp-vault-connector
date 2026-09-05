# Security

## Reporting

Open a [private security advisory](https://github.com/danilobrando/whatsapp-vault-connector/security/advisories/new).
Please do not open a public issue for anything involving credentials.

I am one person; expect a first response within a week, not a day.

## What this software holds

| Asset | Location | Why it matters |
|---|---|---|
| Signal identity + session keys | `scripts/baileys_auth/` | Authenticates this machine **as your WhatsApp**. Copying it is account takeover. |
| Message store | `scripts/.message_store.json` | Recent message bodies, kept so the phone's retry requests can be answered. |
| Conversation history | `<vault>/…/whatsapp-inbox/*.md` | Every message, plain text, forever. |
| Live pairing QR | `scripts/.pair/` | A scannable credential while it lives. Deleted after pairing. |
| IPC socket | `scripts/.run/daemon.sock` | Accepts `send` with **no authentication**. |

## Controls in place

- The daemon sets `umask 077` before Baileys touches anything, because Baileys
  rewrites key files with no mode and a reactive `chmod` loses that race.
- Secrets and the IPC socket live in `0700` directories, not `/tmp` (mode 1777).
- `wa-fix.py doctor` checks permissions across the whole secret inventory and
  reports looseness as `FAIL`, not a warning.
- Re-pair backups are created `0700` and excluded from Time Machine, and only the
  two most recent are retained.
- A `pre-commit` hook blocks real phone numbers and JIDs from entering the repo.

## Known gaps

Stated plainly rather than left for you to discover:

- **The IPC socket does not authenticate its peer.** Any process running as your
  user can send WhatsApp messages through it. The `0700` directory is the only
  boundary. A peer-uid check needs a native addon and is not implemented.
- **The Baileys auth store is not written atomically.** A hard kill during a key
  write can corrupt it; recovery is a re-pair. The watchdog sends `SIGTERM` and
  waits before escalating, which makes this unlikely, not impossible.
- **No audit log of who asked for a send.** The daemon logs that a message was
  sent, not which local process requested it.
- **Conversation markdown is never encrypted at rest.**

## Not a vulnerability

Getting your WhatsApp account banned for automating it. That is the documented,
expected risk of using an unofficial client; see the README.
