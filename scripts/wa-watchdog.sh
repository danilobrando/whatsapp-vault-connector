#!/bin/bash
# whatsapp-vault-connector
# Copyright (c) 2026 Danny Bravo
# MIT License — see LICENSE
# https://github.com/danilobrando/whatsapp-vault-connector
#
# wa-watchdog.sh — liveness restarter AND reception detector.
#
# History: until 2026-09-05 this script only checked that the daemon process
# existed and its heartbeat was fresh. Both were true for the entire 28-day
# outage in which not a single incoming message reached the vault. Liveness is
# not correctness; a watchdog that only measures breathing will watch a patient
# go deaf and report all clear.
#
# Runs every 60s under launchd. Three jobs, in order:
#   1. Restart the daemon if it is dead or frozen (with a remediation budget —
#      1,954 pointless kickstarts happened over 4 days in Jul-2026 with zero
#      human output).
#   2. Evaluate reception from the daemon's inbound-only signal and ESCALATE
#      TO A HUMAN out of band. WhatsApp is never used as the alert channel:
#      alerting through the daemon writes to the very inbox the detector reads,
#      so the alert would feed the blindness it is reporting.
#   3. Append one line to .wa-health.jsonl on EVERY run. That file is the
#      dead-man source: its silence is itself an alarm for pipeline-watchdog.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HEARTBEAT="$SCRIPT_DIR/.daemon_heartbeat"
HEALTH_LOG="$SCRIPT_DIR/.wa-health.jsonl"
ALERT_STATE="$SCRIPT_DIR/.wa-alert-state"
MUTE_FILE="$SCRIPT_DIR/.wa-mute"
LAST_RUN="$SCRIPT_DIR/.wa-watchdog-last-run"
LOCK_FILE="$SCRIPT_DIR/.daemon.lock"
LOGFILE="$SCRIPT_DIR/logs/watchdog.log"
DAEMON_LABEL="${WHATSAPP_DAEMON_LABEL:-com.whatsapp-connector.daemon}"

# Unified with wa-fix.py's STALE_SECONDS. Two watchdogs disagreeing about what
# "stale" means is worse than one.
STALE_SECONDS="${WA_STALE_SECONDS:-300}"
DEAF_HOURS="${WA_DEAF_HOURS:-18}"          # zero real inbound for this long => alert
DECRYPT_FAIL_1H="${WA_DECRYPT_FAIL_1H:-30}"
KICKSTART_BUDGET="${WA_KICKSTART_BUDGET:-6}"    # per 24h before we complain
KICKSTART_BREAKER="${WA_KICKSTART_BREAKER:-10}" # per 24h before we stop trying
COOLDOWN_SECONDS="${WA_ALERT_COOLDOWN:-21600}"  # 6h between identical alerts
CRIT_HOURS="${WA_CRIT_HOURS:-36}"               # past this, cooldown is ignored
SLEEP_GAP_SECONDS=1800                          # >30min between runs => machine slept
BLIND_SUPPRESS_SECONDS=900                      # ignore deafness 15min after waking

VAULT_ROOT="${VAULT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"

# ── Alert channel ────────────────────────────────────────────────────────────
# There is NO default recipient. A hardcoded address would mean every stranger
# who installs this mails their outage alerts to the author's inbox, and it
# would also read as configured when it is not. Configure one of:
#
#   WA_ALERT_COMMAND  A command run as: <cmd> "<subject>"  with the body on
#                     stdin. The general escape hatch — pipe it to ntfy,
#                     Pushover, Telegram, Slack, sendmail, anything.
#   ALERT_EMAIL       An address, delivered with whatever mailer is found:
#                     WA_MAIL_SENDER (a node script taking --to/--subject/--body),
#                     then `mail`, then `sendmail`.
#
# With neither set, only the local macOS notification fires — which is lost if
# nobody is at the machine. `wa-fix.py doctor` reports that as a real finding,
# because a detector whose alert goes nowhere is the failure this project
# exists to prevent.
ALERT_TO="${ALERT_EMAIL:-}"
ALERT_CMD="${WA_ALERT_COMMAND:-}"
MAIL_SENDER="${WA_MAIL_SENDER:-}"

