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

### With Claude Code (recommended)

This repository is its own plugin marketplace, so your agent can do the setup
with you:

```
/plugin marketplace add danilobrando/whatsapp-vault-connector
/plugin install whatsapp-vault-connector
```

Then just say **"set up WhatsApp in my vault"**. The plugin's skill walks
through the requirements, states the risks, runs the installer, and holds your
hand through the QR pairing. Afterwards the same skill is what repairs things
when something breaks — you say "WhatsApp isn't working" and it takes it from
there.

### By hand

```bash
git clone https://github.com/danilobrando/whatsapp-vault-connector ~/whatsapp-vault-connector
cd ~/whatsapp-vault-connector
bash install.sh
```

The installer is interactive and asks:

1. Path to your Obsidian vault root (default: `~/second-brain`)
2. Your display name as it appears on outbound messages saved to the vault
3. An optional filename suffix, e.g. `" (WhatsApp)"`, to keep conversation files
   distinguishable from your other notes
4. **Where outage alerts should go** — an email address, or your own command.
   You can leave it blank, but then the only alert is a local desktop
   notification, and `wa-fix.py doctor` will keep reminding you. Detection that
   delivers nowhere is the exact failure this project exists to prevent. Prove
   yours works with `bash wa-watchdog.sh --test-alert`.
5. Timezone

Then it copies scripts to `<vault>/connectors/whatsapp/`, **writes a
`.gitignore` there** so your Signal keys and `node_modules` cannot be committed
with your vault, installs npm dependencies, generates the launchd plists,
registers the MCP server, optionally adds a session-start hook, and walks you
through pairing.

Re-running the installer is safe. It is idempotent and unloads any running
daemon first.

**The two paths do not collide.** If the Claude Code plugin is installed,
`install.sh` and `update.sh` detect it and do **not** write a second skill into
`~/.claude/skills/` — the plugin's copy is the maintained one and updates with
the plugin. A skill left over from a pre-plugin install is retired to
`SKILL.md.superseded-by-plugin` rather than left to compete. Set
`WA_FORCE_SKILL=1` if you want a standalone copy anyway.

### Updating

```bash
bash ~/whatsapp-vault-connector/update.sh
```

It preserves your settings — display name, timezone, filename suffix and alert
configuration are read back out of the existing plists, not asked again.

## Pairing

When the installer reaches step 11, a QR code prints to the terminal. On your phone:

- Open WhatsApp
- Settings → Linked Devices → Link a Device
- Point the camera at the QR code on your laptop screen

After "Connected" appears, the script continues to download recent message history. For accounts with thousands of chats this can take several minutes. Let it finish before continuing.

## Daily use

You don't type commands. When you notice something wrong with WhatsApp — messages stuck on "processing", chats not appearing in the vault, can't send — just tell Claude Code in plain language. The `whatsapp-recovery` skill is loaded globally and the agent will run the diagnostic and either auto-repair or guide you through any manual fix.

If you ever want to drive it yourself:

```bash
WA="<vault>/connectors/whatsapp"

python3 "$WA/wa-fix.py" doctor          # read-only diagnostic
python3 "$WA/wa-fix.py" doctor --json   # verdict + escalate, for tooling
python3 "$WA/wa-fix.py" fix             # diagnose, then auto-repair what it can
python3 "$WA/wa-fix.py" repair          # full re-pair — needs your phone, ~6 min
python3 "$WA/wa-fix.py" version

bash "$WA/wa-watchdog.sh" --test-alert  # prove your alert channel works
```

Exit codes: `0` healthy · `1` degraded, auto-fixable · `2` needs your phone ·
`3` aborted · `4` hard error.

`repair` wipes the current session before showing you a QR, so the connector is
fully down until you scan. Have your phone in hand before you start, and know
that messages missed during an outage are not recovered — they are on your
phone, they were never delivered here.

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

## What the diagnostic checks

Generated from `wa-fix.py` by `scripts/gen-docs.py`, so it cannot drift from the
code. Run `python3 scripts/gen-docs.py --check` to verify.

| Check | If it fails |
|---|---|
| `inbound-freshness` | `repair` — needs your phone |
| `launchd-plist` | reported, manual |
| `auth-dir` | `repair` — needs your phone |
| `daemon-process` | `fix` — automatic |
| `daemon-lock` | `fix` — automatic |
| `heartbeat` | `fix` — automatic |
| `wa-connection` | reported, manual |
| `ipc` | `fix` — automatic |
| `secret-perms` | `fix` — automatic |
| `logs-dir` | `fix` — automatic |
| `session-keys` | `repair` — needs your phone |
| `daemon-state` | `repair` — needs your phone |
| `key-inventory` | `repair` — needs your phone |
| `alert-channel` | reported, manual |
| `send-provenance` | reported, manual |
| `stability` | reported, manual |
| `code-identity` | reported, manual |
| `msgstore` | reported, manual |

