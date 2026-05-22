#!/bin/bash
# whatsapp-vault-connector
# Copyright (c) 2026 Danny Bravo
# MIT License — see LICENSE
# https://github.com/danilobrando/whatsapp-vault-connector

# update.sh: refresh an existing install with the latest code from this repo.
#
# Preserves:
#   - baileys_auth/        (Signal Protocol identity — never re-pair)
#   - baileys_store.json   (cached contact metadata)
#   - .message_store.json  (persisted msgIds for getMessage retries)
#   - .daemon_state.json   (processed-ids dedup)
#   - logs/                (historical pino logs + watchdog log)
#   - node_modules/        (only re-installs if package-lock.json changed)
#
# Replaces:
#   - All *.mjs, *.py, *.sh source files
#   - package.json / package-lock.json
#   - ~/Library/LaunchAgents/com.whatsapp-connector.{daemon,watchdog}.plist
#   - ~/.claude/whatsapp-mcp.sh
#   - ~/.claude/skills/whatsapp-recovery/SKILL.md
#
# After: restarts the daemon + watchdog and runs wa-fix doctor.

set -e
set -u

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say()  { echo "$*"; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
err()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; }

# ── Detect existing install ──────────────────────────────────────────────────

LAUNCHD_LABEL_DAEMON="${WHATSAPP_DAEMON_LABEL:-com.whatsapp-connector.daemon}"
LAUNCHD_LABEL_WATCHDOG="${WHATSAPP_WATCHDOG_LABEL:-com.whatsapp-connector.watchdog}"
DAEMON_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_DAEMON}.plist"

if [ ! -f "$DAEMON_PLIST" ]; then
  err "No existing install detected at $DAEMON_PLIST."
  err "Run install.sh first (this script only updates an existing install)."
  exit 1
fi

SCRIPTS_DIR="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$DAEMON_PLIST" 2>/dev/null || true)"
if [ -z "${SCRIPTS_DIR}" ] || [ ! -d "$SCRIPTS_DIR" ]; then
  err "Could not read WorkingDirectory from $DAEMON_PLIST or directory missing."
  exit 1
fi
ok "Detected install at: $SCRIPTS_DIR"

# Read the existing env settings from the daemon plist so we re-substitute
# templates with the SAME values (preserves sender name + tz across updates).
SENDER_NAME_EXISTING="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:WA_SENDER_NAME' "$DAEMON_PLIST" 2>/dev/null || echo 'Me')"
TZ_EXISTING="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:WA_TZ' "$DAEMON_PLIST" 2>/dev/null || echo 'America/Bogota')"
ok "Preserving sender name: $SENDER_NAME_EXISTING, timezone: $TZ_EXISTING"

# ── Pull latest from origin ──────────────────────────────────────────────────

bold "Step 1/7: Pulling latest from origin"
if [ -d "$PKG_DIR/.git" ]; then
  BEFORE="$(cd "$PKG_DIR" && git rev-parse --short HEAD)"
  (cd "$PKG_DIR" && git pull --ff-only origin main)
  AFTER="$(cd "$PKG_DIR" && git rev-parse --short HEAD)"
  if [ "$BEFORE" = "$AFTER" ]; then
    say "  Already on latest commit ($AFTER). Nothing to pull."
  else
    ok "Pulled $BEFORE → $AFTER"
    (cd "$PKG_DIR" && git log --oneline "$BEFORE..$AFTER" | sed 's/^/  /')
  fi
else
  warn "$PKG_DIR is not a git checkout. Skipping pull; using local files as-is."
fi

# ── Compare package-lock to decide if npm install is needed ──────────────────

NEED_NPM=0
if [ ! -f "$SCRIPTS_DIR/package-lock.json" ] || ! cmp -s "$PKG_DIR/scripts/package-lock.json" "$SCRIPTS_DIR/package-lock.json"; then
  NEED_NPM=1
fi

# ── Stop daemon (will be restarted at the end) ───────────────────────────────

bold "Step 2/7: Stopping daemon + watchdog"
launchctl unload "$DAEMON_PLIST" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_WATCHDOG}.plist" 2>/dev/null || true
sleep 2
ok "Stopped."