# When run by hand (notably `--test-alert`) none of the above are set, because
# launchd injects them from the watchdog plist and a shell does not. Reading the
# plist here means a manual test exercises the SAME channel the scheduled job
# will use — otherwise the drill proves nothing about the real path.
WATCHDOG_PLIST="${WA_WATCHDOG_PLIST:-$HOME/Library/LaunchAgents/${DAEMON_LABEL%.daemon}.watchdog.plist}"
if [ -z "$ALERT_TO$ALERT_CMD" ] && [ -f "$WATCHDOG_PLIST" ]; then
  _plist_env() {
    /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$WATCHDOG_PLIST" 2>/dev/null || echo ''
  }
  ALERT_TO="$(_plist_env ALERT_EMAIL)"
  ALERT_CMD="$(_plist_env WA_ALERT_COMMAND)"
  [ -z "$MAIL_SENDER" ] && MAIL_SENDER="$(_plist_env WA_MAIL_SENDER)"
fi

# `wa-watchdog.sh --test-alert` fires one alert through the configured channel
# so you can prove the escalation path works BEFORE you need it. An untested
# alert channel is indistinguishable from a working one right up to the outage.
if [ "${1:-}" = "--test-alert" ]; then
  export WA_FORCE_VERDICT=DEAF
  rm -f "$SCRIPT_DIR/.wa-alert-state" "$SCRIPT_DIR/.wa-mute"
  echo "Firing a test alert through the configured channel..."
fi

mkdir -p "$(dirname "$LOGFILE")"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOGFILE"; }
now_epoch() { date +%s; }
NOW="$(now_epoch)"

hb() {  # hb <key> [default] — read a field from the heartbeat
  python3 -c "
import json,sys
try: print(json.load(open('$HEARTBEAT')).get('$1', '${2:-}') or '${2:-}')
except Exception: print('${2:-}')
" 2>/dev/null || echo "${2:-}"
}

# ── Sleep detection ──────────────────────────────────────────────────────────
# A closed laptop is not a broken connector. Killing the daemon after a sleep
# forces a fresh Signal renegotiation for nothing, and each renegotiation is a
# chance for the session state to drift — the exact failure we are hunting.
SLEPT=0
if [ -f "$LAST_RUN" ]; then
  PREV="$(cat "$LAST_RUN" 2>/dev/null || echo "$NOW")"
  GAP=$(( NOW - PREV ))
  [ "$GAP" -gt "$SLEEP_GAP_SECONDS" ] && { SLEPT=1; log "gap ${GAP}s since last run — machine slept"; echo "$NOW" > "$SCRIPT_DIR/.wa-woke-at"; }
fi
echo "$NOW" > "$LAST_RUN"

WOKE_AT="$(cat "$SCRIPT_DIR/.wa-woke-at" 2>/dev/null || echo 0)"
SUPPRESS_DEAF=0
[ $(( NOW - WOKE_AT )) -lt "$BLIND_SUPPRESS_SECONDS" ] && SUPPRESS_DEAF=1

# ── Kickstart budget ─────────────────────────────────────────────────────────
KICKSTARTS_24H=0
if [ -f "$HEALTH_LOG" ]; then
  KICKSTARTS_24H="$(python3 -c "
import json,time
c=0; cut=time.time()-86400
for l in open('$HEALTH_LOG'):
    try:
        d=json.loads(l)
        if d.get('kickstarted') and d.get('epoch',0)>cut: c+=1
    except Exception: pass
print(c)" 2>/dev/null || echo 0)"
fi

# ── Job 1: liveness ──────────────────────────────────────────────────────────
KICKED=0
REASON="ok"
PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
# Validate the lock PID actually is our daemon. `pgrep -f daemon.mjs` matches
# any command line containing that string — an editor, a grep, this script.
if [ -n "$PID" ] && ! ps -p "$PID" -o command= 2>/dev/null | grep -q "daemon.mjs"; then
  PID=""
fi
[ -z "$PID" ] && PID="$(pgrep -x node 2>/dev/null | while read -r p; do ps -p "$p" -o command= | grep -q "daemon.mjs" && echo "$p" && break; done)"

restart_daemon() {
  if [ "$KICKSTARTS_24H" -ge "$KICKSTART_BREAKER" ]; then
    REASON="circuit_breaker"
    log "CIRCUIT BREAKER: ${KICKSTARTS_24H} kickstarts in 24h — refusing to restart again"
    return 1
  fi
  if [ -n "${1:-}" ]; then
    # Give the daemon its SIGTERM handler a chance: it persists state, the
    # message store and releases the lock. SIGKILL skipped all of that.
    kill -TERM "$1" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      ps -p "$1" >/dev/null 2>&1 || break
      sleep 1
    done
    ps -p "$1" >/dev/null 2>&1 && { log "PID $1 ignored SIGTERM; SIGKILL"; kill -KILL "$1" 2>/dev/null; }
  fi
  launchctl kickstart -k "gui/$(id -u)/$DAEMON_LABEL" >/dev/null 2>&1
  KICKED=1
  return 0
}

