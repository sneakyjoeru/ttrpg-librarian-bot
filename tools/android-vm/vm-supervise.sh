#!/bin/bash
# android-vm supervisor: keeps the BlissOS Instagram VM reachable for ig-vm-service.
#
# Why: the VM has no autostart and no health watchdog, so after an N150 reboot, a guest
# freeze or a boot that stops at the logo the service answered 503 "vm-down" and the bots
# silently fell back to the cover image ("Video is unavailable for embedding"). This runs
# every 5 minutes (systemd timer) and:
#   1. starts QEMU when it is not running (autostart after a host reboot),
#   2. adb-root's the guest once it is up (needed to read the Instagram cache),
#   3. resets a guest that has been at the boot logo / not answering for too long,
#   4. restarts QEMU when a reset did not help,
#   5. posts to the alert channel when reachability changes (up<->down).
# Safe by default: when the guest is up and adb answers, it only checks root and exits.
set -u
cd "$(dirname "$0")" || exit 1
LOG="$PWD/vm-supervise.log"
STATE="$PWD/vm-supervise.state"
A="/usr/bin/adb -s 127.0.0.1:5555"
BOOT_GRACE=900          # s a fresh/just-reset guest may take before it counts as stuck
RESET_COOLDOWN=1200     # s between two resets

log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $*" >> "$LOG"; }
alert() { local r; r=$(python3 -c 'import sys; sys.path.insert(0,"."); import ig_state; print(ig_state.discord(sys.argv[1]))' "$1" 2>&1); log "alert sent=$r :: $1"; }

# --- single instance ---------------------------------------------------------
exec 9>"$PWD/.vm-supervise.lock"
flock -n 9 || { log "another run is active, skipping"; exit 0; }

qemu_pid() { pgrep -f 'qemu[-]system-x86_64' | head -1; }
qemu_age() { local p; p=$(qemu_pid); [ -n "$p" ] && ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ' || echo 0; }
adb_state() { timeout 12 $A get-state 2>/dev/null | tr -d '\r'; }
boot_done() { [ "$(timeout 12 $A shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; }
has_root() { [ "$(timeout 12 $A shell id -u 2>/dev/null | tr -d '\r')" = "0" ]; }

# --- reached / not reached bookkeeping (for alerts) --------------------------
prev="unknown"; [ -f "$STATE" ] && prev=$(cat "$STATE" 2>/dev/null)
set_state() { echo "$1" > "$STATE"; if [ "$prev" != "$1" ] && [ "$prev" != "unknown" ]; then
        if [ "$1" = "down" ]; then alert "⚠️ Android-VM Instagram fallback is DOWN — bots fall back to the cover image (\"Video is unavailable for embedding\"). Supervisor is working on it."
        else alert "✅ Android-VM Instagram fallback is reachable again."; fi
    fi; }

reset_guest() {
    local last=0; [ -f "$PWD/.vm-last-reset" ] && last=$(cat "$PWD/.vm-last-reset" 2>/dev/null || echo 0)
    local now; now=$(date +%s)
    if [ $((now - last)) -lt $RESET_COOLDOWN ]; then log "reset skipped (cooldown $((now - last))s)"; return 1; fi
    echo "$now" > "$PWD/.vm-last-reset"
    log "guest looks stuck — QEMU system_reset"
    echo system_reset | timeout 5 socat - UNIX-CONNECT:/tmp/mon.sock >/dev/null 2>&1 || log "WARN monitor reset failed"
    sleep 20; timeout 10 adb disconnect 127.0.0.1:5555 >/dev/null 2>&1; timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1
    return 0
}

start_vm() {
    log "qemu not running — ./vm-start.sh"
    setsid ./vm-start.sh < /dev/null >/dev/null 2>&1 &
    sleep 15
}

# --- main --------------------------------------------------------------------
PID=$(qemu_pid)
if [ -z "$PID" ]; then
    start_vm
    set_state down
    log "qemu started (pid $(qemu_pid)), giving the guest $BOOT_GRACE s"
    exit 0
fi

timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1
ST=$(adb_state)
AGE=$(qemu_age)

if [ "$ST" != "device" ]; then
    set_state down
    if [ "$AGE" -gt "$BOOT_GRACE" ]; then
        if reset_guest; then log "reset issued (age ${AGE}s, adb=$ST)"; else
            # reset refused by cooldown and the guest is still dead: full QEMU restart
            if [ "$AGE" -gt $((BOOT_GRACE * 3)) ]; then
                log "reset did not help (age ${AGE}s) — restarting QEMU"
                ./vm-stop.sh >/dev/null 2>&1; sleep 5; start_vm
            fi
        fi
    else
        log "guest booting (age ${AGE}s, adb=$ST) — waiting"
    fi
    exit 0
fi

if ! boot_done; then
    set_state down
    if [ "$AGE" -gt "$BOOT_GRACE" ]; then reset_guest && log "reset issued (boot never completed, age ${AGE}s)"; else log "boot in progress (age ${AGE}s)"; fi
    exit 0
fi

if ! has_root; then
    log "adb root (cache access)"
    timeout 20 $A root >/dev/null 2>&1; sleep 5
    timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1
fi

set_state ok
log "ok (qemu age ${AGE}s, root=$(has_root && echo yes || echo no))"
exit 0
