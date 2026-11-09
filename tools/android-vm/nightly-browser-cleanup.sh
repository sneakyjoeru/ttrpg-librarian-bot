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
    log "nothing to kill"
    exit 0
fi

for p in $LIST; do
    a=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-110)
    if [ "$DRY" = 1 ]; then log "would TERM $p :: $a"; else log "TERM $p :: $a"; kill -TERM "$p" 2>/dev/null; fi
done

[ "$DRY" = 1 ] && { log "dry run end"; exit 0; }

sleep 8
LEFT=$(pids)
for p in $LEFT; do
    log "KILL $p (still alive after TERM) :: $(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-80)"
    kill -9 "$p" 2>/dev/null
done

sleep 2
AFTER=$(pgrep -cf "$PATTERNS" 2>/dev/null); AFTER=${AFTER:-0}
log "run end browser processes=$AFTER load=$(cut -d' ' -f1-3 /proc/loadavg)"
exit 0
