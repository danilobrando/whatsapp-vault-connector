# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/)

English is canonical. A fuller Spanish account, written as the work happened,
is kept alongside in [CHANGELOG.es.md](CHANGELOG.es.md).

## [2.11.0] — 2026-09-07

### Changed
- **The MIT badge is no longer unqualified.** This connector cannot run without
  `libsignal` (`@whiskeysockets/libsignal-node`), which is **GPL-3.0** and is a
  required runtime dependency of Baileys — it is the Signal Protocol
  implementation. Baileys is itself published as MIT while depending on it; the
  tension is inherited, not introduced here. An unqualified MIT badge told
  adopters something false about what they get when they install this.

  This project's own code stays MIT, which is accurate. The README, `LICENSE`
  and a new **`THIRD-PARTY-LICENSES.md`** now say plainly that running it
  carries no obligation, and that shipping a product built on it is a different
  question because the combined work contains GPL-3.0 code.

### Added
- **`scripts/gen-licenses.py`** generates the inventory from the installed tree.
  A hand-written license list goes stale on the first dependency bump, and a
  stale one is worse than none — it tells an adopter something false about their
  obligations. `--check` fails when a copyleft or undeclared dependency appears
  that the document does not disclose.

### Fixed
- `gen-docs.py --check` now catches hand-written check counts anywhere in the
  README, not just the generated table. A stray "17 checks" line survived three
  releases beside a generated "18 checks" one — exactly the drift that script
  exists to prevent.

## [2.10.1] — 2026-09-07

### Added
- **Audit retention.** `audit.jsonl` grew one line per send with no policy — an
  unbounded file of send metadata that nobody would ever prune, which is a
  privacy problem before it is a disk one. It now rotates at 5 MB into dated
  archives and prunes them after 90 days (`WA_AUDIT_MAX_BYTES`,
  `WA_AUDIT_RETENTION_DAYS`).

  Rotation is by size, retention by age: forensic value here is time-based, not
  volume-based. Archives are dated rather than a single `.1` destroyed each
  cycle — that mistake already cost this project its forensic window once, in
  the daemon log. **Pruning is recorded in the live trail**, because an audit
  log that silently loses entries is indistinguishable from a tampered one.
- `WA_AUDIT_ROTATE_MS` makes the interval configurable, so the policy can be
  exercised in a test instead of taken on faith for an hour at a time.

## [2.10.0] — 2026-09-07

The three security gaps `SECURITY.md` had been declaring. Two are closed; the
third cannot be closed and is now stated as a permanent limit with detection
built around it instead.

### Added
- **Atomic Signal auth store.** Baileys writes key files with a plain
  `writeFile`, so a kill landing mid-write leaves a corrupt credential whose
  only recovery is a full QR re-pair — and killing a wedged daemon is exactly
  what the watchdog does. `atomic-auth-state.mjs` writes to a temp file and
  renames, and sweeps temps left by a previous hard kill. It owns only the I/O:
  credential shape, serialisation and protobuf decoding remain Baileys' own, and
  if it fails to load the daemon falls back to the stock writer rather than
  refusing to start. Verified byte-identical reads against a live auth store.
- **`audit.jsonl`** (mode `0600`): every outbound attempt — accepted, rejected or
  blocked — recorded with the caller's self-reported label, the target, a byte
  count and an 8-char digest. **The message body is never written**, so the trail
  cannot become a second copy of your conversations.
- **`send-provenance` check** (18 checks now). Reports sends from callers you did
  not expect; configure with `WA_EXPECTED_SEND_CLIENTS`.

### Changed
- `SECURITY.md` now says the IPC socket **cannot** authenticate its peer, rather
  than implying a fix is pending. Node exposes no way to read a Unix socket's
  peer uid without a native addon, and any token would be readable by the very
  processes it would need to exclude — so no token is shipped. The `0700` run
  directory is the boundary; attribution and detection are what stand in for a
  gate that is not available.

## [2.9.1] — 2026-09-07

### Changed
- **`install.sh` and `update.sh` detect the Claude Code plugin** and no longer
  write a second skill into `~/.claude/skills/`. Two overlapping sets of
  instructions for the same connector do not conflict outright, but the agent
  has to pick one and one of them goes stale the moment the plugin updates. The
  plugin's copy is the maintained one, so it wins. A skill left from a
  pre-plugin install is retired to `SKILL.md.superseded-by-plugin`.
  `WA_FORCE_SKILL=1` overrides. Detection reads Claude Code's plugin registry
  and falls back to the plugin cache if that format changes.
- Only the skill is conditional: `update.sh` still regenerates the launchd
  plists and the MCP launcher either way, since those carry this install's own
  paths and settings and the plugin does not provide them.

