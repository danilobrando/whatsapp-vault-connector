#!/bin/bash
# whatsapp-vault-connector
# Copyright (c) 2026 Danny Bravo
# MIT License — see LICENSE
# https://github.com/danilobrando/whatsapp-vault-connector

# whatsapp-vault-connector installer for Obsidian / second-brain vaults.
# Idempotent: safe to re-run.
#
# What it does:
#  1. Asks for: vault root, sender name shown in vault, timezone.
#  2. Substitutes paths into plist + launcher + skill templates.
#  3. Copies scripts into <vault>/⚙️ Meta/scripts/whatsapp/.
#  4. Runs `npm install` for Baileys dependencies.
#  5. Installs the launchd plists (daemon + watchdog) into ~/Library/LaunchAgents.
#  6. Installs the MCP launcher into ~/.claude/whatsapp-mcp.sh.
#  7. Installs the whatsapp-recovery skill into ~/.claude/skills/.
#  8. Registers the MCP server in .mcp.json (vault-local or global).
#  9. Optionally adds the session-start hook to ~/.claude/settings.json.
# 10. Starts QR pairing (you scan with your phone).
# 11. Loads the launchd jobs.
# 12. Runs wa-fix doctor to verify.
#
# Labels default to com.whatsapp-connector.{daemon,watchdog}. Override with
# WHATSAPP_DAEMON_LABEL and WHATSAPP_WATCHDOG_LABEL env vars if you need to
# run multiple installs on the same machine.

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

# ── Prereqs ──────────────────────────────────────────────────────────────────

bold "Step 1/12: Checking prerequisites"

missing=0
for tool in node npm python3 launchctl pgrep; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    err "Missing required tool: $tool"
    missing=1
  fi
done
if [ $missing -eq 1 ]; then
  err "Install missing tools and re-run. (Node.js from nodejs.org or 'brew install node'; Python 3 ships with macOS.)"
  exit 1
fi
ok "node $(node --version), npm $(npm --version), python $(python3 --version | awk '{print $2}')"

# ── Inputs ───────────────────────────────────────────────────────────────────

bold "Step 2/12: Configuration"

read -p "Path to your Obsidian vault root [$HOME/second-brain]: " VAULT_ROOT
VAULT_ROOT="${VAULT_ROOT:-$HOME/second-brain}"
VAULT_ROOT="${VAULT_ROOT/#~/$HOME}"
if [ ! -d "$VAULT_ROOT" ]; then
  warn "Vault root does not exist yet. Creating: $VAULT_ROOT"
  mkdir -p "$VAULT_ROOT"
fi
ok "Vault root: $VAULT_ROOT"

read -p "Your display name as it should appear on outbound messages in the vault [Me]: " SENDER_NAME
SENDER_NAME="${SENDER_NAME:-Me}"
ok "Sender name: $SENDER_NAME"

read -p "Timezone [America/Bogota]: " TZ_INPUT
TZ_VAL="${TZ_INPUT:-America/Bogota}"
ok "Timezone: $TZ_VAL"

# Labels: env override or sensible default. Default keeps the repo predictable
# across installs; env override supports multi-user / multi-install machines.
LAUNCHD_LABEL_DAEMON="${WHATSAPP_DAEMON_LABEL:-com.whatsapp-connector.daemon}"
LAUNCHD_LABEL_WATCHDOG="${WHATSAPP_WATCHDOG_LABEL:-com.whatsapp-connector.watchdog}"
# Standard install location for second-brain connectors. Keeping all connectors
# under <vault>/connectors/ avoids emoji-laden paths and groups operational
# state in one tree that's easy to back up / migrate / uninstall.
SCRIPTS_DIR="$VAULT_ROOT/connectors/whatsapp"

say ""
say "About to install with:"
say "  Scripts dir:        $SCRIPTS_DIR"
say "  Daemon label:       $LAUNCHD_LABEL_DAEMON"
say "  Watchdog label:     $LAUNCHD_LABEL_WATCHDOG"
say ""
read -p "Continue? [Y/n] " confirm
case "${confirm:-Y}" in
  [yY]*) ;;
  *) say "Aborted."; exit 0 ;;
esac

# ── Stop any existing daemon ─────────────────────────────────────────────────

bold "Step 3/12: Stopping any existing daemon (idempotent re-install)"
launchctl unload "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_DAEMON}.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_WATCHDOG}.plist" 2>/dev/null || true
ok "Previous launchd jobs unloaded (if any existed)."

# ── Copy scripts ─────────────────────────────────────────────────────────────

bold "Step 4/12: Copying scripts into vault"
mkdir -p "$SCRIPTS_DIR/logs"
cp -R "$PKG_DIR/scripts/"* "$SCRIPTS_DIR/"
chmod +x "$SCRIPTS_DIR/run-daemon.sh" "$SCRIPTS_DIR/wa-watchdog.sh" "$SCRIPTS_DIR/wa-fix.py"
ok "Copied to $SCRIPTS_DIR"

# ── Install npm dependencies ─────────────────────────────────────────────────

bold "Step 5/12: Installing npm dependencies (Baileys, etc.)"
say "  This may take 30-60 seconds the first time..."
(cd "$SCRIPTS_DIR" && npm install --silent --no-audit --no-fund) || {
  err "npm install failed. Check network and re-run installer."
  exit 1
}
ok "Dependencies installed."

# ── Substitute templates ─────────────────────────────────────────────────────

