---
name: whatsapp-connector
description: |
  Set up, diagnose and repair the WhatsApp vault connector — a Baileys daemon
  that keeps a WhatsApp session alive on this Mac, writes every conversation
  into the user's Obsidian vault as markdown, and exposes MCP tools so Claude
  Code can read and send.

  SETUP TRIGGER — the user wants WhatsApp in their vault and it is not installed
  yet. English: "set up WhatsApp", "connect WhatsApp to my vault", "install the
  WhatsApp connector", "I want Claude to read my WhatsApp".
  Español: "conecta WhatsApp a mi vault", "instala el conector de WhatsApp",
  "quiero que Claude lea mi WhatsApp".

  RECOVERY TRIGGER — the user reports ANY WhatsApp trouble. Run the diagnostic
  FIRST, before replying. English: "WhatsApp isn't working", "messages aren't
  arriving", "stuck on waiting for this message", "I can't send", "nothing new
  in my vault", "it stopped syncing". Español: "el WhatsApp no funciona", "no me
  llegan los mensajes", "se queda en procesando", "no puedo enviar", "está raro
  lo de WhatsApp".

  Do NOT use for sending one specific message once the connector is running
  (use the whatsapp_send MCP tool), or for any other messaging platform.
---

# whatsapp-connector

Two jobs: get it installed, and keep it honest afterwards. Both start the same
way — find out whether it is already installed.

## Step 0 — locate the install (always do this first)

```bash
PLIST="$HOME/Library/LaunchAgents/com.whatsapp-connector.daemon.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST"
else
  echo "NOT_INSTALLED"
fi
```

Never hardcode a path. The install location is the user's choice and lives in
that plist. Call the result `$WA` below.

---

## If it is NOT installed — setup

**Tell the user the risks before anything else. Do not skip this.** This uses
[Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial
reverse-engineered WhatsApp client. **Automating a WhatsApp account can get it
banned**, and there is no appeal worth relying on. Their conversations will be
written to disk as plain text inside their vault. Ask them to confirm they
understand before continuing — this is their account, not yours to risk.

Requirements to check: macOS, Node 18+, Python 3.10+, an Obsidian-style vault
directory, and their phone in hand for a QR scan.

```bash
git clone https://github.com/danilobrando/whatsapp-vault-connector ~/whatsapp-vault-connector
cd ~/whatsapp-vault-connector && bash install.sh
```

`install.sh` is interactive and asks for: vault path, their display name, an
optional filename suffix, **where outage alerts should go**, and a timezone.

Two things to be opinionated about while guiding them:

- **Push them to set an alert destination.** Blank means the only alarm is a
  desktop notification, which is useless when they are away. This connector
  exists because a 28-day outage went unnoticed; detection that delivers
  nowhere reproduces exactly that.
- **After install, prove the alert works**: `bash "$WA/wa-watchdog.sh" --test-alert`.
  An untested alert channel is indistinguishable from a working one right up
  until the outage.

The installer ends by opening a QR code. They scan it with
WhatsApp → Settings → Linked Devices → Link a Device. Then restart Claude Code
so the MCP server is picked up.

---

## If it IS installed — diagnosis and repair

**Run this first, silently, before you reply to the user.** It is read-only.

```bash
python3 "$WA/wa-fix.py" doctor --json
```

Read two fields. Do not parse the prose, and do not invent your own criteria.

| `escalate` | Meaning | What you do |
|---|---|---|
| `none` | Working. May carry warnings that are not yet actionable. | Say it is fine. If the user reported a problem, it is elsewhere — their phone, the network, the other person's WhatsApp. Ask in plain language. |
| `fix` | Broken in a way the tool repairs itself. | Run `python3 "$WA/wa-fix.py" fix`, then say what was fixed in plain words. |
| `repair` | Reception is dead or the Signal session drifted. Only re-pairing clears it. | Ask for their phone, then run `python3 "$WA/wa-fix.py" repair --yes`. |

Exit codes match: `0` healthy · `1` degraded, auto-fixable · `2` needs their
phone · `3` aborted · `4` hard error.

### The check that matters

`inbound-freshness` is first in the list and the only one that can veto a
healthy verdict. Every other check measures whether the daemon is breathing;
this one asks whether messages actually arrive. In August 2026 all the others
passed for 28 days while nothing came in.

If it says `DEAF`, sending may well still work — that is not evidence of health.

### Re-pairing

`repair` wipes the current session, so between starting it and the user
scanning, the connector is fully down. **Confirm they have their phone in hand
before you start.** It takes about six minutes and opens a QR in Preview.

Messages that arrived during the outage are not recoverable. They are on the
user's phone; they were never delivered to this machine. Say so plainly rather
than implying a repair backfills them.

## Language

Speak the user's language. Never make them say "daemon", "Baileys" or "Signal
session" — they asked about WhatsApp, not about a process supervisor.

## What not to do

- Do not paste raw tool output at them. Translate it.
- Do not tell them to restart their computer; the tool handles restarts.
- Do not run `node sync.mjs` or `send.mjs` while the daemon is up — a second
  Signal session on the same credentials is how sessions drift.
- Do not claim reception is fine because a send succeeded. They are independent,
  and conflating them is the original bug this project was built around.