# ── Copy code files (preserving state) ───────────────────────────────────────

bold "Step 3/7: Copying source files into $SCRIPTS_DIR"
mkdir -p "$SCRIPTS_DIR/logs"
for f in daemon.mjs sync.mjs mcp-server.mjs send.mjs send-document.mjs download_wa_photo.mjs wa-fix.py wa-watchdog.sh run-daemon.sh package.json package-lock.json; do
  if [ -f "$PKG_DIR/scripts/$f" ]; then
    cp "$PKG_DIR/scripts/$f" "$SCRIPTS_DIR/$f"
  fi
done
chmod +x "$SCRIPTS_DIR/run-daemon.sh" "$SCRIPTS_DIR/wa-watchdog.sh" "$SCRIPTS_DIR/wa-fix.py"
ok "Source files updated."

# ── npm install only if dependencies changed ─────────────────────────────────

if [ $NEED_NPM -eq 1 ]; then
  bold "Step 4/7: Updating npm dependencies (package-lock changed)"
  (cd "$SCRIPTS_DIR" && npm install --silent --no-audit --no-fund) || {
    err "npm install failed. Re-run after fixing network."
    exit 1
  }
  ok "Dependencies updated."
else
  bold "Step 4/7: Skipping npm install (package-lock unchanged)"
  ok "node_modules preserved."
fi

# ── Regenerate templated files (plists, MCP launcher, SKILL) ─────────────────

substitute() {
  local template="$1"; local out="$2"
  python3 - "$template" "$out" "$SCRIPTS_DIR" "$LAUNCHD_LABEL_DAEMON" "$LAUNCHD_LABEL_WATCHDOG" "$SENDER_NAME_EXISTING" "$TZ_EXISTING" <<'PYEOF'
import sys
template, out, scripts_dir, label_d, label_w, sender, tz = sys.argv[1:]
with open(template, 'r', encoding='utf-8') as f:
    content = f.read()
content = (content
    .replace('__SCRIPTS_DIR__', scripts_dir)
    .replace('__LAUNCHD_LABEL_DAEMON__', label_d)
    .replace('__LAUNCHD_LABEL_WATCHDOG__', label_w)
    .replace('__SENDER_NAME__', sender)
    .replace('__TZ__', tz))
with open(out, 'w', encoding='utf-8') as f:
    f.write(content)
PYEOF
}

bold "Step 5/7: Regenerating launchd plists + MCP launcher + skill from templates"
substitute "$PKG_DIR/templates/whatsapp-daemon.plist.template" "$DAEMON_PLIST"
substitute "$PKG_DIR/templates/whatsapp-watchdog.plist.template" "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_WATCHDOG}.plist"
substitute "$PKG_DIR/templates/whatsapp-mcp.sh.template" "$HOME/.claude/whatsapp-mcp.sh"
chmod +x "$HOME/.claude/whatsapp-mcp.sh"
mkdir -p "$HOME/.claude/skills/whatsapp-recovery"
substitute "$PKG_DIR/templates/SKILL.md.template" "$HOME/.claude/skills/whatsapp-recovery/SKILL.md"
ok "Templates regenerated."

# ── Reload launchd jobs ─────────────────────────────────────────────────────

bold "Step 6/7: Reloading launchd jobs"
launchctl load "$DAEMON_PLIST"
launchctl load "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_WATCHDOG}.plist"
sleep 8
ok "Reloaded."

# ── Verify ──────────────────────────────────────────────────────────────────

bold "Step 7/7: Verifying with wa-fix doctor"
say ""
WHATSAPP_DAEMON_LABEL="$LAUNCHD_LABEL_DAEMON" WHATSAPP_WATCHDOG_LABEL="$LAUNCHD_LABEL_WATCHDOG" python3 "$SCRIPTS_DIR/wa-fix.py" doctor || true

say ""
bold "Update complete."
say ""
say "If anything looks off above, run: python3 \"$SCRIPTS_DIR/wa-fix.py\" fix"
say ""
say "Note: the MCP server is launched on-demand by Claude Code. Restart any"
say "open Claude Code session to pick up the new MCP server code."
