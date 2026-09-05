#!/bin/bash
# whatsapp-vault-connector
# Copyright (c) 2026 Danny Bravo
# MIT License — see LICENSE
# https://github.com/danilobrando/whatsapp-vault-connector

# Rotate the launchd-managed stderr/stdout on every startup so doctor checks
# can distinguish fresh decrypt failures from historical ones. The internal
# pino log (logs/daemon.log) is rotated by the daemon itself when > 10MB.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$(dirname "$0")" || exit 1

mkdir -p logs

# NOTE: do NOT rename logs/daemon-stderr.log here. launchd opens the file and
# hands us the descriptor BEFORE this script runs, so a rename moves the inode
# the daemon is about to write into, leaving the canonical path permanently
# absent. That is not cosmetic: wa-fix.py's session-keys check reads that path,
# found nothing, and reported "clean slate" — a hard PASS by absence of input —
# for the entire 28-day outage of Aug 2026. Rotation is handled inside the
# daemon by copy-truncate, which keeps the descriptor valid.

exec node daemon.mjs
