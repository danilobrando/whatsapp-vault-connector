# whatsapp-vault-connector

Keep a WhatsApp session alive on your Mac, write every conversation into your
Obsidian vault as markdown, and let Claude Code read and send messages through
it — with a health layer that tells you when it breaks instead of failing quietly.

By [Danny Bravo](https://github.com/danilobrando) · MIT · **v2.6.0 — alpha**

```
   your phone ──QR──▶ ┌─────────────────────────────────────────┐
                      │  daemon.mjs   (Baileys, always running) │
   contacts ─────────▶│    ├── writes ──▶ vault/…/whatsapp-inbox/*.md
                      │    └── IPC ◀───── mcp-server.mjs ◀── Claude Code
                      └───────────────┬─────────────────────────┘
                                      │ heartbeat + inbound signal
                      ┌───────────────▼─────────────────────────┐
                      │  wa-watchdog.sh  (every 60s)            │
                      │    restarts a hung daemon               │
                      │    detects DEAF (no inbound in 18h)     │
                      │    emails you ───────────────▶ you      │
                      └───────────────┬─────────────────────────┘
                                      │ .wa-health.jsonl heartbeat
                                      ▼
                          an external dead-man check
                          (silence here is itself an alarm)
```

## Read this before you install

**This uses an unofficial library.** [Baileys](https://github.com/WhiskeySockets/Baileys)
is a reverse-engineered WhatsApp Web client. It is not endorsed by WhatsApp, and
automating your account **can get it banned**. There is no appeal process worth
relying on. Do not run this on a number you cannot afford to lose, and do not use
it to send bulk or unsolicited messages. That is the single biggest risk here and
it is not hypothetical.

**Your conversations land on disk as plain text.** Every message becomes markdown
inside your vault. If that vault syncs to a cloud service or is in a git repo, your
private conversations go with it. Check your `.gitignore` and your sync settings
before pairing.

**`baileys_auth/` is a credential.** It authenticates this machine as your WhatsApp.
Anyone who copies that directory can read and send as you. It is created `0700/0600`
and the daemon sets `umask 077`, but back it up accordingly — or rather, don't.

**Sessions drift, and re-pairing needs you.** WhatsApp companion sessions lose sync
every few weeks. When it happens, incoming messages stop decrypting and only a QR
re-pair fixes it. This project cannot automate that away; what it can do is notice
within hours instead of weeks and tell you. See [Why the health layer exists](#why-the-health-layer-exists).

## What it does not do

- Not a bot framework, and no auto-replies. It writes what arrives and sends what you ask.
- No Windows or Linux support. It uses `launchd`, so macOS only.
- No multi-account support. One WhatsApp number per install.
- No media download beyond a helper script. Images and audio are recorded as
  `[Image]` / `[Audio]` placeholders in the markdown.
- No history before pairing beyond what WhatsApp itself replays to a new device.
- Not affiliated with WhatsApp, Meta, or Obsidian.

## Status

Alpha, and honestly labelled. It runs in production on one vault (the author's),
where it has handled ~160,000 messages. It has not been tested by anyone else, on
any other vault layout, or on any macOS version other than the author's. Interfaces
follow semver from v2.6.0 onward; before that the history was rewritten (see
[CHANGELOG](CHANGELOG.md)). Expect to read some code if something breaks.

## Why the health layer exists

In August 2026 this connector stopped receiving messages for **28 days** and nobody
noticed. The daemon reported `connected: true` the whole time, sent outbound
messages every day, and the diagnostic tool — run by hand on day 25 — printed
`12 passed, 0 failed`.

Every check measured whether the process was breathing. None asked whether messages
were arriving. Worse, the one freshness signal it did publish was written by both
the send path and the receive path, so the vault's own scheduled reminders kept it
looking fresh through total deafness.

Everything in `wa-fix.py` and `wa-watchdog.sh` is built around not repeating that:

- `inbound-freshness` is the first check and the only one that can veto a healthy
  verdict. Thresholds come from 219 days of real inbox data — the longest legitimate
  quiet gap ever measured was 16.9h, so the alarm sits at 18h with zero historical
  false positives.
- Self-sent messages are excluded from the inbound signal by three independent tests.
- `UNKNOWN` is a distinct status. A check that cannot gather its evidence never
  reports `PASS`.
- Alerts go **out of band** (email or your own command). Alerting over WhatsApp
  would write into the very inbox the detector reads.
- The watchdog writes a heartbeat line every run, so an external check can treat its
  silence as an alarm.

## Requirements

- macOS (uses `launchd` for process supervision)
- Node.js 18+ (`brew install node` if missing)
- Python 3.10+ (ships with macOS, or `brew install python`)
- An Obsidian-style vault directory (the connector creates `⚙️ Meta/whatsapp-inbox/` inside it)
- Your phone with WhatsApp installed (for the initial QR pairing)
- ~80 MB free disk for npm dependencies

## Install

```bash
git clone https://github.com/danilobrando/whatsapp-vault-connector ~/whatsapp-vault-connector
cd ~/whatsapp-vault-connector
bash install.sh
```

The installer is interactive and asks:

1. Path to your Obsidian vault root (default: `~/second-brain`)
2. Your display name as it appears on outbound messages saved to the vault (default: `Me`)
3. An optional filename suffix, e.g. `" (WhatsApp)"`, to keep conversation files
   distinguishable from your other notes (default: none)
4. **Where outage alerts should go** — an email address, or your own command.
   You can leave it blank, but then the only alert is a local desktop
   notification, and `wa-fix.py doctor` will keep reminding you. This matters:
   detection that delivers nowhere is the exact failure this project exists to
   prevent. Prove it works with `bash wa-watchdog.sh --test-alert`.
5. Timezone (default: `America/Bogota` — change it)

Then it does everything else: copies scripts to `<vault>/connectors/whatsapp/` (the standard location for second-brain connectors), installs npm dependencies, generates launchd plists from templates, registers the MCP server in `.mcp.json`, optionally adds a session-start hook, and walks you through the QR pairing.

> **Note on the standard layout.** All connectors for a second-brain vault install under `<vault>/connectors/<name>/`. Operational state (auth keys, logs, runtime files) lives there. Inbox / conversation history lives at `<vault>/⚙️ Meta/whatsapp-inbox/` by default but can be overridden via the `WA_INBOX_PATH` environment variable.

Re-running the installer is safe. It's idempotent and will unload any existing daemon first.

### One-liner

```bash
git clone https://github.com/danilobrando/whatsapp-vault-connector ~/whatsapp-vault-connector && bash ~/whatsapp-vault-connector/install.sh
```

### Updating an existing install

To pull the latest code without re-pairing or re-exporting history:

```bash
cd ~/whatsapp-vault-connector && bash update.sh
```

`update.sh` does a `git pull`, replaces source files and templates, runs `npm install` only when `package-lock.json` changed, restarts the daemon + watchdog, and runs `wa-fix doctor`. State (auth keys, message store, vault inbox) is preserved.

## Pairing

When the installer reaches step 11, a QR code prints to the terminal. On your phone:

- Open WhatsApp
- Settings → Linked Devices → Link a Device
- Point the camera at the QR code on your laptop screen

After "Connected" appears, the script continues to download recent message history. For accounts with thousands of chats this can take several minutes. Let it finish before continuing.

## Daily use

You don't type commands. When you notice something wrong with WhatsApp — messages stuck on "processing", chats not appearing in the vault, can't send — just tell Claude Code in plain language. The `whatsapp-recovery` skill is loaded globally and the agent will run the diagnostic and either auto-repair or guide you through any manual fix.

If you ever want to run the diagnostic yourself:

```bash
# Read-only diagnostic
python3 "<vault>/connectors/whatsapp/wa-fix.py" doctor

# Diagnose + auto-repair
python3 "<vault>/connectors/whatsapp/wa-fix.py" fix
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Claude Code session                                          │
│   ┌────────────────────────────┐                             │
│   │ whatsapp-recovery skill    │ ← triggers on user phrases  │
│   │ (auto-runs wa-fix on issue)│                             │
│   └────────────────────────────┘                             │
│   ┌────────────────────────────┐                             │
│   │ whatsapp MCP server tools  │ ← whatsapp_send, etc.       │
│   └─────────────┬──────────────┘                             │
└─────────────────┼────────────────────────────────────────────┘
                  │ Unix socket
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ daemon.mjs (long-running, managed by launchd)                │
│   ┌─────────────────────┐  ┌──────────────────────────┐      │
│   │ Baileys connection  │  │ IPC server (.sock)       │      │
│   │ (WhatsApp Multi-Dev)│  │ status / send / search   │      │
│   └─────────────────────┘  └──────────────────────────┘      │
│   ┌─────────────────────┐  ┌──────────────────────────┐      │
│   │ Persistent          │  │ Heartbeat file (30s)     │      │
│   │ messageStore (disk) │  │ for hang detection       │      │
│   └─────────────────────┘  └──────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
   │                                                       ▲
   │ append messages                                       │ kickstart on hang
   ▼                                                       │
┌─────────────────────────────────────┐  ┌──────────────────────┐
│ <vault>/⚙️ Meta/whatsapp-inbox/      │  │ wa-watchdog.sh (60s) │
│ One markdown file per conversation  │  │ (separate launchd)   │
└─────────────────────────────────────┘  └──────────────────────┘
```

## Failure modes that `wa-fix fix` handles

| Failure | Auto-fix? | Action |
|---|---|---|
| Daemon process dead | Yes | `launchctl kickstart` |
| Daemon hung (event loop frozen) | Yes | Kill + kickstart |
| Stale `.daemon.lock` | Yes | Remove lockfile |
| `baileys_auth/` permissions loose | Yes | chmod 0700/0600 |
| Missing `logs/` dir | Yes | mkdir |
| IPC socket dead but daemon running | Yes | kickstart |
| Vault directory missing | Yes | mkdir |
| `launchd` plist missing | No | Print re-install steps |
| `baileys_auth/` missing (not paired) | No | Print sync.mjs QR steps |
| Session keys drifted (Bad MAC / PreKeyError) | No | Print full re-pair sequence |
| Persistent high disconnect rate | No | Print network troubleshooting |

## Privacy and security

- `baileys_auth/` contains your WhatsApp Signal Protocol identity and session keys. Treat it as your highest-sensitivity secret. Mode is set to `0700/0600` on install and auto-fixed by `wa-fix` if it drifts.
- The IPC socket lives at `<install>/.run/daemon.sock` inside a `0700` directory — deliberately **not** in `/tmp`, which is world-writable. It is mode `0600`, but it **does not authenticate its caller**: any process running as your user can send WhatsApp messages in your name. See [SECURITY.md](SECURITY.md) for the full list of known gaps.
- The installer writes a `.gitignore` into the install directory so your Signal keys, message store and `node_modules` cannot be committed with your vault. **Verify it is there** if your vault is a git repo — this directory sits inside your vault.
- Markdown files in `⚙️ Meta/whatsapp-inbox/` contain plaintext message history. If your vault is synced via Dropbox / iCloud / git, you are placing this content with those providers — that's a decision you make, not a property of the connector. The `.gitignore` in this repo excludes `baileys_auth/`, `node_modules/`, logs, and runtime state files, but does not exclude your vault content (which lives outside the repo).
- For revocation: WhatsApp → Settings → Linked Devices → unlink the daemon entry. That invalidates the keys server-side. Then delete the `baileys_auth/` directory inside `<vault>/connectors/whatsapp/` to remove local state.

## What's inside

```
.
├── install.sh                                    # interactive installer (12 steps)
├── README.md
├── LICENSE                                       # MIT
├── .gitignore                                    # excludes runtime state
├── scripts/                                      # connector source code
│   ├── daemon.mjs                                # long-running Baileys process
│   ├── mcp-server.mjs                            # MCP tools for Claude Code
│   ├── sync.mjs                                  # one-shot QR pairing + history export
│   ├── send.mjs / send-document.mjs              # standalone send helpers
│   ├── download_wa_photo.mjs                     # contact photo helper
│   ├── wa-fix.py                                 # self-healing doctor + fix
│   ├── wa-watchdog.sh                            # 60s hung-daemon detector
│   ├── run-daemon.sh                             # launchd entry point (rotates logs)
│   └── package.json                              # Baileys dep, MCP SDK
└── templates/                                    # placeholders substituted at install
    ├── whatsapp-daemon.plist.template
    ├── whatsapp-watchdog.plist.template
    ├── whatsapp-mcp.sh.template
    └── SKILL.md.template
```

## Uninstall

```bash
# Read the labels you used (defaults shown):
DAEMON_LABEL="com.whatsapp-connector.daemon"
WATCHDOG_LABEL="com.whatsapp-connector.watchdog"

# Stop and remove launchd jobs
launchctl unload ~/Library/LaunchAgents/${DAEMON_LABEL}.plist
launchctl unload ~/Library/LaunchAgents/${WATCHDOG_LABEL}.plist
rm ~/Library/LaunchAgents/${DAEMON_LABEL}.plist
rm ~/Library/LaunchAgents/${WATCHDOG_LABEL}.plist

# Remove MCP launcher + skill
rm ~/.claude/whatsapp-mcp.sh
rm -rf ~/.claude/skills/whatsapp-recovery

# Remove the "whatsapp" entry from .mcp.json manually (or with jq)

# Vault scripts dir and inbox can stay (they're your conversation history)
# Uninstalling does NOT remove your WhatsApp credentials. Do it explicitly:
#   rm -rf "<vault>/connectors/whatsapp/baileys_auth" \
#          "<vault>/connectors/whatsapp"/baileys_auth_*
# Then unlink the device from your phone:
#   WhatsApp -> Settings -> Linked Devices -> tap this device -> Log out
# Your conversation markdown at <vault>/⚙️ Meta/whatsapp-inbox/ is your history;
# it stays unless you remove it yourself.
```

On your phone also remove the linked device: WhatsApp → Settings → Linked Devices → tap the daemon entry → Log out.

## Author

[Danny Bravo](https://github.com/danilobrando) — built end-to-end while productizing a personal Obsidian / second-brain stack. Issues and pull requests welcome.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web protocol client.
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk) — MCP server toolkit.
- [pino](https://github.com/pinojs/pino) — structured logging.
- [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) — QR rendering for pairing.

Baileys is third-party software that interacts with WhatsApp via the same protocol WhatsApp Web uses. WhatsApp has not endorsed this and may change behavior at any time. Use at your own risk and in accordance with WhatsApp's Terms of Service.
