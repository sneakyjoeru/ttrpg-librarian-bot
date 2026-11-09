#!/bin/bash
# android-vm supervisor: keeps the BlissOS Instagram VM reachable for ig-vm-service.
#
# Why: the VM has no autostart and no health watchdog, so after an N150 reboot, a guest
# freeze or a boot that stops at the logo the service answered 503 "vm-down" and the bots
# silently fell back to the cover image ("Video is unavailable for embedding"). This runs
# every 5 minutes (android-vm-supervise.service, a long-running loop) and:
#   1. starts QEMU when it is not running (autostart after a host reboot / crash / kill),
#   2. continues a paused VM (QEMU 'stop', host I/O-error pause),
#   3. adb-root's the guest once it is up (needed to read the Instagram cache),
#   4. system_reset + cont when the guest stays unreachable for BOOT_GRACE,
#   5. full QEMU restart when it is still dead BOOT_GRACE after that reset,
#   6. posts to the alert channel when reachability changes (up<->down).
# Safe by default: when the guest is up and adb answers, it only checks root and exits.
set -u
cd "$(dirname "$0")" || exit 1
LOG="$PWD/vm-supervise.log"
STATE="$PWD/vm-supervise.state"
A="/usr/bin/adb -s 127.0.0.1:5555"
BOOT_GRACE=${BOOT_GRACE:-900}   # s a guest may stay unreachable (after a start, a reset or its last healthy
                                # check) before the next step: dead -> system_reset -> full QEMU restart.
# Env-overridable so the recovery ladder can be tested without waiting 15 minutes:
#   BOOT_GRACE=60 bash vm-supervise.sh

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

mon() { printf '%s\n' "$1" | timeout 5 socat - UNIX-CONNECT:/tmp/mon.sock 2>/dev/null | tr -d '\r'; }
vm_status() { mon "info status" | grep -ao 'VM status: [a-z-]*' | head -1 | cut -d' ' -f3; }

# Escalation is timed from the last thing WE did to the guest (QEMU start or reset), not from the QEMU
# process age: a system_reset keeps the same process, so its age said nothing about the new boot.
# .vm-guest-since = "<epoch> <start|reset>"
mark() { echo "$(date +%s) $1" > "$PWD/.vm-guest-since"; }
since_epoch() { local e; e=$(cut -d' ' -f1 "$PWD/.vm-guest-since" 2>/dev/null); [ -n "$e" ] && echo "$e" || echo $(( $(date +%s) - $(qemu_age) )); }
last_action() { cut -d' ' -f2 "$PWD/.vm-guest-since" 2>/dev/null || echo start; }

reset_guest() {
    log "guest stuck — QEMU system_reset + cont"
    mon "system_reset" >/dev/null
    # a paused VM (monitor 'stop', host I/O-error pause) stays 'paused (prelaunch)' after a reset
    # until it is continued — measured 2026-11-09 in the self-recovery test
    mon "cont" >/dev/null
    local st; st=$(vm_status)
    [ "$st" = "running" ] || log "WARN monitor not usable (VM status '${st:-unknown}') — the next step is a full restart"
    mark reset
    sleep 20; timeout 10 adb disconnect 127.0.0.1:5555 >/dev/null 2>&1; timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1
}

start_vm() {
    log "qemu not running — ./vm-start.sh"
    # 9>&- : the long-lived QEMU child must NOT inherit the lock fd, or the lock is held forever
    # and every later run logs "another run is active, skipping" (measured 2026-11-09).
    setsid ./vm-start.sh < /dev/null >/dev/null 2>&1 9>&- &
    sleep 15
    mark start
}

restart_vm() {
    log "reset did not bring the guest back — full QEMU restart"
    # vm-stop.sh starts with `adb shell reboot -p`, which never returns on an unresponsive guest:
    # bound it, then SIGKILL QEMU ourselves (measured 2026-11-09).
    timeout 45 ./vm-stop.sh >/dev/null 2>&1 9>&-
    pkill -f 'qemu[-]system-x86_64' 2>/dev/null; sleep 3
    pgrep -f 'qemu[-]system-x86_64' >/dev/null && { pkill -9 -f 'qemu[-]system-x86_64'; sleep 3; }
    rm -f /tmp/mon.sock /tmp/ser.sock
    start_vm
}

# --- main --------------------------------------------------------------------
PID=$(qemu_pid)
if [ -z "$PID" ]; then
    start_vm
    set_state down
    log "qemu started (pid $(qemu_pid)), giving the guest $BOOT_GRACE s"
    exit 0
fi

# a paused VM never comes back on its own: continue it first (cheap, harmless when running)
VS=$(vm_status)
if [ -n "$VS" ] && [ "$VS" != "running" ]; then
    log "qemu reports VM status '$VS' — sending cont"
    mon "cont" >/dev/null; sleep 5
fi

timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1
ST=$(adb_state)
AGE=$(qemu_age)
GUEST_AGE=$(( $(date +%s) - $(since_epoch) ))

if [ "$ST" != "device" ] || ! boot_done; then
    set_state down
    why="adb=${ST:-none}"; [ "$ST" = "device" ] && why="boot not completed"
    if [ "$GUEST_AGE" -le "$BOOT_GRACE" ]; then
        log "guest coming up ($why, ${GUEST_AGE}s since $(last_action)) — waiting"
    elif [ "$(last_action)" = "reset" ]; then
        restart_vm
    else
        log "guest dead for ${GUEST_AGE}s since $(last_action) ($why)"
        reset_guest
    fi
    exit 0
fi

if ! has_root; then
    log "adb root (cache access)"
    timeout 20 $A root >/dev/null 2>&1; sleep 5
    timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1
fi

set_state ok
mark ok   # a later failure is timed from the last healthy check and gets a reset before a full restart
log "ok (qemu age ${AGE}s, root=$(has_root && echo yes || echo no))"
exit 0
