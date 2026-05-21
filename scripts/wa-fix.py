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

__version__ = "0.1.0"

SCRIPT_DIR = Path(__file__).resolve().parent
# launchd labels. The installer writes these into the plist files; defaults
# match what install.sh uses out of the box. Override with env vars if you
# customized labels (e.g. multi-user machine, multiple installs).
DAEMON_LABEL = os.environ.get("WHATSAPP_DAEMON_LABEL", "com.whatsapp-connector.daemon")
WATCHDOG_LABEL = os.environ.get("WHATSAPP_WATCHDOG_LABEL", "com.whatsapp-connector.watchdog")
HEARTBEAT_FILE = SCRIPT_DIR / ".daemon_heartbeat"
LOCK_FILE = SCRIPT_DIR / ".daemon.lock"
SOCKET_PATH = Path("/tmp/whatsapp-daemon.sock")
AUTH_DIR = SCRIPT_DIR / "baileys_auth"
LOG_FILE = SCRIPT_DIR / "logs" / "daemon.log"
STDERR_FILE = SCRIPT_DIR / "logs" / "daemon-stderr.log"
STDOUT_FILE = SCRIPT_DIR / "logs" / "daemon-stdout.log"
MSGSTORE_FILE = SCRIPT_DIR / ".message_store.json"
LAUNCHD_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{DAEMON_LABEL}.plist"

HEARTBEAT_STALE_SECONDS = 90
CONNECTED_GRACE_SECONDS = 60  # daemon may be reconnecting; tolerate brief disconnects


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
    """Count 408 disconnects in the last N seconds (best-effort log scan)."""
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
                if '"code":408' in line:
                    try:
                        ts = json.loads(line).get("time")
                        if ts and ts >= cutoff_ms:
                            count += 1
                    except json.JSONDecodeError:
                        continue
    except OSError:
        pass
    return count


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
    fixed = 0
    for p in [AUTH_DIR, *AUTH_DIR.rglob("*")]:
        try:
            mode = p.stat().st_mode & 0o777
            target = 0o700 if p.is_dir() else 0o600
            if mode != target:
                os.chmod(p, target)
                fixed += 1
        except OSError:
            pass
    return True, f"Reviewed {AUTH_DIR}; fixed {fixed} entr{'y' if fixed == 1 else 'ies'}."


def _fix_create_logs_dir() -> tuple[bool, str]:
    try:
        (SCRIPT_DIR / "logs").mkdir(parents=True, exist_ok=True)
        return True, "logs/ directory ensured."
    except OSError as e:
        return False, f"Cannot create logs/: {e}"


# ---------------------------------------------------------------------------
# Check runner
# ---------------------------------------------------------------------------

