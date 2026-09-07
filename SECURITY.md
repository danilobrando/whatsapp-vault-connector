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
- **The Signal auth store is written atomically** (temp file + `rename`), so a
  hard kill during a key write cannot leave a corrupt credential whose only
  recovery is a full re-pair. Temp files from a previous kill are swept at start.
- **Every outbound send is recorded** in `audit.jsonl`, with a digest rather than
  the message body.
- A `pre-commit` hook blocks real phone numbers and JIDs from entering the repo.

## Known gaps

Stated plainly rather than left for you to discover.

**The IPC socket does not authenticate its peer, and cannot.** Node exposes no
way to read a Unix socket's peer uid without a native addon, and any token we
invented would be readable by the same processes we would be trying to exclude —
so a token here would be theatre, and we do not ship it. The `0700` run
directory is the real boundary: anything running as your user can send WhatsApp
messages through the socket.

What exists instead is attribution. Every send attempt is appended to
`audit.jsonl` (mode `0600`) with the caller's self-reported label, the target, a
byte count and an 8-char digest — **never the message body**. The
`send-provenance` check reports any traffic from callers you did not expect, so
an unfamiliar sender surfaces in `doctor` instead of going unnoticed. Set
`WA_EXPECTED_SEND_CLIENTS` to your own comma-separated list.

A label is not proof: anything can claim to be the MCP server. It is a trail,
not a gate. If you need a gate, do not give shell access on this machine to
anyone you would not hand your phone to.

**No message content is recoverable from the audit log**, by design. If you need
to know what was said, that is the vault.

## Not a vulnerability

Getting your WhatsApp account banned for automating it. That is the documented,
expected risk of using an unofficial client; see the README.
