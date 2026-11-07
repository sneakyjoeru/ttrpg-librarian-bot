#!/bin/bash
/usr/bin/adb -s 127.0.0.1:5555 shell reboot -p 2>/dev/null
for i in $(seq 1 30); do pgrep -f "qemu[-]system-x86_64" >/dev/null || { echo stopped; break; }; sleep 2; done
pgrep -f "qemu[-]system-x86_64" >/dev/null && pkill -f "qemu[-]system-x86_64"
pkill -f "serd2[.]py"