if [ -z "$PID" ]; then
  REASON="daemon_dead"; log "daemon NOT running; restart"; restart_daemon ""
elif [ -f "$HEARTBEAT" ]; then
  MTIME="$(stat -f %m "$HEARTBEAT" 2>/dev/null || stat -c %Y "$HEARTBEAT" 2>/dev/null || echo 0)"
  AGE=$(( NOW - MTIME ))
  if [ "$AGE" -gt "$STALE_SECONDS" ]; then
    if [ "$SLEPT" -eq 1 ]; then
      REASON="slept"; log "heartbeat ${AGE}s stale but machine slept — not restarting"
    else
      REASON="heartbeat_stale"; log "PID $PID alive but heartbeat ${AGE}s stale; restart"
      restart_daemon "$PID"
    fi
  fi
fi

# ── Job 2: reception ─────────────────────────────────────────────────────────
CONNECTED="$(hb connected false)"
LAST_IN="$(hb lastInboundRealAt '')"
JIDS="$(hb inboundRealJids24h 0)"
DECFAIL="$(hb decryptFail1h 0)"
WINDOW_OK="$(hb signalWindowComplete False)"
IN_AGE_H="$(python3 -c "
import datetime
s='''$LAST_IN'''.strip()
if not s: print(-1)
else:
    try:
        t=datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
        print(round((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()/3600,2))
    except Exception: print(-1)" 2>/dev/null || echo -1)"

VERDICT="HEALTHY"; FAIL_KEYS=""
add_fail() { FAIL_KEYS="${FAIL_KEYS}${1},"; VERDICT="DEAF"; }

if [ "${WA_FORCE_VERDICT:-}" = "DEAF" ]; then
  add_fail "forced-test"
elif [ "$SUPPRESS_DEAF" -eq 0 ]; then
  awk -v a="$IN_AGE_H" -v d="$DEAF_HOURS" 'BEGIN{exit !(a>=0 && a>=d)}' && add_fail "sin-entrantes-${IN_AGE_H}h"
  [ "$DECFAIL" -ge "$DECRYPT_FAIL_1H" ] && add_fail "descifrado-${DECFAIL}/h"
  if [ "$WINDOW_OK" = "True" ] && [ "$JIDS" -lt 3 ]; then
    awk -v a="$IN_AGE_H" 'BEGIN{exit !(a>=9)}' && add_fail "solo-${JIDS}-contactos-24h"
  fi
fi
[ "$KICKSTARTS_24H" -ge "$KICKSTART_BUDGET" ] && { FAIL_KEYS="${FAIL_KEYS}reinicios-${KICKSTARTS_24H}/24h,"; [ "$VERDICT" = "HEALTHY" ] && VERDICT="THRASHING"; }

# ── Job 3: health line, every run, no exceptions ─────────────────────────────
python3 - "$HEALTH_LOG" "$VERDICT" "$LAST_IN" "$JIDS" "$DECFAIL" "$KICKED" "$REASON" "$KICKSTARTS_24H" "$IN_AGE_H" "${FAIL_KEYS%,}" <<'PYEOF' 2>/dev/null
import json, sys, time, datetime
p,v,last,jids,dec,kicked,reason,ks,age,keys = sys.argv[1:11]
rec = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
       "epoch": int(time.time()), "verdict": v, "lastInboundRealAt": last or None,
       "inboundAgeHours": float(age), "inboundRealJids24h": int(jids),
       "decryptFail1h": int(dec), "kickstarted": kicked == "1",
       "kickstarts24h": int(ks), "reason": reason, "failKeys": keys or None}
with open(p, "a") as f: f.write(json.dumps(rec, ensure_ascii=False) + "\n")
PYEOF

# ── Escalation ───────────────────────────────────────────────────────────────
[ "$VERDICT" = "HEALTHY" ] && { log "healthy (inbound ${IN_AGE_H}h ago, ${JIDS} contacts, ${DECFAIL} decrypt fails)"; exit 0; }

# Mute, with a hard ceiling. An indefinite mute is how a monitoring channel
# dies quietly, so this one always expires — 7 days maximum, and every alert
# states that it is muted rather than hiding the fact.
if [ -f "$MUTE_FILE" ]; then
  MUTE_UNTIL="$(python3 -c "
import json,time
try:
    d=json.load(open('$MUTE_FILE')); u=int(d.get('until',0))
    print(min(u, int(time.time())+604800))
except Exception: print(0)" 2>/dev/null || echo 0)"
  if [ "$NOW" -lt "$MUTE_UNTIL" ]; then
    log "verdict=$VERDICT but muted until $MUTE_UNTIL"; exit 0
  fi
