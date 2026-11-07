#!/bin/bash
# Browser UI for the VM: http://<host>:6080/vnc.html  (proxies to QEMU VNC on 127.0.0.1:5910)
cd "$(dirname "$0")"
ss -tln | grep -q ":6080 " && { echo "novnc already running"; exit 0; }
setsid nohup ./novnc-venv/bin/websockify --web ./novnc 6080 127.0.0.1:5910 > novnc.log 2>&1 < /dev/null &
sleep 2
echo "noVNC: http://$(hostname -I | cut -d" " -f1):6080/vnc.html?autoconnect=1&resize=scale"
