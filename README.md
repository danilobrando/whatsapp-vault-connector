# whatsapp-vault-connector

Self-healing WhatsApp connector for Obsidian / second-brain vaults on macOS.

By [Danny Bravo](https://github.com/danilobrando) · MIT License

- A long-running daemon ([Baileys](https://github.com/WhiskeySockets/Baileys)) keeps a WhatsApp Multi-Device session alive on your laptop.
- Incoming messages from individual chats and groups are appended to per-conversation markdown files inside your vault, organized by date headers.
- An MCP server exposes `whatsapp_send`, `whatsapp_search_contacts`, `whatsapp_read_recent`, `whatsapp_daemon_status` tools to Claude Code.
- A watchdog detects hung-but-alive daemon states and restarts the daemon.
- A diagnostic + auto-repair tool (`wa-fix.py`) detects 11 failure modes and fixes 8 of them automatically. For the rest, it prints the exact step-by-step manual instructions.
- A Claude Code skill (`whatsapp-recovery`) makes the agent run `wa-fix` automatically when the user reports anything wrong with WhatsApp, and walks them through any manual steps in plain language.

The persistent `messageStore` in `scripts/daemon.mjs` is the root-cause fix for the recurring "messages stuck on processing on the sender device" bug: Baileys' `getMessage` callback now survives daemon restarts, so when your phone retries asking for a message after a disconnect, the daemon can actually answer instead of returning `undefined` and leaving the phone stuck forever.

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

The installer is interactive but only asks three things:

1. Path to your Obsidian vault root (default: `~/second-brain`)
2. Your display name as it should appear on outbound messages saved to the vault (default: `Me`)
3. Timezone (default: `America/Bogota`)

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
- The Unix socket at `/tmp/whatsapp-daemon.sock` is mode `0600`. Only your own user account can talk to the daemon. Still: any process running as your user could send WhatsApp messages in your name. Don't grant shell access on your machine to untrusted parties.
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
# or be removed: rm -rf "<vault>/⚙️ Meta/scripts/whatsapp"
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