fi

PREV_KEYS=""; PREV_EPOCH=0
[ -f "$ALERT_STATE" ] && { PREV_EPOCH="$(sed -n 1p "$ALERT_STATE" 2>/dev/null || echo 0)"; PREV_KEYS="$(sed -n 2p "$ALERT_STATE" 2>/dev/null || echo '')"; }
SINCE=$(( NOW - PREV_EPOCH ))
SEND=0
[ "$SINCE" -ge "$COOLDOWN_SECONDS" ] && SEND=1                       # cooldown elapsed
[ "${FAIL_KEYS%,}" != "$PREV_KEYS" ] && SEND=1                        # situation changed
awk -v a="$IN_AGE_H" -v c="$CRIT_HOURS" 'BEGIN{exit !(a>=c)}' && SEND=1  # critical: ignore cooldown
[ "$SEND" -eq 0 ] && { log "verdict=$VERDICT suppressed by cooldown (${SINCE}s of ${COOLDOWN_SECONDS}s)"; exit 0; }

if [ "$VERDICT" = "DEAF" ]; then
  HEADLINE="DEAF — no real incoming messages for ${IN_AGE_H}h"
else
  HEADLINE="UNSTABLE — ${KICKSTARTS_24H} daemon restarts in 24h"
fi
SUBJECT="WhatsApp connector: ${HEADLINE}"
BODY="$(cat <<EOF
${HEADLINE}

The connector is alive and is probably still SENDING fine. That says nothing
about reception: during the Aug-2026 outage outbound worked every day for 28
days while not one incoming message arrived.

Evidence
  last real inbound      ${LAST_IN:-never} (${IN_AGE_H}h ago)
  reference: 16.9h       longest quiet gap measured on the vault this was tuned on
  distinct contacts      ${JIDS} in 24h
  decrypt failures       ${DECFAIL} in the last hour
  daemon restarts        ${KICKSTARTS_24H} in 24h
  connected              ${CONNECTED}
  signals                ${FAIL_KEYS%,}

What to do — one command:

    python3 '$SCRIPT_DIR/wa-fix.py' repair

It needs your phone in hand to scan a QR and takes about 6 minutes. To confirm
the diagnosis first:

    python3 '$SCRIPT_DIR/wa-fix.py' doctor

To silence for up to 7 days (never indefinitely):
    echo '{"until": '\$(( \$(date +%s) + 86400 ))', "reason": "travelling"}' > '$MUTE_FILE'
EOF
)"

# Try channels in order of durability. A desktop notification nobody is
# present to see is not an alert, so it is the last resort, never the only one.
sent="none"
if [ -n "$ALERT_CMD" ]; then
  if printf '%s' "$BODY" | sh -c "$ALERT_CMD \"\$1\"" _ "$SUBJECT" >>"$LOGFILE" 2>&1; then
    sent="command"
  fi
fi
if [ "$sent" = "none" ] && [ -n "$ALERT_TO" ]; then
  if [ -n "$MAIL_SENDER" ] && [ -n "$NODE_BIN" ] && [ -f "$MAIL_SENDER" ]; then
    if (cd "$(dirname "$MAIL_SENDER")" && "$NODE_BIN" "$MAIL_SENDER" \
          --to "$ALERT_TO" --subject "$SUBJECT" --body "$BODY") >>"$LOGFILE" 2>&1; then
      sent="mail-sender"
    fi
  fi
  if [ "$sent" = "none" ] && command -v mail >/dev/null 2>&1; then
    printf '%s' "$BODY" | mail -s "$SUBJECT" "$ALERT_TO" >>"$LOGFILE" 2>&1 && sent="mail"
  fi
  if [ "$sent" = "none" ] && [ -x /usr/sbin/sendmail ]; then
    printf 'To: %s\nSubject: %s\n\n%s\n' "$ALERT_TO" "$SUBJECT" "$BODY" \
      | /usr/sbin/sendmail -t >>"$LOGFILE" 2>&1 && sent="sendmail"
  fi
fi
osascript -e "display notification \"${HEADLINE}\" with title \"WhatsApp connector\"" 2>/dev/null || true
[ "$sent" = "none" ] && log "WARNING: no durable alert channel configured (set ALERT_EMAIL or WA_ALERT_COMMAND); only a local notification was shown"

printf '%s\n%s\n' "$NOW" "${FAIL_KEYS%,}" > "$ALERT_STATE"
log "ALERT sent (channel=${sent}) verdict=$VERDICT keys=${FAIL_KEYS%,}"
exit 0