substitute() {
  # substitute <template_file> <output_file>
  local template="$1"; local out="$2"
  python3 - "$template" "$out" "$SCRIPTS_DIR" "$LAUNCHD_LABEL_DAEMON" "$LAUNCHD_LABEL_WATCHDOG" "$SENDER_NAME" "$TZ_VAL" <<'PYEOF'
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

bold "Step 6/12: Substituting paths into launchd plists"
mkdir -p "$HOME/Library/LaunchAgents"
substitute "$PKG_DIR/templates/whatsapp-daemon.plist.template" "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_DAEMON}.plist"
substitute "$PKG_DIR/templates/whatsapp-watchdog.plist.template" "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_WATCHDOG}.plist"
ok "Plists installed in ~/Library/LaunchAgents/"

bold "Step 7/12: Installing MCP launcher"
mkdir -p "$HOME/.claude"
substitute "$PKG_DIR/templates/whatsapp-mcp.sh.template" "$HOME/.claude/whatsapp-mcp.sh"
chmod +x "$HOME/.claude/whatsapp-mcp.sh"
ok "MCP launcher at ~/.claude/whatsapp-mcp.sh"

bold "Step 8/12: Installing whatsapp-recovery skill"
mkdir -p "$HOME/.claude/skills/whatsapp-recovery"
substitute "$PKG_DIR/templates/SKILL.md.template" "$HOME/.claude/skills/whatsapp-recovery/SKILL.md"
ok "Skill at ~/.claude/skills/whatsapp-recovery/"

# ── Register MCP in .mcp.json ────────────────────────────────────────────────

bold "Step 9/12: Registering the WhatsApp MCP server in .mcp.json"
MCP_JSON_VAULT="$VAULT_ROOT/.mcp.json"
MCP_JSON_GLOBAL="$HOME/.mcp.json"
TARGET_MCP_JSON=""
if [ -f "$MCP_JSON_VAULT" ]; then
  TARGET_MCP_JSON="$MCP_JSON_VAULT"
elif [ -f "$MCP_JSON_GLOBAL" ]; then
  TARGET_MCP_JSON="$MCP_JSON_GLOBAL"
else
  TARGET_MCP_JSON="$MCP_JSON_GLOBAL"
  echo '{"mcpServers":{}}' > "$TARGET_MCP_JSON"
fi

python3 - "$TARGET_MCP_JSON" "$HOME/.claude/whatsapp-mcp.sh" <<'PYEOF'
import json, sys
path, launcher = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}
data.setdefault('mcpServers', {})
data['mcpServers']['whatsapp'] = {'command': 'bash', 'args': [launcher]}
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF
ok "MCP server 'whatsapp' registered in $TARGET_MCP_JSON"

# ── Optional: session-start hook ─────────────────────────────────────────────

bold "Step 10/12: Optional session-start hook for proactive auto-recovery"
say "  This makes Claude Code run 'wa-fix --quiet' on every session start,"
say "  so issues get auto-repaired before you even notice them."
read -p "  Add the hook to ~/.claude/settings.json? [Y/n] " hook_choice
case "${hook_choice:-Y}" in
  [yY]*)
    SETTINGS_JSON="$HOME/.claude/settings.json"
    [ -f "$SETTINGS_JSON" ] || echo '{}' > "$SETTINGS_JSON"
    python3 - "$SETTINGS_JSON" "$SCRIPTS_DIR/wa-fix.py" <<'PYEOF'
import json, sys
path, wa_fix = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}
hooks = data.setdefault('hooks', {})
session_start = hooks.setdefault('SessionStart', [])
cmd_str = f"python '{wa_fix}' fix --quiet || true"
already_present = False
for entry in session_start:
    for h in (entry.get('hooks') or []):
        if h.get('command') == cmd_str:
            already_present = True
if not already_present:
    session_start.append({
        'matcher': '*',
        'hooks': [{'type': 'command', 'command': cmd_str}],
    })
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF
    ok "Session-start hook installed."
    ;;
  *)
    warn "Skipped. You can add it later from the SKILL.md instructions."
    ;;
esac

# ── Pair (QR) ────────────────────────────────────────────────────────────────

bold "Step 11/12: Pair with your phone (QR scan)"
say ""
say "A QR code will appear below. On your phone, open WhatsApp and go to:"
say "  Settings → Linked Devices → Link a Device → Scan the QR shown."
say ""
say "When you see 'Connected' and the prompt returns, the pairing is done."
say "(After pairing, the script may continue to export your message history;"
say " that part can take several minutes for accounts with thousands of chats.)"
say ""
read -p "Press Enter to continue..." _
( cd "$SCRIPTS_DIR" && WA_SENDER_NAME="$SENDER_NAME" WA_TZ="$TZ_VAL" node sync.mjs --groups )
ok "Pairing complete."

# ── Load launchd jobs ───────────────────────────────────────────────────────

bold "Step 12/12: Loading launchd jobs (daemon + watchdog)"
launchctl load "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_DAEMON}.plist"
launchctl load "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL_WATCHDOG}.plist"
sleep 8
ok "launchd jobs loaded."

# ── Verify ──────────────────────────────────────────────────────────────────

bold "Verification: running wa-fix doctor"
say ""
WHATSAPP_DAEMON_LABEL="$LAUNCHD_LABEL_DAEMON" WHATSAPP_WATCHDOG_LABEL="$LAUNCHD_LABEL_WATCHDOG" python3 "$SCRIPTS_DIR/wa-fix.py" doctor || true

say ""
bold "Done."
say ""
say "If you see any FAIL above, run:"
say "    python3 \"$SCRIPTS_DIR/wa-fix.py\" fix"
say ""
say "To test manually, ask someone to send you a WhatsApp. Within 1-2 seconds"
say "you should see a markdown file get updated in:"
say "    $VAULT_ROOT/⚙️ Meta/whatsapp-inbox/"
say ""
say "From now on, when anything is wrong with WhatsApp, just tell Claude Code"
say "in plain language. The whatsapp-recovery skill will handle it."
