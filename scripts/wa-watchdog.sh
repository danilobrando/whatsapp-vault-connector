#!/bin/bash
# whatsapp-vault-connector
# Copyright (c) 2026 Danny Bravo
# MIT License — see LICENSE
# https://github.com/danilobrando/whatsapp-vault-connector

# wa-watchdog.sh: periodic check that the WhatsApp daemon is alive AND not hung.
#
# Designed to run as a launchd job every 60s. Reads .daemon_heartbeat;
# if the daemon process exists but the heartbeat is stale (> 90s), the
# process is alive-but-frozen (event loop hung) and launchctl KeepAlive
# won't catch it. We force-restart via launchctl kickstart.
#
# Safe to run from any context. Logs to logs/watchdog.log.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HEARTBEAT="$SCRIPT_DIR/.daemon_heartbeat"
LOGFILE="$SCRIPT_DIR/logs/watchdog.log"
# Label is set by the launchd watchdog plist via WHATSAPP_DAEMON_LABEL env var.
# Fallback is provided for ad-hoc runs in dev.
DAEMON_LABEL="${WHATSAPP_DAEMON_LABEL:-com.whatsapp-connector.daemon}"
STALE_SECONDS=90

mkdir -p "$(dirname "$LOGFILE")"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOGFILE"
}

PID="$(pgrep -f 'daemon.mjs' | head -1 || true)"

if [ -z "$PID" ]; then
  log "daemon NOT running; kickstart"
  launchctl kickstart -k "gui/$(id -u)/$DAEMON_LABEL" >/dev/null 2>&1
  exit 0
fi

if [ ! -f "$HEARTBEAT" ]; then
  # No heartbeat yet (just started). Tolerate.
  exit 0
fi

# Use stat -f for macOS, fall back to stat -c for Linux.
MTIME="$(stat -f %m "$HEARTBEAT" 2>/dev/null || stat -c %Y "$HEARTBEAT" 2>/dev/null || echo 0)"
NOW="$(date +%s)"
AGE=$((NOW - MTIME))

if [ "$AGE" -gt "$STALE_SECONDS" ]; then
  log "daemon PID $PID alive but heartbeat ${AGE}s stale (>${STALE_SECONDS}s); kickstart"
  # Kill and let launchd restart it (KeepAlive on SuccessfulExit=false)
  kill -KILL "$PID" 2>/dev/null
  sleep 2
  launchctl kickstart -k "gui/$(id -u)/$DAEMON_LABEL" >/dev/null 2>&1
fi

exit 0
