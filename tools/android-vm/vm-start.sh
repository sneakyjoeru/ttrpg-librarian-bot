#!/bin/bash
# BlissOS Android VM, headless. adb: 127.0.0.1:5555 (hostfwd).  UI: VNC on all interfaces, port 5910 (display :10), password in vnc-password.txt
cd "$(dirname "$0")"
ps -eo args | grep -q "^qemu-system-x86_6[4]" && { echo "already running"; exit 0; }
rm -f /tmp/ser.sock /tmp/mon.sock /tmp/ser.log
PW=$(cat vnc-password.txt)
setsid nohup qemu-system-x86_64 -machine pc,accel=kvm -cpu ${VMCPU:-Skylake-Client-noTSX-IBRS} -smp 2 -m 2G -hda disk.img \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555 -device e1000,netdev=net0 \
  -usb -device usb-tablet -device usb-kbd \
  -audiodev none,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0 \
  -serial unix:/tmp/ser.sock,server -monitor unix:/tmp/mon.sock,server,nowait \
  -object secret,id=vncpw,data="$PW" -vnc 0.0.0.0:10,password-secret=vncpw > qemu.log 2>&1 < /dev/null &
sleep 4
setsid nohup python3 ./serd2.py > /tmp/serd2.out 2>&1 < /dev/null &
./novnc-start.sh >/dev/null 2>&1
echo "started; boot takes ~3-4 min. VNC: $(hostname -I | cut -d" " -f1):5910"