18 checks. `inbound-freshness` runs first and is the only one that can veto a healthy verdict.

`python3 wa-fix.py doctor --json` returns a `verdict` and an `escalate` field
(`none` / `fix` / `repair`) so tooling reads a decision instead of parsing
prose. Exit codes: `0` healthy, `1` degraded and auto-fixable, `2` needs your
phone, `3` aborted, `4` hard error.

## Privacy and security

- `baileys_auth/` contains your WhatsApp Signal Protocol identity and session keys. Treat it as your highest-sensitivity secret. Mode is set to `0700/0600` on install and auto-fixed by `wa-fix` if it drifts.
- The IPC socket lives at `<install>/.run/daemon.sock` inside a `0700` directory — deliberately **not** in `/tmp`, which is world-writable. It is mode `0600`, but it **does not authenticate its caller**: any process running as your user can send WhatsApp messages in your name. See [SECURITY.md](SECURITY.md) for the full list of known gaps.
- The installer writes a `.gitignore` into the install directory so your Signal keys, message store and `node_modules` cannot be committed with your vault. **Verify it is there** if your vault is a git repo — this directory sits inside your vault.
- Markdown files in `⚙️ Meta/whatsapp-inbox/` contain plaintext message history. If your vault is synced via Dropbox / iCloud / git, you are placing this content with those providers — that's a decision you make, not a property of the connector. The `.gitignore` in this repo excludes `baileys_auth/`, `node_modules/`, logs, and runtime state files, but does not exclude your vault content (which lives outside the repo).
- For revocation: WhatsApp → Settings → Linked Devices → unlink the daemon entry. That invalidates the keys server-side. Then delete the `baileys_auth/` directory inside `<vault>/connectors/whatsapp/` to remove local state.

## What's inside

```
.
├── .claude-plugin/                               # makes this repo a Claude Code plugin
│   ├── plugin.json                               #   + its own marketplace
│   └── marketplace.json
├── skills/whatsapp-connector/SKILL.md            # the skill your agent installs
├── install.sh                                    # interactive installer
├── update.sh                                     # in-place upgrade, preserves settings
├── README.md · CHANGELOG.md · CHANGELOG.es.md
├── SECURITY.md                                   # assets, controls, known gaps
├── CONTRIBUTING.md
├── LICENSE                                       # MIT
├── .gitignore                                    # excludes runtime state
├── scripts/                                      # connector source code
│   ├── daemon.mjs                                # long-running Baileys process
│   ├── mcp-server.mjs                            # MCP tools for Claude Code
│   ├── sync.mjs                                  # one-shot QR pairing + history export
│   ├── send.mjs / send-document.mjs              # standalone send helpers
│   ├── download_wa_photo.mjs                     # contact photo helper
│   ├── wa-fix.py                                 # self-healing doctor + fix
│   ├── atomic-auth-state.mjs                     # crash-safe Signal key writes
│   ├── wa-watchdog.sh                            # 60s liveness + reception detector
│   ├── gen-docs.py                               # regenerates the check table
│   ├── hooks/pre-commit                          # blocks real numbers from commits
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

# If you installed via the plugin, remove it from Claude Code as well:
#   /plugin uninstall whatsapp-vault-connector
#
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

This project's own code is **MIT**. See [LICENSE](LICENSE).

**But read this before you build on it.** The connector cannot run without
`libsignal` (`@whiskeysockets/libsignal-node`), which is **GPL-3.0** and is a
required runtime dependency of Baileys — it is the Signal Protocol
implementation, so there is no version of this that works without it. Baileys is
itself published as MIT while depending on it; the tension is inherited, not
introduced here.

Running it yourself carries no obligation — copyleft attaches to distribution,
not use. **Shipping a product built on this is a different question**: the
combined work you would distribute contains GPL-3.0 code. If that matters to
you, read [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) and take advice
before you ship. An MIT badge on this repository describes its own source, not
the licence of everything you get when you install it.

## Acknowledgements

- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web protocol client.
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk) — MCP server toolkit.
- [pino](https://github.com/pinojs/pino) — structured logging.
- [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) — QR rendering for pairing.

Baileys is third-party software that interacts with WhatsApp via the same protocol WhatsApp Web uses. WhatsApp has not endorsed this and may change behavior at any time. Use at your own risk and in accordance with WhatsApp's Terms of Service.
