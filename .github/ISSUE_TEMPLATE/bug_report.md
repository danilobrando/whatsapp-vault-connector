---
name: Something is broken
about: The connector is not doing what it should
labels: bug
---

**Run this first and paste the output.** It contains no message content — only
check names and counts.

```bash
python3 scripts/wa-fix.py doctor --json
```

```
(paste here)
```

**What you expected vs what happened**

**Is it sending, receiving, or both?**
They fail independently — outbound worked for 28 days straight during a total
reception outage, so "WhatsApp is broken" is not enough to go on.

- [ ] Sending is broken
- [ ] Receiving is broken
- [ ] Claude Code cannot see the MCP tools

**Environment**
- macOS version:
- Node version (`node -v`):
- Connector version (`grep version scripts/package.json`):
- Vault is synced by (iCloud / Dropbox / git / nothing):

**Relevant log lines** (`scripts/logs/daemon.log` — redact message text)