## [2.9.0] — 2026-09-07

Packaged as a Claude Code plugin, and the last of the productization findings.

### Added
- **Installable as a Claude Code plugin.** The repository is its own plugin
  marketplace, so any Claude Code user can add it and let their agent drive the
  rest of the setup.
- `WA_LANG` is not needed: the skill now carries bilingual trigger phrases
  (English and Spanish) with English as the working language.

### Changed
- **English is the project language.** The skill, alert emails and this
  changelog are in English; the original Spanish changelog is preserved as
  `CHANGELOG.es.md`.
- `sync.mjs` reads `WA_INBOX_PATH`, the variable the README documents and the
  daemon already used. It previously read `WA_OUTPUT` and treated it as
  vault-relative, so anyone setting `WA_INBOX_PATH` got their pairing export
  written somewhere other than where live messages landed. `WA_OUTPUT` remains
  as a legacy alias.
- `wa-fix.py repair` passes the daemon's own configuration to the pairing
  export, so the two cannot disagree about where conversations go.
- The skill no longer hardcodes the clone location; the installer substitutes
  the real path.

## [2.8.1] — 2026-09-05

### Fixed
- **`DRIFT_DETECTED` blocked sending because of a flaky network.** The rule was
  "many reconnects AND zero successful sends", and that invariant is false: zero
  successful sends almost always means nobody tried to send, not that sending is
  broken. Observed on 2026-09-05 — five reconnects from transient timeouts
  (codes 408/405), nobody sending, and the daemon began refusing outbound while
  reception was demonstrably fine (447 inbound from 29 contacts that day).

  Drift now requires positive evidence that messages are not getting through:
  `decryptFail1h >= 30`, or 18h+ of inbound silence once a full 24h window has
  actually been observed.
- **New `UNSTABLE` state** for reconnect churn with no evidence of failure.
  Surfaced as a warning, never blocking sends — punishing the user for a flaky
  network fixes nothing.

## [2.8.0] — 2026-09-05

Findings from a productization review before publishing. Three were blocking,
and all three only bite someone who is not the author.

### Fixed
- **`python` → `python3` everywhere.** The proactive auto-recovery hook and the
  skill invoked `python`, which has not existed on a stock macOS since 12.3. The
  headline self-healing feature was dead on arrival for anyone with a clean Mac.
- **The installer now writes a `.gitignore` inside the vault.** It placed
  `baileys_auth/` — the credential that authenticates the machine *as* your
  WhatsApp — plus the message store, logs and ~80 MB of `node_modules` inside
  the user's notes directory with no ignore file there. A `git add -A` in a
  versioned vault published the keys.
- **The daemon can no longer overwrite an existing conversation.**
  `resolveFilePath` wrote frontmatter unconditionally when a jid was missing
  from the index. Combined with the next item, a new user on default settings
  lost their group history on the first incoming group message.
- **`sync.mjs` writes `jid:` for groups**, not `phone:`. The daemon's index maps
  `phone:` to `<digits>@s.whatsapp.net`, which can never match a real `@g.us`,
  so exported groups were invisible to it.
- **`send.mjs` and `send-document.mjs` refuse to run beside the daemon.** They
  opened a second Baileys session against the same `baileys_auth/`; two
  processes writing one Signal store is a direct route to the drift this
  project exists to detect.
- **The MCP launcher carries configuration.** Claude Code spawns it with a bare
  environment, so without `WA_INBOX_SUFFIX` the server resolved contact names
  incorrectly.
- One version number across the release; `wa-fix.py` announced itself as v0.1.0
  while the package was at 2.x.
- Alerts no longer quote the author's vault statistics as if they were the
  reader's.

## [2.7.0] — 2026-09-05

### Fixed
- **No hardcoded alert recipient.** `wa-watchdog.sh` shipped the author's
  personal email as the default: anyone installing this mailed their outage
  alerts to the author's inbox, and the channel read as configured when it was
  not.
- **The alert channel no longer depends on the author's vault.** It previously
  invoked a mail script that exists only on the author's machine, so on a fresh
  install the headline feature of v2.5.0 silently did nothing. Now pluggable:
  `WA_ALERT_COMMAND`, or `ALERT_EMAIL` with a mail sender / `mail` / `sendmail`.
- **Alert settings travel in the watchdog plist.** launchd does not inherit the
  shell environment, so exporting them from a shell profile did nothing.

### Added
- **`alert-channel` check.** Detection that delivers nowhere reproduces the very
  failure this project exists to prevent, so a missing channel is a finding.
- **`wa-watchdog.sh --test-alert`** to prove the escalation path works before
  you need it. It reads the plist, not the shell, so the drill exercises the
  same path the scheduled job will use.
