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
for f in logs/daemon-stderr.log logs/daemon-stdout.log; do
  if [ -f "$f" ] && [ -s "$f" ]; then
    mv -f "$f" "${f}.prev" 2>/dev/null
  fi
done

exec node daemon.mjs
