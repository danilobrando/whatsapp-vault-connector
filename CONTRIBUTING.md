# Contributing

This is a solo-maintained project that runs in production on exactly one vault.
Be warned accordingly: I will be slow, and I will say no to things that add
surface area I cannot keep alive.

## What I will happily take

- Bug reports with `python3 scripts/wa-fix.py doctor --json` output attached
  (it contains no message content — check it before pasting if you like)
- Fixes for assumptions that only hold on my machine: paths, locale, timezone,
  vault layout, macOS version
- Documentation that makes a failure mode less surprising

## What I will probably decline

- Auto-reply / bot features. This connector deliberately does not answer messages.
- Anything that widens the WhatsApp automation surface, given the ban risk.
- Linux or Windows ports. `launchd` is load-bearing here and I cannot test them.

## Ground rules

**Never commit a real phone number, JID or group ID.** A `pre-commit` hook
enforces this; install it after cloning:

```bash
ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit
```

This is not theoretical. The first public history of this repo carried real
third-party phone numbers in every commit and had to be deleted outright. Use
`15551234567@s.whatsapp.net` and `120363000000000000@g.us` in examples.

## Before opening a PR

```bash
node --check scripts/daemon.mjs && node --check scripts/mcp-server.mjs \
  && node --check scripts/sync.mjs
python3 -m py_compile scripts/wa-fix.py
bash -n scripts/wa-watchdog.sh install.sh update.sh
```

There is no test suite. If you change detection logic, say in the PR how you
verified it against real behaviour — a claim that a detector works is worth
nothing without evidence that it fires.