def run_checks() -> list[CheckResult]:
    PASS, WARN, FAIL = "PASS", "WARN", "FAIL"
    results: list[CheckResult] = []

    # 1. launchd plist
    if not LAUNCHD_PLIST.is_file():
        results.append(CheckResult(
            FAIL, "launchd-plist",
            f"{LAUNCHD_PLIST} missing. The daemon won't autostart at login.",
            fix_manual=[
                "Re-run the installer from the repo to regenerate the plist files:",
                "  cd <path-to-whatsapp-vault-connector> && bash install.sh",
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

    # 5. Heartbeat
    hb, age = _read_heartbeat()
    if hb is None:
        results.append(CheckResult(
            WARN, "heartbeat",
            "No heartbeat file yet. If daemon just started, this clears in ~30s.",
        ))
    elif age is not None and age > HEARTBEAT_STALE_SECONDS:
        results.append(CheckResult(
            FAIL, "heartbeat",
            f"Heartbeat is {age}s stale (> {HEARTBEAT_STALE_SECONDS}s). Daemon is hung.",
            fix_auto=_fix_kickstart_daemon,
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
        for p in [AUTH_DIR, *AUTH_DIR.rglob("*")]:
            try:
                mode = p.stat().st_mode & 0o777
                target = 0o700 if p.is_dir() else 0o600
                if mode != target:
                    bad_modes += 1
            except OSError:
                continue
        if bad_modes == 0:
            results.append(CheckResult(PASS, "auth-perms", "all 0o700/0o600"))
        else:
            results.append(CheckResult(
                WARN, "auth-perms",
                f"{bad_modes} file(s) in {AUTH_DIR.name}/ have looser permissions than 0o700/0o600.",
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
    decrypt_fails, scoped = _count_recent_decrypt_failures(daemon_start)
    if not scoped:
        results.append(CheckResult(PASS, "session-keys",
                                   "no logs since current daemon start (clean slate)"))
    elif decrypt_fails == 0:
        results.append(CheckResult(PASS, "session-keys", "no decryption failures detected"))
    elif decrypt_fails > 20:
        results.append(CheckResult(
            FAIL, "session-keys",
            f"{decrypt_fails} recent Signal Protocol decryption failures (Bad MAC / PreKeyError). "
            f"The local session state in baileys_auth/ has drifted from your phone's. "
            f"Incoming messages WILL NOT reach the vault until re-pair.",
            fix_manual=[
                "Re-pair the daemon with your phone (5 minutes, requires your phone in hand):",
                "",
                "  1. Stop the daemon:",
                f"       launchctl unload ~/Library/LaunchAgents/{DAEMON_LABEL}.plist",
                "",
                "  2. Back up the broken auth dir (so we can roll back if needed):",
                f"       cd '{SCRIPT_DIR}'",
                "       mv baileys_auth \"baileys_auth_pre_repair_$(date +%Y%m%d_%H%M)\"",
                "",
                "  3. Start the QR pairing flow:",
                "       node sync.mjs",
                "     A QR code will appear in the terminal.",
                "",
                "  4. On your phone: WhatsApp → Settings → Linked Devices → Link a Device. Scan the QR.",
                "     Wait until sync.mjs prints 'Connected to WhatsApp' and exits.",
                "",
                "  5. Restart the daemon:",
                f"       launchctl load ~/Library/LaunchAgents/{DAEMON_LABEL}.plist",
                "",
                "  6. Verify:",
                f"       python '{Path(__file__).resolve()}' doctor",
                "",
                "Note: after re-pair, the old companion device entry on your phone is invalidated.",
                "Historical conversations in the vault are preserved (they're plain markdown).",
                "Old baileys_auth_backup_* folders are safe to delete (contain stale identity keys).",
            ],
        ))
    else:
        # Some failures but below the re-pair threshold — flag for monitoring
        results.append(CheckResult(
            WARN, "session-keys",
            f"{decrypt_fails} decrypt failure(s) since daemon started. "
            f"Monitor; re-pair if count grows or fresh messages stop reaching the vault.",
        ))

    # 11. Disconnect stability (informational)
    disc = _count_recent_disconnects(3600)
    if disc > 30:
        results.append(CheckResult(
            WARN, "stability",
            f"{disc} disconnects in last hour (high). Connection is unstable.",
            fix_manual=[
                "Possible causes: ISP packet loss, VPN interfering, WhatsApp throttling our identity.",
                "If persistent: check Wi-Fi, try wired ethernet, or contact ISP.",
                "Last-resort: re-pair the device by deleting baileys_auth/ and running sync.mjs.",
            ],
        ))
    else:
        results.append(CheckResult(PASS, "stability", f"{disc} disconnect(s) in last hour"))

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

def _print_results(results: list[CheckResult]) -> tuple[int, int, int]:
    passed = warned = failed = 0
    for r in results:
        print(f"  [{r.status}] {r.name:<16} {r.detail}")
        if r.status == "PASS": passed += 1
        elif r.status == "WARN": warned += 1
        else: failed += 1
    print(f"\nSummary: {passed} passed, {warned} warning, {failed} failed.")
    return passed, warned, failed


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_doctor(args) -> int:
    print(f"whatsapp doctor (v{__version__})\n")
    results = run_checks()
    passed, warned, failed = _print_results(results)
    if failed > 0:
        print(f"\nTo auto-repair, run: python {Path(__file__).name} fix")
    _log_event("doctor", "success" if failed == 0 else "failure",
               passed=passed, warned=warned, failed=failed)
    return 0 if failed == 0 else 1


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
                f"Run: python {Path(__file__).resolve()} fix",
                file=sys.stderr,
            )
        _log_event("fix", "partial",
                   auto_fixed=len(auto_fixed_names), manual=len(manual_names), remaining=failed2,
                   quiet=quiet)
        return 1


def cmd_version(args) -> int:
    print(f"wa-fix v{__version__}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="WhatsApp connector: self-healing entry point. Run this when anything is wrong.",
    )
    sub = parser.add_subparsers(dest="command")
    p_doc = sub.add_parser("doctor", help="Read-only diagnostic")
    p_doc.set_defaults(func=cmd_doctor)
    p_fix = sub.add_parser("fix", help="Diagnose + auto-repair (default)")
    p_fix.add_argument("--quiet", action="store_true",
                       help="Suppress normal output; one-line stderr summary only.")
    p_fix.set_defaults(func=cmd_fix)
    p_ver = sub.add_parser("version", help="Print version")
    p_ver.set_defaults(func=cmd_version)

    args = parser.parse_args()
    if args.command is None:
        args = parser.parse_args(["fix"])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