- README leading with the risks, `SECURITY.md` declaring known gaps rather than
  hiding them, `CONTRIBUTING.md`, and issue templates.

## [2.6.0] — 2026-09-05

Twenty-four findings from a five-expert hardening review.

### Security
- `process.umask(0o077)` in the daemon. Baileys rewrites Signal key files every
  few minutes with no mode, so a reactive `chmod` could never win that race — a
  chmod of 145 key files was undone within minutes.
- The IPC socket moved out of `/tmp` (mode 1777, reachable by every process on
  the machine) into a `0700` run directory. It accepts `send` unauthenticated.
- Pairing artifacts moved out of `/tmp` and the QR — a live credential — is
  deleted after use.
- Permission checking covers the whole secret inventory, not just
  `baileys_auth/`: it found **11,541** loose files across the message stores,
  state and historical backups.
- `secret-perms` is `FAIL`, not a warning. As a warning it could never trip an
  alert, because `doctor` exited 0 on warnings.
- `repair` hardens and prunes: backups are created `0700`, excluded from Time
  Machine, and only the two most recent are kept.

### Fixed
- **The reconnect chain could die permanently.** After two consecutive failures
  the inner catch swallowed the error without rescheduling, leaving a live
  process with a fresh heartbeat that every check called healthy.
- `connect()` re-entered without tearing down the previous socket, inflating the
  reconnect counter `DRIFT_DETECTED` is derived from.
- **Log rotation renamed a file with an open descriptor**, so the daemon kept
  writing to the renamed inode and the canonical path never existed — the root
  cause of `session-keys` reporting "clean slate" forever, by absence of input.
- `sync.mjs`, the documented recovery step, no longer overwrites vault history.
- Atomic vault writes; the contact store (~316 MB) is parsed once, not on every
  reconnect.

### Added
- `doctor --json` with `verdict` and `escalate`, and discrete exit codes, so the
  skill reads a field instead of regexing column-aligned prose.
- `daemon-state` and `key-inventory` checks.
- `session-keys` reads an in-process rate. A log grep counted 44 where the real
  number of undecryptable messages was 8 — it was counting stack-trace lines.

## [2.5.0] — 2026-09-05

**The reason this health layer exists.**

From 8 August to 5 September 2026 this connector received nothing for 28 days
and nothing noticed. The daemon reported `connected: true` the whole time, sent
outbound messages every day, and `doctor` — run by hand on day 25 — printed
`12 passed, 0 failed`.

Every check measured whether the process was breathing. None asked whether
messages were arriving. The one freshness field it published was written by both
the send path and the receive path, so the vault's own scheduled reminders kept
it looking fresh through total deafness: the alert channel was feeding the
blindness.

### Added
- **Inbound/outbound signal separation.** `lastInboundRealAt` moves only for a
  third-party message; own echoes and self-sends go elsewhere. Plus
  `inboundReal24h`, `inboundRealJids24h`, `decryptFail1h/24h`,
  `signalWindowComplete`.
- **Signal decrypt-failure capture** via `messageStubType === 2` — the earliest
  drift signal available. In the August incident it would have fired within the
  first hour. The old code discarded it at `if (!text) continue`.
- **`inbound-freshness` check**, first in the list and the only one that can veto
  a healthy verdict. `WARN` at 9h, `FAIL` at 18h — thresholds derived from 219
  days of a real inbox (158,818 inbound events) where the longest legitimate
  quiet gap ever measured was 16.9h, giving zero false positives on the record.
- **`UNKNOWN` status.** Absence of evidence is never `PASS`.
- **The watchdog escalates out of band** (email plus a local notification), with
  a cooldown, an expiring mute, and a remediation budget. It never alerts over
  WhatsApp: doing so writes into the very inbox the detector reads.
- `.wa-health.jsonl`, one line per run, as the dead-man source.
- `WA_INBOX_SUFFIX` for configurable conversation filenames.

### Removed
- `lastMessageAt`. Deleted rather than reinterpreted: while it existed, someone
  would use it again.

## [2.4.1] — 2026-09-05

Republished from a clean tree. The previous history (7 commits, 2026-05-21 to
2026-05-31) carried real third-party phone numbers, a real group id and two
personal names used as examples. None of those people consented. Rewriting
history was not enough — GitHub retains unreachable objects — so the repository
was deleted and recreated.

### Security
- Real identifiers replaced with placeholders; `download_wa_photo.mjs` takes its
  jid and output path from `process.argv`.
- **`scripts/hooks/pre-commit`** blocks any commit containing a WhatsApp JID or a
  real-looking international number.

## Earlier

v2.0–v2.4 predate the rewritten history. See `CHANGELOG.es.md` for what those
releases contained.
