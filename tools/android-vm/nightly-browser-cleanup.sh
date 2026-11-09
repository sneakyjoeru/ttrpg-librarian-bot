#!/bin/bash
# nightly-browser-cleanup.sh — kill the N150's desktop browsers at 04:00.
#
# Why: the BlissOS Instagram VM (android-vm-supervise.service) shares the N150 with a desktop
# session. When vivaldi / google-chrome / the puppeteer chrome are running, qemu is starved, the
# Instagram app never leaves its crash loop and every extraction ends with "no cached media"
# (measured 2026-11-09). Freeing them nightly keeps the fallback usable without remembering to
# close browsers.
#
# Installed as /etc/cron.d/nightly-browser-cleanup:  0 4 * * * root <this script>
# openclaw's own chrome is NOT in this list and cannot be: it runs inside the containers
# `oc-browser` (browserless) and `oc-external` (gateway image that ships chrome), both with a
# private PID namespace, so a host pkill never touches it. To give openclaw a fresh browser every
# morning the script restarts those two containers after the host kill (`docker restart` = new
# chrome, no restored tabs; login cookies live in the persistent profile and survive).
#
# Manual run / dry run:  sudo /home/sneakyjoe/bin/nightly-browser-cleanup.sh [--dry-run]
set -u
LOG=/home/sneakyjoe/nightly-browser-cleanup.log
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" >> "$LOG"; }

# process-name patterns of the hoggers; matched against the full command line.
# Browser binaries only: a bare "chrome_crashpad" also matched unrelated apps (measured: /opt/Synergy),
# and the crashpad handlers of these browsers die with their parent anyway.
PATTERNS='vivaldi|google-chrome|chromium|chrome-linux64/chrome|chrome-linux/chrome'

pids() {
    ps -eo pid=,args= | grep -E -- "$PATTERNS" | grep -vE 'nightly-browser-cleanup|grep -E' | awk '{print $1}' | sort -u
}

BEFORE=$(pgrep -cf "$PATTERNS" 2>/dev/null); BEFORE=${BEFORE:-0}
log "run start (dry=$DRY) browser processes=$BEFORE load=$(cut -d' ' -f1-3 /proc/loadavg)"

LIST=$(pids)
if [ -z "$LIST" ]; then
    log "no host browsers running"
else
    for p in $LIST; do
        a=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-110)
        if [ "$DRY" = 1 ]; then log "would TERM $p :: $a"; else log "TERM $p :: $a"; kill -TERM "$p" 2>/dev/null; fi
    done
    if [ "$DRY" = 0 ]; then
        sleep 8
        for p in $(pids); do
            log "KILL $p (still alive after TERM) :: $(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-80)"
            kill -9 "$p" 2>/dev/null
        done
        sleep 2
    fi
fi

AFTER=$(pgrep -cf "$PATTERNS" 2>/dev/null); AFTER=${AFTER:-0}
log "host browsers: before=$BEFORE after=$AFTER load=$(cut -d' ' -f1-3 /proc/loadavg)"

# --- openclaw's browser: restart, do not leave it dead --------------------------------------
# Nothing to kill on the host, but a stale browser session is worth discarding daily.
restart_oc() {
    local c st p
    for c in oc-browser oc-external; do
        docker inspect "$c" >/dev/null 2>&1 || { log "container $c not present, skipped"; continue; }
        if [ "$DRY" = 1 ]; then log "would restart container $c"; continue; fi
        log "restarting container $c (fresh browser session)"
        if timeout 120 docker restart "$c" >/dev/null 2>&1; then
            st=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null)
            log "container $c restarted: $st"
        else
            log "WARN docker restart $c failed"
        fi
    done
    [ "$DRY" = 1 ] && return
    sleep 6
    if docker inspect oc-browser >/dev/null 2>&1; then
        p=$(docker exec oc-browser sh -c 'curl -s -m 5 localhost:3000/pressure' 2>/dev/null | cut -c1-140)
        log "browserless /pressure: ${p:-no answer}"
    fi
    for c in oc-internal oc-external; do
        st=$(docker inspect "$c" --format '{{.State.Health.Status}}' 2>/dev/null)
        log "container $c health: ${st:-none}"
    done
}
restart_oc
log "run end load=$(cut -d' ' -f1-3 /proc/loadavg)"
exit 0
