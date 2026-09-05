#!/usr/bin/env python3
# whatsapp-vault-connector
# Copyright (c) 2026 Danny Bravo
# MIT License — see LICENSE
# https://github.com/danilobrando/whatsapp-vault-connector

"""
wa-fix.py: self-healing entry point for the WhatsApp connector.

Runs diagnostic checks against the Baileys daemon, applies automatic
fixes where possible, prints explicit manual steps for the rest,
re-verifies, and reports.

Mirrors the UX of ingest-outlook's `fetch.py fix`: this is THE command
to run when anything is wrong with WhatsApp. The orchestrator (the
LLM agent in Claude Code) is expected to invoke this silently when
the user reports any WhatsApp problem.

Subcommands:
  fix       Diagnose + auto-repair (default; runs if no subcommand given)
  doctor    Read-only diagnostic
  version   Print version

Flags:
  --quiet   Suppress normal output; emit a one-line stderr summary only
            when action was needed. Use from session-start hooks.

Exit codes:
  0    System healthy (or auto-healed to healthy)
  1    Manual intervention needed; instructions printed
  2    Hard error
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Single source of truth: the package version. Three different version numbers
# in one release (tool 0.1.0, package 2.x, README 2.y) is a small thing that
# makes a stranger doubt everything else.
def _pkg_version() -> str:
    try:
        import json as _j
        return _j.loads((Path(__file__).resolve().parent / "package.json")
                        .read_text(encoding="utf-8"))["version"]
    except Exception:
        return "unknown"


__version__ = _pkg_version()

SCRIPT_DIR = Path(__file__).resolve().parent
# launchd labels. The installer writes these into the plist files; defaults
# match what install.sh uses out of the box. Override with env vars if you
# customized labels (e.g. multi-user machine, multiple installs).
DAEMON_LABEL = os.environ.get("WHATSAPP_DAEMON_LABEL", "com.whatsapp-connector.daemon")
WATCHDOG_LABEL = os.environ.get("WHATSAPP_WATCHDOG_LABEL", "com.whatsapp-connector.watchdog")
HEARTBEAT_FILE = SCRIPT_DIR / ".daemon_heartbeat"

def _sensitive_paths() -> list[Path]:
    """Everything holding secrets or message content, not just baileys_auth/.

    The permission check used to look only at AUTH_DIR. Meanwhile ~450 MB of
    per-message secrets, sender keys and plaintext conversation content sat in
    the message stores and the state file at 0644, unexamined. Scope was the
    bug, not the threshold.
    """
    out = [AUTH_DIR,
           SCRIPT_DIR / ".message_store.json",
           SCRIPT_DIR / "baileys_store.json",
           SCRIPT_DIR / ".daemon_state.json",
           SCRIPT_DIR / ".run"]
    out += sorted(SCRIPT_DIR.glob("baileys_auth_pre_repair_*"))
    out += sorted(SCRIPT_DIR.glob("baileys_auth_backup_*"))
    out += sorted(SCRIPT_DIR.glob("baileys_auth_sessions_backup_*"))
    return [p for p in out if p.exists()]
LOCK_FILE = SCRIPT_DIR / ".daemon.lock"
# The daemon socket moved out of /tmp (mode 1777 — any process on the machine
# could reach a socket that accepts `send` unauthenticated) into a 0700 run
# directory. The legacy path remains as a fallback for a half-updated install.
_SOCKET_CANDIDATES = [
    Path(os.environ["WA_SOCKET_PATH"]) if os.environ.get("WA_SOCKET_PATH") else None,
    SCRIPT_DIR / ".run" / "daemon.sock",
    Path("/tmp/whatsapp-daemon.sock"),
]
SOCKET_PATH = next((p for p in _SOCKET_CANDIDATES if p and p.exists()),
                   SCRIPT_DIR / ".run" / "daemon.sock")
AUTH_DIR = SCRIPT_DIR / "baileys_auth"
LOG_FILE = SCRIPT_DIR / "logs" / "daemon.log"
STDERR_FILE = SCRIPT_DIR / "logs" / "daemon-stderr.log"
STDOUT_FILE = SCRIPT_DIR / "logs" / "daemon-stdout.log"
MSGSTORE_FILE = SCRIPT_DIR / ".message_store.json"
LAUNCHD_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{DAEMON_LABEL}.plist"

HEARTBEAT_STALE_SECONDS = 60   # 6× the new 10s heartbeat interval (was 90s for 30s interval)
HEARTBEAT_SATURATED_SECONDS = 300  # main loop sluggish but daemon likely still alive
CONNECTED_GRACE_SECONDS = 60   # daemon may be reconnecting; tolerate brief disconnects


# ---------------------------------------------------------------------------
# Logging (best-effort, matches Outlook's log.jsonl convention)
# ---------------------------------------------------------------------------

LOG_PATH = SCRIPT_DIR / "wa-fix.log.jsonl"


def _log_event(command: str, status: str, **fields) -> None:
    try:
        event = {
            "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            "command": command,
            "status": status,
            "version": __version__,
            **fields,
        }
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Diagnostic checks
# ---------------------------------------------------------------------------

class CheckResult:
    def __init__(self, status, name, detail, fix_auto=None, fix_manual=None):
        self.status = status  # PASS | WARN | FAIL
        self.name = name
        self.detail = detail
        self.fix_auto = fix_auto
        self.fix_manual = fix_manual


def _daemon_pid() -> int | None:
    """Return daemon PID if running, else None."""
    try:
        out = subprocess.run(
            ["pgrep", "-f", "daemon.mjs"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            return int(out.stdout.strip().split("\n")[0])
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    return None


def _read_heartbeat() -> tuple[dict | None, int | None]:
    """Return (parsed_heartbeat, age_seconds) or (None, None) if missing."""
    if not HEARTBEAT_FILE.is_file():
        return None, None
    try:
        data = json.loads(HEARTBEAT_FILE.read_text(encoding="utf-8"))
        mtime = HEARTBEAT_FILE.stat().st_mtime
        age = int(time.time() - mtime)
        return data, age
    except (OSError, json.JSONDecodeError):
        return None, None


def _ipc_status(timeout: float = 5.0) -> dict | None:
    """Try to ask the daemon for its status via its Unix socket."""
    if not SOCKET_PATH.exists():
        return None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(str(SOCKET_PATH))
        sock.sendall(b'{"cmd":"status"}\n')
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        sock.close()
        return json.loads(buf.decode("utf-8").strip())
    except (OSError, json.JSONDecodeError, socket.timeout):
        return None


def _daemon_start_time(pid: int | None) -> float | None:
    """Return the daemon's process start time as a Unix timestamp, or None.
    Used to scope the decrypt-failure scan to the CURRENT daemon run only —
    pre-restart errors in old log files are not actionable.
    """
    if pid is None:
        return None
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart="],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode != 0:
            return None
        # macOS lstart format: "Thu May 21 14:30:45 2026"
        from datetime import datetime as _dt
        return _dt.strptime(out.stdout.strip(), "%a %b %d %H:%M:%S %Y").timestamp()
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _count_recent_decrypt_failures(daemon_start: float | None) -> tuple[int, bool]:
    """Scan stderr + stdout for Signal Protocol decryption failures (Bad MAC,
    PreKeyError, Failed to decrypt). These indicate that local session keys
    in baileys_auth/ have drifted out of sync with the user's phone.

    Only counts errors from log files whose mtime is AFTER the current daemon
    started — otherwise stale logs from the previous (broken) daemon poison
    the diagnosis after a successful re-pair.

    Returns (count, scoped_to_current_run).
    """
    patterns = ("Bad MAC", "Failed to decrypt", "PreKeyError", "Invalid PreKey ID")
    count = 0
    scoped = False
    for path in (STDERR_FILE, STDOUT_FILE):
        if not path.is_file():
            continue
        try:
            mtime = path.stat().st_mtime
            # Skip logs that haven't been touched since the daemon started
            if daemon_start is not None and mtime < daemon_start:
                continue
            scoped = True
            size = path.stat().st_size
            with path.open("rb") as f:
                if size > 500_000:
                    f.seek(-500_000, os.SEEK_END)
                buf = f.read().decode("utf-8", errors="replace")
            for p in patterns:
                count += buf.count(p)
        except OSError:
            continue
    return count, scoped


def _count_recent_disconnects(window_seconds: int = 3600) -> int:
    """Count ALL Connection-closed events in the last N seconds, regardless of
    the disconnect code. Pre-0.2.0 this was scoped to code:408 (server timeout)
    only, missing 500 (server error), 401 (auth), and other codes that also
    indicate session instability and lead to "waiting for this message" drift
    on the user's primary device.
    """
    if not LOG_FILE.is_file():
        return 0
    cutoff_ms = (time.time() - window_seconds) * 1000
    count = 0
    try:
        with LOG_FILE.open("rb") as f:
            try:
                f.seek(-500_000, os.SEEK_END)
            except OSError:
                f.seek(0)
            for line in f.read().decode("utf-8", errors="replace").splitlines():
                if '"Connection closed' not in line:
                    continue
                try:
                    ts = json.loads(line).get("time")
                    if ts and ts >= cutoff_ms:
                        count += 1
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return count


def _daemon_code_identity() -> tuple[str | None, str | None]:
    """Extract the (browser_name, platform) tuple from daemon.mjs's makeWASocket call.

    The browser array tells the WhatsApp server how the companion device identifies
    itself: ['Vault Daemon', 'Chrome', '120.0.0'] vs the legacy ['WhatsApp Vault Daemon',
    'Desktop', '1.0.0']. When the platform is 'Desktop', WhatsApp groups this companion
    with the user's official WhatsApp Desktop app (Mac/Windows). They share a slot and
    one will evict the other under load — observed as 4+ disconnects/hour on Danny's
    setup before the 2026-05-29 fix.

    Returns (browser_name, platform) or (None, None) if the file can't be parsed.
    """
    daemon_mjs = SCRIPT_DIR / "daemon.mjs"
    if not daemon_mjs.is_file():
        return None, None
    try:
        # Find: browser: ['Name', 'Platform', 'Version'],
        # Tolerant of single/double quotes and whitespace.
        import re
        content = daemon_mjs.read_text(encoding="utf-8")
        m = re.search(
            r"browser:\s*\[\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*,\s*['\"][^'\"]+['\"]\s*\]",
            content,
        )
        if not m:
            return None, None
        return m.group(1), m.group(2)
    except OSError:
        return None, None


# ---------------------------------------------------------------------------
# Fix actions
# ---------------------------------------------------------------------------

def _fix_kickstart_daemon() -> tuple[bool, str]:
    """Force launchd to restart the daemon. Idempotent."""
    try:
        uid = os.getuid()
        subprocess.run(
            ["launchctl", "kickstart", "-k", f"gui/{uid}/{DAEMON_LABEL}"],
            capture_output=True, text=True, timeout=10, check=True,
        )
        # Give it a moment to come up
        for _ in range(30):
            time.sleep(1)
            if _daemon_pid() is not None:
                return True, f"Daemon restarted via launchctl (PID {_daemon_pid()})."
        return False, "launchctl kickstart returned but daemon did not appear in 30s."
    except subprocess.CalledProcessError as e:
        return False, f"launchctl kickstart failed: {e.stderr or e.stdout or e}"
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"launchctl kickstart error: {e}"


def _fix_remove_stale_lock() -> tuple[bool, str]:
    try:
        if LOCK_FILE.is_file():
            try:
                pid = int(LOCK_FILE.read_text().strip())
                # Probe the PID
                os.kill(pid, 0)
                return False, f"Lock claims PID {pid} is alive; not removing."
            except (ValueError, ProcessLookupError, PermissionError):
                LOCK_FILE.unlink()
                return True, f"Removed stale lock file (referenced dead PID)."
        return True, "No stale lock to remove."
    except OSError as e:
        return False, f"Cannot inspect lock file: {e}"


def _fix_chmod_auth_dir() -> tuple[bool, str]:
    if not AUTH_DIR.is_dir():
        return False, f"{AUTH_DIR} does not exist; cannot fix permissions."
    os.umask(0o077)
    fixed = 0
    _targets = []
    for root in _sensitive_paths():
        _targets.append(root)
        if root.is_dir():
            _targets.extend(root.rglob("*"))
    for p in _targets:
        try:
            mode = p.stat().st_mode & 0o777
            target = 0o700 if p.is_dir() else 0o600
            if mode != target:
                os.chmod(p, target)
                fixed += 1
        except OSError:
            pass
    return True, f"Reviewed {len(_sensitive_paths())} secret path(s); fixed {fixed} entr{'y' if fixed == 1 else 'ies'}."


def _fix_create_logs_dir() -> tuple[bool, str]:
    try:
        (SCRIPT_DIR / "logs").mkdir(parents=True, exist_ok=True)
        return True, "logs/ directory ensured."
    except OSError as e:
        return False, f"Cannot create logs/: {e}"


# ---------------------------------------------------------------------------
# Check runner
# ---------------------------------------------------------------------------

# Empirically derived from 219 days of this vault's own inbox (158,818 real
# inbound events): median gap between inbound days = 1d, p99 gap = 0.40h, and
# the longest legitimate gap ever observed = 16.9h. Every gap above 18h in that
# window was a real outage. 18h therefore gives zero false positives on the
# historical record, while a 12h threshold would have produced ~12 false
# alarms per year. Re-derive with `wa-fix.py inbound` before changing these.
INBOUND_WARN_HOURS = 9
INBOUND_FAIL_HOURS = 18
INBOUND_JIDS_WARN = 8    # median day sees 44 distinct conversations
INBOUND_JIDS_FAIL = 3    # only 2 of 191 days ever went below 5
DECRYPT_WARN_1H = 5
DECRYPT_FAIL_1H = 30


def _fmt_age(seconds: float) -> str:
    """Human duration: '25d 4h', '19h 20m', '8m'."""
    s = int(max(0, seconds))
    d, r = divmod(s, 86400)
    h, r = divmod(r, 3600)
    m = r // 60
    if d: return f"{d}d {h}h"
    if h: return f"{h}h {m}m"
    return f"{m}m"


def _check_inbound_freshness(hb: dict | None) -> CheckResult:
    """THE check. Everything else in this file measures liveness or config —
    whether the daemon breathes, not whether it does its job.

    For 28 days in Aug-2026 every other check passed while reception was
    completely dead. `doctor` was actually run on day 25 and reported
    12 passed / 0 failed. That is worse than no monitoring: it is a green
    light that closes the investigation.

    This check is first in the list and is the only one whose failure can veto
    a healthy verdict. It reads the inbound-only signal the daemon publishes;
    it never infers reception from sends, because sends worked every day of
    the outage.
    """
    PASS, WARN, FAIL, UNKNOWN = "PASS", "WARN", "FAIL", "UNKNOWN"
    manual = [
        "Reception is dead but the process is fine — this is almost always",
        "Signal session drift, which only a re-pair can clear:",
        "",
        f"    python3 '{Path(__file__).resolve()}' repair",
        "",
        "Needs your phone in hand (QR scan) and takes about 6 minutes.",
    ]
    if hb is None:
        return CheckResult(UNKNOWN, "inbound-freshness",
                           "No heartbeat file — cannot tell whether messages are arriving. "
                           "Absence of evidence is not health.",
                           fix_manual=manual)
    if "lastInboundRealAt" not in hb:
        return CheckResult(UNKNOWN, "inbound-freshness",
                           "Daemon predates inbound/outbound signal separation (no "
                           "lastInboundRealAt in heartbeat). Reception cannot be verified — "
                           "update the daemon.",
                           fix_manual=manual)

    last = hb.get("lastInboundRealAt")
    jids = hb.get("inboundRealJids24h", 0)
    n24 = hb.get("inboundReal24h", 0)
    if not last:
        return CheckResult(UNKNOWN, "inbound-freshness",
                           "No real inbound message recorded yet since this signal was "
                           "introduced. Re-check in a few hours.",
                           fix_manual=manual)
    try:
        ts = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - ts).total_seconds()
    except (ValueError, TypeError):
        return CheckResult(UNKNOWN, "inbound-freshness",
                           f"Unparseable lastInboundRealAt: {last!r}", fix_manual=manual)

    hrs = age / 3600.0
    ctx = (f"last real inbound {_fmt_age(age)} ago; {n24} msgs from {jids} contacts in 24h "
           f"(reference: 16.9h, the longest quiet gap on the vault these thresholds were tuned on)")
    if not hb.get("signalWindowComplete"):
        ctx += " [24h window still filling]"
    if hrs >= INBOUND_FAIL_HOURS:
        return CheckResult(FAIL, "inbound-freshness",
                           f"DEAF — {ctx}. Nothing has reached the vault in "
                           f"{_fmt_age(age)}; outbound may still work, which is exactly "
                           f"how the Aug-2026 outage hid for 28 days.",
                           fix_manual=manual)
    # Contact-diversity rules only apply once a full 24h window has actually
    # been observed. A freshly deployed daemon has empty counters, which is
    # indistinguishable from a dead one — and a false alarm on night one is
    # how a monitoring channel gets muted forever.
    window_ready = bool(hb.get("signalWindowComplete"))
    if window_ready and jids < INBOUND_JIDS_FAIL and hrs >= INBOUND_WARN_HOURS:
        return CheckResult(FAIL, "inbound-freshness",
                           f"DEAF — only {jids} distinct contacts in 24h ({ctx}).",
                           fix_manual=manual)
    if hrs >= INBOUND_WARN_HOURS or (window_ready and jids < INBOUND_JIDS_WARN):
        return CheckResult(WARN, "inbound-freshness",
                           f"Quiet — {ctx}. Not yet conclusive; alert fires at "
                           f"{INBOUND_FAIL_HOURS}h.")
    return CheckResult(PASS, "inbound-freshness", f"receiving — {ctx}")


def run_checks() -> list[CheckResult]:
    PASS, WARN, FAIL, UNKNOWN = "PASS", "WARN", "FAIL", "UNKNOWN"
    results: list[CheckResult] = []

    # 0. THE check: is anyone actually reaching us? First, and the only one
    #    allowed to veto a green verdict. See _check_inbound_freshness.
    _hb_for_inbound, _ = _read_heartbeat()
    results.append(_check_inbound_freshness(_hb_for_inbound))

    # 1. launchd plist
    if not LAUNCHD_PLIST.is_file():
        results.append(CheckResult(
            FAIL, "launchd-plist",
            f"{LAUNCHD_PLIST} missing. The daemon won't autostart at login.",
            fix_manual=[
                "Re-run the installer from the repo to regenerate the plist files:",
                "  Re-run install.sh from the repo checkout (it is not copied into this",
                "  directory), or recreate the plist by hand from templates/.",
                f"Or copy a generated plist manually to {LAUNCHD_PLIST} and load it:",
                f"  launchctl load {LAUNCHD_PLIST}",
            ],
        ))
    else:
        results.append(CheckResult(PASS, "launchd-plist", f"{LAUNCHD_PLIST.name} present"))

    # 2. Auth dir
    if not AUTH_DIR.is_dir():
        results.append(CheckResult(
            FAIL, "auth-dir",
            f"{AUTH_DIR} missing. WhatsApp is not paired.",
            fix_manual=[
                f"Pair with your phone (QR scan) by running sync.mjs once:",
                f"  cd '{SCRIPT_DIR}' && node sync.mjs",
                "When the QR appears, scan it from WhatsApp on your phone:",
                "  Settings → Linked Devices → Link a Device.",
                "After pairing, re-run wa-fix.",
            ],
        ))
    else:
        results.append(CheckResult(PASS, "auth-dir", f"{AUTH_DIR.name}/ present"))

    # 3. Daemon process
    pid = _daemon_pid()
    if pid is None:
        results.append(CheckResult(
            FAIL, "daemon-process",
            "Daemon process is NOT running. Outgoing messages will fail.",
            fix_auto=_fix_kickstart_daemon,
        ))
    else:
        results.append(CheckResult(PASS, "daemon-process", f"running as PID {pid}"))

    # 4. Stale lock
    if LOCK_FILE.is_file():
        try:
            lock_pid = int(LOCK_FILE.read_text().strip())
            try:
                os.kill(lock_pid, 0)
                # Lock PID is alive
                if pid is None or lock_pid != pid:
                    results.append(CheckResult(
                        WARN, "daemon-lock",
                        f"Lock claims PID {lock_pid} but pgrep finds PID {pid}.",
                    ))
                else:
                    results.append(CheckResult(PASS, "daemon-lock", f"matches PID {pid}"))
            except (ProcessLookupError, PermissionError):
                results.append(CheckResult(
                    FAIL, "daemon-lock",
                    f"Stale lock pointing to dead PID {lock_pid}; blocks restart.",
                    fix_auto=_fix_remove_stale_lock,
                ))
        except ValueError:
            results.append(CheckResult(
                FAIL, "daemon-lock", "Lock file corrupt (unparseable).",
                fix_auto=_fix_remove_stale_lock,
            ))
    else:
        results.append(CheckResult(PASS, "daemon-lock", "no lock file (daemon may be starting)"))

    # 5. Heartbeat. Three-tier severity:
    #   <=60s   PASS  — main loop healthy
    #   60-300s WARN  — main loop sluggish (typically heavy history-sync processing);
    #                   only escalate if IPC is also unresponsive (next check).
    #   >300s   FAIL  — main loop genuinely stuck; auto-kickstart.
    # Observed twice on 2026-05-31 post-sync: heartbeat hit 190s/232s stale while
    # the daemon kept answering IPC and dispatching messages — that's a sluggish
    # event loop, not a dead daemon. The old FAIL-at-90s threshold triggered
    # unnecessary restarts on top of an already-healthy process.
    hb, age = _read_heartbeat()
    if hb is None:
        results.append(CheckResult(
            WARN, "heartbeat",
            "No heartbeat file yet. If daemon just started, this clears in ~10s.",
        ))
    elif age is not None and age > HEARTBEAT_SATURATED_SECONDS:
        results.append(CheckResult(
            FAIL, "heartbeat",
            f"Heartbeat is {age}s stale (> {HEARTBEAT_SATURATED_SECONDS}s). Daemon is hung.",
            fix_auto=_fix_kickstart_daemon,
        ))
    elif age is not None and age > HEARTBEAT_STALE_SECONDS:
        results.append(CheckResult(
            WARN, "heartbeat",
            f"Heartbeat {age}s stale. Main loop sluggish (likely processing a large "
            f"history batch). IPC check next will confirm whether the daemon is still "
            f"alive end-to-end.",
        ))
    else:
        results.append(CheckResult(PASS, "heartbeat", f"fresh ({age}s old)"))

    # 6. Connection state (from heartbeat). Trust this only when heartbeat
    # is fresh — a stale heartbeat may report connected=true from a previous
    # daemon run that no longer exists.
    if hb is not None and age is not None and age <= HEARTBEAT_STALE_SECONDS:
        if hb.get("connected"):
            results.append(CheckResult(PASS, "wa-connection", "daemon reports connected=true"))
        else:
            results.append(CheckResult(
                WARN, "wa-connection",
                "daemon reports connected=false (may be mid-reconnect)",
            ))
    elif hb is not None:
        results.append(CheckResult(
            WARN, "wa-connection",
            "skipped (heartbeat is stale; connection state cannot be trusted)",
        ))

    # 7. IPC socket
    if SOCKET_PATH.exists():
        status = _ipc_status()
        if status and status.get("ok"):
            results.append(CheckResult(PASS, "ipc", "socket responds to status query"))
        elif status is None:
            results.append(CheckResult(
                FAIL, "ipc",
                "Socket exists but does not respond. Daemon may be hung.",
                fix_auto=_fix_kickstart_daemon,
            ))
    else:
        if pid is not None:
            results.append(CheckResult(
                FAIL, "ipc",
                f"Daemon running but {SOCKET_PATH} missing; IPC unavailable.",
                fix_auto=_fix_kickstart_daemon,
            ))
        else:
            results.append(CheckResult(WARN, "ipc", "socket missing (expected when daemon is down)"))

    # 8. Auth dir permissions
    if AUTH_DIR.is_dir():
        bad_modes = 0
        _scan = []
        for root in _sensitive_paths():
            _scan.append(root)
            if root.is_dir():
                _scan.extend(root.rglob("*"))
        for p in _scan:
            try:
                mode = p.stat().st_mode & 0o777
                target = 0o700 if p.is_dir() else 0o600
                if mode != target:
                    bad_modes += 1
            except OSError:
                continue
        if bad_modes == 0:
            results.append(CheckResult(PASS, "secret-perms", "all 0o700/0o600"))
        else:
            # FAIL, not WARN. Loose modes on Signal identity material is not a
            # cosmetic nit: anything running as another user on this machine can
            # read the keys that authenticate this device as the user's WhatsApp.
            # As a WARN it could never trip any alert, because doctor exited 0
            # on warnings.
            results.append(CheckResult(
                FAIL, "secret-perms",
                f"{bad_modes} file(s) under the connector's secret paths are looser "
                f"than 0o700/0o600. Signal identity keys readable by other local users.",
                fix_auto=_fix_chmod_auth_dir,
            ))

    # 9. Logs dir
    if not (SCRIPT_DIR / "logs").is_dir():
        results.append(CheckResult(
            FAIL, "logs-dir", "logs/ missing; daemon will fail to start.",
            fix_auto=_fix_create_logs_dir,
        ))
    else:
        results.append(CheckResult(PASS, "logs-dir", "logs/ present"))

    # 10. Session-key health (CRITICAL: if these fail, daemon receives data
    # but can't decrypt anything — vault gets no new messages even though
    # the daemon reports "connected: true". Only fix is re-pair.)
    # Scope to the CURRENT daemon's logs only, so a clean re-pair clears
    # the check immediately even if old log files still exist on disk.
    daemon_start = _daemon_start_time(pid)
    # 10. Signal session health, read from the daemon's in-process counter.
    #
    # This used to grep the stderr log. That was wrong twice over: the log path
    # did not exist (see run-daemon.sh), and grep counts stack-trace lines, so
    # a handful of undecryptable messages read as dozens of "failures". Measured
    # 2026-09-05: log grep said 44, the actual number of undecryptable messages
    # was 8. The daemon now counts CIPHERTEXT stubs directly and publishes a
    # rate, which is the thing worth alarming on — a few failures after a
    # re-pair are normal as stale sessions get renegotiated; a sustained rate
    # is drift.
    hb_dec, _ = _read_heartbeat()
    if hb_dec is None or "decryptFail1h" not in (hb_dec or {}):
        results.append(CheckResult(
            UNKNOWN, "session-keys",
            "daemon does not publish decryptFail1h — cannot assess Signal health. "
            "Update the daemon."))
    else:
        d1h = hb_dec.get("decryptFail1h", 0)
        d24 = hb_dec.get("decryptFail24h", 0)
        if d1h >= DECRYPT_FAIL_1H:
            results.append(CheckResult(
                FAIL, "session-keys",
                f"{d1h} undecryptable messages in the last hour ({d24} in 24h). "
                f"Local Signal state has drifted from your phone; incoming messages "
                f"are being dropped.",
                fix_manual=[
                    "Re-pair to reset the Signal sessions:",
                    f"    python3 '{Path(__file__).resolve()}' repair",
                    "Needs your phone in hand (QR scan), about 6 minutes.",
                ]))
        elif d1h >= DECRYPT_WARN_1H:
            results.append(CheckResult(
                WARN, "session-keys",
                f"{d1h} undecryptable messages in the last hour ({d24} in 24h). "
                f"Normal for a while after a re-pair as stale sessions renegotiate; "
                f"alarming only if it stays above {DECRYPT_FAIL_1H}/h."))
        else:
            results.append(CheckResult(
                PASS, "session-keys",
                f"{d1h} decrypt failures in the last hour ({d24} in 24h)"))

    # 10b. Daemon state machine. The recovery skill instructs the agent to look
    # for `state: DRIFT_DETECTED`, but that string appeared nowhere in doctor's
    # output — the daemon computed the state and the tool threw it away. A
    # contract the tool never fulfils is worse than no contract.
    _st = _ipc_status() or {}
    _st_hb, _ = _read_heartbeat()
    dstate = _st.get("state") or (_st_hb or {}).get("state")
    recon = _st.get("reconnectsInWindow", (_st_hb or {}).get("reconnectsInWindow", 0))
    sends = _st.get("successfulSendsInWindow", (_st_hb or {}).get("successfulSendsInWindow", 0))
    if dstate is None:
        results.append(CheckResult(UNKNOWN, "daemon-state", "daemon did not report a state"))
    elif dstate == "DRIFT_DETECTED":
        results.append(CheckResult(
            FAIL, "daemon-state",
            f"state: DRIFT_DETECTED (reconnects={recon}, successful sends={sends} in the "
            f"5-minute window). The daemon is refusing sends because they would land in "
            f"'waiting for this message' on the recipient's phone.",
            fix_manual=[
                "Re-pair to reset the Signal sessions:",
                f"    python3 '{Path(__file__).resolve()}' repair",
            ]))
    elif dstate == "UNSTABLE":
        # Reconnect churn with no evidence that messages are failing. Worth
        # seeing, not worth alarming on, and explicitly NOT a reason to block
        # sends — that was the old behaviour and it punished flaky networks.
        results.append(CheckResult(
            WARN, "daemon-state",
            f"state: UNSTABLE — {recon} reconnects in the last 5 minutes, but nothing "
            f"indicates messages are failing. Usually a flaky network. Sends still work."))
    elif dstate != "CONNECTED":
        results.append(CheckResult(WARN, "daemon-state",
                                   f"state: {dstate} (reconnects={recon}, sends={sends})"))
    else:
        results.append(CheckResult(PASS, "daemon-state",
                                   f"state: CONNECTED (reconnects={recon} in window)"))

    # 10c. Cryptographic key inventory. Cheap, and the best leading indicator
    # already sitting on disk: a pre-key backlog means newly started sessions
    # cannot be established, which is drift arriving before anyone notices the
    # silence. Calibrated against this install's own re-pair backups, which held
    # 13,357 session files immediately before the Sep-2026 re-pair versus 21
    # right after.
    try:
        creds = json.loads((AUTH_DIR / "creds.json").read_text(encoding="utf-8"))
        backlog = int(creds.get("nextPreKeyId", 0)) - int(creds.get("firstUnuploadedPreKeyId", 0))
        sessions = len(list(AUTH_DIR.glob("session-*.json")))
        detail = f"pre-key upload backlog {backlog}, {sessions} session files"
        if backlog > 200 or sessions > 5000:
            results.append(CheckResult(FAIL, "key-inventory",
                                       f"{detail} — re-pair overdue.",
                                       fix_manual=[f"    python3 '{Path(__file__).resolve()}' repair"]))
        elif backlog > 60 or sessions > 2000:
            results.append(CheckResult(WARN, "key-inventory", f"{detail} — watch this."))
        else:
            results.append(CheckResult(PASS, "key-inventory", detail))
    except (OSError, ValueError, KeyError):
        results.append(CheckResult(UNKNOWN, "key-inventory", "could not read creds.json"))

    # 10d. Is there anywhere for an alert to GO?
    #
    # This project exists because a 28-day outage went unnoticed. Detection with
    # no delivery reproduces exactly that failure while looking solved, so a
    # missing alert channel is a finding, not a footnote. launchd jobs do not
    # inherit the shell environment, so the value has to be in the watchdog
    # plist — exporting it from .zshrc silently does nothing.
    wd_plist = LAUNCHD_PLIST.parent / f"{DAEMON_LABEL.replace('.daemon', '.watchdog')}.plist"
    chan = None
    if wd_plist.is_file():
        try:
            import plistlib
            env = plistlib.loads(wd_plist.read_bytes()).get("EnvironmentVariables", {})
            chan = (env.get("WA_ALERT_COMMAND") or "").strip() and "custom command" \
                or (env.get("ALERT_EMAIL") or "").strip() and f"email to {env.get('ALERT_EMAIL')}" \
                or None
        except Exception:
            chan = None
    if chan:
        results.append(CheckResult(PASS, "alert-channel", f"{chan} (test it: bash wa-watchdog.sh --test-alert)"))
    elif not wd_plist.is_file():
        results.append(CheckResult(UNKNOWN, "alert-channel",
                                   "watchdog plist not found; cannot tell where alerts would go"))
    else:
        results.append(CheckResult(
            WARN, "alert-channel",
            "no durable alert channel configured — an outage would only raise a local "
            "desktop notification, which is lost if you are away from the machine.",
            fix_manual=[
                "Set a destination in the watchdog plist (launchd ignores your shell env):",
                f"    /usr/libexec/PlistBuddy -c 'Set :EnvironmentVariables:ALERT_EMAIL you@example.com' '{wd_plist}'",
                f"    launchctl unload '{wd_plist}' && launchctl load '{wd_plist}'",
                "Then prove it works before you need it:",
                "    bash wa-watchdog.sh --test-alert",
            ]))

    # 11. Disconnect stability. Tuned 2026-05-29 after observing 4 disconnects/hr
    # was enough to cause user-visible drift ("waiting for this message" on the
    # paired iPhone). The previous threshold of 30/hr was permissive — by the time
    # it tripped, the daemon was effectively dead. Each disconnect is an opportunity
    # for the Signal Protocol Double Ratchet to drift between this companion and
    # the user's primary device, so we care about the rate, not the absolute count.
    disc = _count_recent_disconnects(3600)
    if disc > 4:
        results.append(CheckResult(
            FAIL, "stability",
            f"{disc} disconnects in last hour (critical). New messages may stay "
            f"in 'waiting for this message' on the paired phone.",
            fix_manual=[
                "Re-pair to reset all Signal sessions (resolves drift immediately):",
                f"  python3 '{Path(__file__).resolve()}' repair",
                "Until repair lands, do the manual steps documented under session-keys.",
                "",
                "If the disconnect rate stays high AFTER a clean re-pair, suspect:",
                "  - Network: ISP packet loss, VPN interference, NAT timeout. Test on a different network.",
                "  - Identity slot conflict: open daemon.mjs and verify the browser array uses 'Chrome',",
                "    not 'Desktop' (Desktop competes with the official WhatsApp Mac app).",
            ],
        ))
    elif disc > 2:
        results.append(CheckResult(
            WARN, "stability",
            f"{disc} disconnects in last hour. Above the healthy threshold of 2/hr — "
            f"watch for drift symptoms (messages stuck in 'waiting').",
        ))
    else:
        results.append(CheckResult(PASS, "stability", f"{disc} disconnect(s) in last hour"))

    # 12. Code-identity drift. Verifies the daemon source declares itself as a
    # Chrome web session ('Chrome' platform), not the legacy 'Desktop' (which
    # collides with the official WhatsApp Desktop app on macOS/Windows). When
    # they collide, WhatsApp evicts the older companion device, producing the
    # rolling disconnects that drive session drift. Added 2026-05-29.
    browser_name, platform = _daemon_code_identity()
    if browser_name is None:
        results.append(CheckResult(
            WARN, "code-identity",
            "Could not parse browser array from daemon.mjs; identity check skipped.",
        ))
    elif platform == "Chrome":
        results.append(CheckResult(
            PASS, "code-identity",
            f"daemon advertises as '{browser_name}' / Chrome (separate slot from WhatsApp Desktop)",
        ))
    elif platform == "Desktop":
        results.append(CheckResult(
            FAIL, "code-identity",
            f"daemon.mjs declares platform '{platform}' — collides with the official "
            f"WhatsApp Desktop app's companion slot, causing recurring evictions and drift.",
            fix_manual=[
                "Edit daemon.mjs and change the makeWASocket browser line to:",
                "    browser: ['Vault Daemon', 'Chrome', '120.0.0'],",
                "Then re-pair (the platform is set during pairing and is not changed",
                "by an in-flight identity swap):",
                f"  python3 '{Path(__file__).resolve()}' repair",
            ],
        ))
    else:
        results.append(CheckResult(
            WARN, "code-identity",
            f"daemon advertises as '{browser_name}' / {platform}. Non-Chrome platforms "
            f"haven't been validated as conflict-free with the WhatsApp Desktop app.",
        ))

    # 11. messageStore freshness (informational)
    if MSGSTORE_FILE.is_file():
        try:
            size = MSGSTORE_FILE.stat().st_size
            results.append(CheckResult(PASS, "msgstore", f"persisted ({size:,} bytes; getMessage retries work across restarts)"))
        except OSError:
            results.append(CheckResult(WARN, "msgstore", "exists but unreadable"))
    else:
        results.append(CheckResult(WARN, "msgstore",
            f"{MSGSTORE_FILE.name} not yet written (clears after first message exchange)."))

    return results


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

# Exit codes. Previously `repair` returned 1 both when the user declined and
# when the re-pair worked but left failures — two outcomes an automation must
# tell apart.
EXIT_OK, EXIT_DEGRADED, EXIT_NEEDS_HUMAN, EXIT_ABORTED, EXIT_ERROR = 0, 1, 2, 3, 4

# Checks whose failure cannot be fixed without the user's phone in hand.
_NEEDS_HUMAN = {"inbound-freshness", "session-keys", "daemon-state", "auth-dir", "key-inventory"}


def _verdict(results: list[CheckResult]) -> tuple[str, str, int]:
    """Return (verdict, escalate, exit_code).

    The tool computes this so callers stop reconstructing the criterion by
    regex over column-aligned prose. The recovery skill reads `escalate`.
    """
    bad = [r for r in results if r.status in ("FAIL", "UNKNOWN")]
    if not bad:
        return ("HEALTHY", "none", EXIT_OK) if not any(
            r.status == "WARN" for r in results) else ("DEGRADED", "none", EXIT_OK)
    if any(r.name in _NEEDS_HUMAN and r.status == "FAIL" for r in results):
        return "BROKEN", "repair", EXIT_NEEDS_HUMAN
    return "BROKEN", "fix", EXIT_DEGRADED


def _as_json(results: list[CheckResult]) -> str:
    verdict, escalate, _ = _verdict(results)
    counts = {"pass": 0, "warn": 0, "fail": 0, "unknown": 0}
    for r in results:
        counts[{"PASS": "pass", "WARN": "warn", "FAIL": "fail", "UNKNOWN": "unknown"}[r.status]] += 1
    return json.dumps({
        "version": __version__,
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
        "verdict": verdict,
        "escalate": escalate,
        "summary": counts,
        "checks": [{"name": r.name, "status": r.status, "detail": r.detail,
                    "remediation": (r.fix_manual or [None])[0]} for r in results],
    }, ensure_ascii=False, indent=2)


def _print_results(results: list[CheckResult]) -> tuple[int, int, int]:
    passed = warned = failed = unknown = 0
    for r in results:
        print(f"  [{r.status:<7}] {r.name:<18} {r.detail}")
        if r.status == "PASS": passed += 1
        elif r.status == "WARN": warned += 1
        elif r.status == "UNKNOWN": unknown += 1
        else: failed += 1
    tail = f", {unknown} unknown" if unknown else ""
    print(f"\nSummary: {passed} passed, {warned} warning, {failed} failed{tail}.")
    if unknown:
        print("UNKNOWN means a check could not gather its evidence. That is not health.")
    # UNKNOWN is folded into `failed` for the caller so that no code path can
    # report success while a check was blind.
    return passed, warned, failed + unknown


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_doctor(args) -> int:
    results = run_checks()
    verdict, escalate, code = _verdict(results)
    if getattr(args, "json", False):
        print(_as_json(results))
    else:
        print(f"whatsapp doctor (v{__version__})\n")
        passed, warned, failed = _print_results(results)
        if escalate == "repair":
            print(f"\nNeeds your phone: python3 {Path(__file__).name} repair")
        elif escalate == "fix":
            print(f"\nTo auto-repair, run: python3 {Path(__file__).name} fix")
    # Persist WHICH checks were not clean, not just how many. A log line saying
    # "warned: 1" made the 2026-09-02 run impossible to interpret afterwards.
    _log_event("doctor", "success" if code == EXIT_OK else "failure",
               verdict=verdict, escalate=escalate,
               not_ok=[r.name for r in results if r.status != "PASS"])
    return code


def cmd_fix(args) -> int:
    quiet = bool(getattr(args, "quiet", False))

    def out(msg: str = ""):
        if not quiet:
            print(msg)

    out(f"whatsapp fix (v{__version__})\n")
    out("Step 1/3: Running diagnostics...\n")
    results = run_checks()
    if not quiet:
        _print_results(results)

    issues = [r for r in results if r.status in ("WARN", "FAIL")]
    if not issues:
        out("\nNothing to fix. WhatsApp connector is healthy.")
        _log_event("fix", "success", issues_found=0, quiet=quiet)
        return 0

    out(f"\nStep 2/3: Addressing {len(issues)} issue(s)...\n")
    auto_fixed_names: list[str] = []
    manual_names: list[str] = []
    for i, issue in enumerate(issues, 1):
        out(f"[{i}/{len(issues)}] {issue.name}")
        out(f"    Problem: {issue.detail}")
        if issue.fix_auto is not None:
            try:
                success, msg = issue.fix_auto()
            except Exception as e:
                success, msg = False, f"Fix raised {type(e).__name__}: {e}"
            mark = "+" if success else "x"
            out(f"    Auto-fix: [{mark}] {msg}")
            if success:
                auto_fixed_names.append(issue.name)
            else:
                manual_names.append(issue.name)
                if issue.fix_manual:
                    out("    Manual steps:")
                    for step in issue.fix_manual:
                        out(f"      {step}")
        elif issue.fix_manual:
            out("    Cannot auto-fix. Manual steps:")
            for step in issue.fix_manual:
                out(f"      {step}")
            manual_names.append(issue.name)
        else:
            out("    (No remediation defined; informational.)")
        out("")

    out("Step 3/3: Re-verifying...\n")
    results2 = run_checks()
    if not quiet:
        _print_results(results2)
    failed2 = sum(1 for r in results2 if r.status == "FAIL")

    out("")
    if failed2 == 0:
        out(f"WhatsApp connector healthy. Auto-fixed {len(auto_fixed_names)} issue(s).")
        if quiet and auto_fixed_names:
            print(
                f"whatsapp fix: auto-repaired {len(auto_fixed_names)} ({', '.join(auto_fixed_names)})",
                file=sys.stderr,
            )
        _log_event("fix", "success",
                   auto_fixed=len(auto_fixed_names), manual=len(manual_names), quiet=quiet)
        return 0
    else:
        out(f"{failed2} issue(s) still need attention. Follow the manual steps printed above.")
        if quiet:
            print(
                f"whatsapp fix: {failed2} issue(s) need attention ({', '.join(manual_names)}). "
                f"Run: python3 {Path(__file__).resolve()} fix",
                file=sys.stderr,
            )
        _log_event("fix", "partial",
                   auto_fixed=len(auto_fixed_names), manual=len(manual_names), remaining=failed2,
                   quiet=quiet)
        return 1


def cmd_version(args) -> int:
    print(f"wa-fix v{__version__}")
    return 0


# ---------------------------------------------------------------------------
# repair: full end-to-end re-pair flow
# ---------------------------------------------------------------------------

# Pairing artifacts contain a live credential: anyone who scans the QR while it
# is valid links their own device to the account. /tmp is mode 1777, so these
# were world-readable for the ~2 minutes they mattered, and the rendered PNG was
# never deleted. They live in a 0700 run directory now.
PAIR_DIR = SCRIPT_DIR / ".pair"
PAIR_LOG = PAIR_DIR / "pair.log"
QR_RAW_FILE = PAIR_DIR / "qr-raw.txt"
SYNC_SCRIPT = SCRIPT_DIR / "sync.mjs"


def _wait_for_file_nonempty(path: Path, timeout_s: int) -> bool:
    """Spin until the file exists and has size > 0, or timeout."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if path.is_file() and path.stat().st_size > 0:
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def _wait_for_log_marker(path: Path, marker: str, timeout_s: int) -> bool:
    """Spin until `marker` appears in the file, or timeout."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if path.is_file():
                with path.open("rb") as f:
                    if marker.encode("utf-8") in f.read():
                        return True
        except OSError:
            pass
        time.sleep(1)
    return False


def _ensure_pair_dir() -> None:
    os.umask(0o077)
    PAIR_DIR.mkdir(mode=0o700, exist_ok=True)
    try:
        os.chmod(PAIR_DIR, 0o700)
    except OSError:
        pass


def _purge_pair_artifacts() -> None:
    """Delete the live credential once pairing is done. Nothing here is
    diagnostic after the fact, and a stale QR image is a standing invitation."""
    for f in (PAIR_DIR.glob("*.png"), [QR_RAW_FILE]):
        for p in f:
            try:
                p.unlink()
            except OSError:
                pass


def _prune_repair_backups(keep: int = 2) -> str:
    """Keep the N most recent pre-repair backups, delete the rest.

    Each re-pair snapshots baileys_auth/ and nothing ever removed the snapshot.
    By Sep-2026 that was 369 MB across 8 directories of historical Signal
    identities going back to April — every one of them a full credential for
    this account, and all of them inside Time Machine's scope.
    """
    backups = sorted(
        [d for d in SCRIPT_DIR.glob("baileys_auth_pre_repair_*") if d.is_dir()]
        + [d for d in SCRIPT_DIR.glob("baileys_auth_backup_*") if d.is_dir()]
        + [d for d in SCRIPT_DIR.glob("baileys_auth_sessions_backup_*") if d.is_dir()],
        key=lambda d: d.stat().st_mtime)
    removed = []
    for d in backups[:-keep] if len(backups) > keep else []:
        try:
            subprocess.run(["rm", "-rf", str(d)], check=True, timeout=120)
            removed.append(d.name)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            pass
    return ", ".join(removed) if removed else "none"


def _render_qr_png(raw_qr: str) -> Path | None:
    """Render the raw QR string as a PNG. Returns the path, or None if the
    qrcode library is unavailable. The terminal ASCII version is always still
    visible in the pair log as a fallback."""
    try:
        import qrcode  # type: ignore
        ts = datetime.now().strftime("%H%M%S")
        _ensure_pair_dir()
        out_path = PAIR_DIR / f"qr-{ts}.png"
        img = qrcode.make(raw_qr, box_size=12, border=4)
        img.save(out_path)
        return out_path
    except ImportError:
        return None
    except Exception:
        return None


def cmd_repair(args) -> int:
    """End-to-end re-pair: backup, stop, wipe, sync.mjs QR, daemon restart, verify.

    What this fixes that `fix` cannot:
    - Session-key drift (Bad MAC / PreKeyError loops)
    - 'waiting for this message' stuck on the paired phone
    - Wrong companion-device platform (legacy 'Desktop' vs current 'Chrome')
    - Any state where baileys_auth/ is intact but the peer no longer trusts it

    The flow:
      1. Snapshot baileys_auth/ to baileys_auth_pre_repair_<ts>/ for rollback
      2. Unload daemon launchd plist (clean stop)
      3. Wipe baileys_auth/, lock, heartbeat
      4. Launch sync.mjs in background — pulls a QR from WhatsApp
      5. Render the QR as PNG + open Preview (fallback: terminal ASCII)
      6. User scans QR with phone
      7. Wait for "Connected. Receiving history..." (sync.mjs handshake done)
      8. Allow 5s for creds.update events to persist to disk
      9. SIGTERM sync.mjs (we don't need its full history pass for the repair itself;
         user can re-run `node sync.mjs` separately if they want to backfill)
     10. launchctl load daemon plist
     11. Wait for daemon to report connected=true on IPC
     12. Run doctor; report
    """
    print(f"whatsapp repair (v{__version__})\n")
    print("This will re-pair the daemon with your phone. You'll need to scan a QR code.")
    print(f"Backup: baileys_auth_pre_repair_<timestamp>/  (rollback by restoring this dir)")
    print()

    if not args.yes:
        try:
            resp = input("Proceed? [y/N] ").strip().lower()
        except EOFError:
            resp = ""
        if resp not in ("y", "yes"):
            print("Aborted.")
            return 1

    _ensure_pair_dir()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = SCRIPT_DIR / f"baileys_auth_pre_repair_{ts}"

    # 1. Backup
    print(f"[1/7] Backing up baileys_auth/ → {backup_dir.name}/...")
    if AUTH_DIR.is_dir():
        try:
            subprocess.run(["cp", "-R", str(AUTH_DIR), str(backup_dir)],
                          check=True, capture_output=True, timeout=120)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            print(f"      FAILED: {e}")
            return 2
        # The snapshot is a complete Signal identity. Lock it down immediately —
        # two of the historical backups were world-readable — and exclude it from
        # Time Machine so the credential is not replicated to every backup disk.
        try:
            os.chmod(backup_dir, 0o700)
            for q in backup_dir.rglob("*"):
                os.chmod(q, 0o700 if q.is_dir() else 0o600)
        except OSError:
            pass
        subprocess.run(["tmutil", "addexclusion", str(backup_dir)],
                       capture_output=True, timeout=15)
        print(f"      OK ({subprocess.run(['du', '-sh', str(backup_dir)], capture_output=True, text=True).stdout.split()[0]}, mode 0700, excluded from Time Machine)")
    else:
        print("      No auth dir to back up (first-time pairing).")

    # 2. Stop daemon
    print("[2/7] Stopping daemon...")
    try:
        subprocess.run(["launchctl", "unload", str(LAUNCHD_PLIST)],
                      capture_output=True, timeout=15)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass
    # Belt-and-suspenders: kill any lingering daemon.mjs
    pid = _daemon_pid()
    if pid is not None:
        try: os.kill(pid, 15); time.sleep(2)
        except (ProcessLookupError, PermissionError): pass
    print(f"      Daemon: {('PID ' + str(_daemon_pid())) if _daemon_pid() else 'stopped'}")

    # 3. Wipe
    print("[3/7] Wiping baileys_auth/, lock, heartbeat...")
    try:
        if AUTH_DIR.is_dir():
            subprocess.run(["rm", "-rf", str(AUTH_DIR)], check=True, timeout=60)
        for p in (LOCK_FILE, HEARTBEAT_FILE, PAIR_LOG, QR_RAW_FILE):
            try: p.unlink()
            except (OSError, FileNotFoundError): pass
    except subprocess.CalledProcessError as e:
        print(f"      FAILED: {e}")
        return 2
    print("      Cleared.")

    # 4. Launch sync.mjs
    print(f"[4/7] Launching sync.mjs (QR will appear shortly)...")
    sync_proc = subprocess.Popen(
        ["node", str(SYNC_SCRIPT)],
        cwd=str(SCRIPT_DIR),
        stdout=PAIR_LOG.open("wb"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    # 5. Wait for raw QR and render
    if not _wait_for_file_nonempty(QR_RAW_FILE, timeout_s=30):
        print("      FAILED: sync.mjs did not produce a QR within 30s.")
        sync_proc.terminate()
        return 2

    raw_qr = QR_RAW_FILE.read_text(encoding="utf-8").strip()
    png = _render_qr_png(raw_qr)
    if png is not None:
        subprocess.run(["open", "-a", "Preview", str(png)], capture_output=True)
        print(f"      QR ready: {png}  (also opened in Preview)")
    else:
        print("      QR rendered in pair log (no python qrcode lib available for PNG):")
        print(f"      Run: less {PAIR_LOG}  — or `pip install qrcode[pil]` and re-run repair.")

    print()
    print(f"[5/7] WAITING FOR SCAN — On your phone:")
    print( "        WhatsApp → Settings → Linked Devices → Link a Device")
    print( "      (QR rotates every ~20s; if it expires, repair regenerates automatically)")
    print()

    # 6. Wait for pair success
    if not _wait_for_log_marker(PAIR_LOG, "Connected. Receiving history", timeout_s=300):
        print("      FAILED: pair did not complete within 5 minutes.")
        print(f"      To rollback: rm -rf baileys_auth && mv {backup_dir.name} baileys_auth")
        sync_proc.terminate()
        return 2

    print("      Paired successfully.")

    # 7. Allow creds to persist, then stop sync.mjs and start daemon
    print("[6/7] Persisting credentials...")
    time.sleep(5)
    try:
        sync_proc.terminate()
        sync_proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        sync_proc.kill()

    print("[7/7] Starting daemon + verifying...")
    try:
        subprocess.run(["launchctl", "load", str(LAUNCHD_PLIST)],
                      capture_output=True, timeout=15, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"      FAILED to start daemon: {e}")
        return 2

    # Wait for daemon connected
    deadline = time.time() + 60
    connected_via_ipc = False
    while time.time() < deadline:
        status = _ipc_status()
        if status and status.get("connected"):
            connected_via_ipc = True
            break
        time.sleep(1)

    if not connected_via_ipc:
        print("      Daemon started but did not report connected=true within 60s.")
        print("      Run `python3 wa-fix.py doctor` in a minute.")
        return 1

    # Run doctor for final report
    print()
    print("─" * 60)
    print()
    results = run_checks()
    passed, warned, failed = _print_results(results)

    _log_event("repair", "success" if failed == 0 else "partial",
               passed=passed, warned=warned, failed=failed, backup=str(backup_dir))

    _purge_pair_artifacts()
    pruned = _prune_repair_backups(keep=2)
    _log_event("repair-prune", "success", removed=pruned)
    if pruned != "none":
        print(f"\nPruned old identity backups: {pruned}")
    if failed == 0:
        print()
        print(f"Re-pair complete. Backup at: {backup_dir}")
        print("(Safe to delete after 24h of stable operation.)")
        return 0
    else:
        print()
        print(f"Re-pair completed but {failed} check(s) still failing. See above.")
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="WhatsApp connector: self-healing entry point. Run this when anything is wrong.",
    )
    sub = parser.add_subparsers(dest="command")
    p_doc = sub.add_parser("doctor", help="Read-only diagnostic")
    p_doc.add_argument("--json", action="store_true", help="Machine-readable output with verdict + escalate")
    p_doc.set_defaults(func=cmd_doctor)
    p_fix = sub.add_parser("fix", help="Diagnose + auto-repair (default)")
    p_fix.add_argument("--quiet", action="store_true",
                       help="Suppress normal output; one-line stderr summary only.")
    p_fix.set_defaults(func=cmd_fix)
    p_rep = sub.add_parser("repair", help="Full re-pair flow (QR scan + Signal session reset)")
    p_rep.add_argument("--yes", "-y", action="store_true",
                       help="Skip the confirmation prompt.")
    p_rep.set_defaults(func=cmd_repair)
    p_ver = sub.add_parser("version", help="Print version")
    p_ver.set_defaults(func=cmd_version)

    args = parser.parse_args()
    if args.command is None:
        args = parser.parse_args(["fix"])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
