cookies_mount=""
if [ -f "cookies.txt" ]; then
    cookies_mount="-v $(pwd)/cookies.txt:/usr/src/app/cookies.txt"
elif [ -f "instagram-cookies.txt" ]; then
    cookies_mount="-v $(pwd)/instagram-cookies.txt:/usr/src/app/instagram-cookies.txt"
fi

ssh_key_mount=""
if [ -f "id_rsa" ]; then
    ssh_key_mount="-v $(pwd)/id_rsa:/usr/src/app/id_rsa"
elif [ -f "id_ed25519" ]; then
    ssh_key_mount="-v $(pwd)/id_ed25519:/usr/src/app/id_ed25519"
elif [ -f "id_ed25519_bot" ]; then
    ssh_key_mount="-v $(pwd)/id_ed25519_bot:/usr/src/app/id_rsa"
elif [ -f "../id_rsa" ]; then
    ssh_key_mount="-v $(pwd)/../id_rsa:/usr/src/app/id_rsa"
elif [ -f "../id_ed25519" ]; then
    ssh_key_mount="-v $(pwd)/../id_ed25519:/usr/src/app/id_ed25519"
elif [ -f "../id_ed25519_bot" ]; then
    ssh_key_mount="-v $(pwd)/../id_ed25519_bot:/usr/src/app/id_rsa"
fi

# Mount the host's /dev/dri (Intel iGPU render node) into the container if
# it exists, so the local VAAPI transcoding stage can run on supported Intel
# SoCs (N100 / N150). Skipped automatically on hosts without an Intel iGPU.
#
# We probe for the render node AND any present card device. The card
# device name is platform-dependent: most N100/N150 systems expose
# /dev/dri/card0, but some kernels / driver configurations name it
# card1, and headless iGPU-only setups may not expose a card device at
# all (only renderD128). Mount whatever actually exists — never fail on
# a missing optional device.
igpu_mount=""
igpu_card_devices=""
if [ -e "/dev/dri/renderD128" ]; then
    for card_dev in /dev/dri/card0 /dev/dri/card1; do
        if [ -e "${card_dev}" ]; then
            igpu_card_devices="${igpu_card_devices} --device ${card_dev}"
        fi
    done
    # Add the render node's GID to the container's supplementary groups so a
    # non-root container process can open the (typically root:render) render
    # node. Falls back to GID 109 (the "render" group on most Debian-based
    # images) when stat fails. Mirrors the robot-joe deployment.
    igpu_render_gid="$(stat -c '%g' /dev/dri/renderD128 2>/dev/null || echo 109)"
    igpu_mount="--device /dev/dri/renderD128${igpu_card_devices} --group-add ${igpu_render_gid}"
    if [ -n "${igpu_card_devices}" ]; then
        echo "[rebuild-run] /dev/dri/renderD128 detected (with card device(s), render gid ${igpu_render_gid}) — mounting Intel iGPU into the container."
    else
        echo "[rebuild-run] /dev/dri/renderD128 detected (no /dev/dri/card* device on host, render gid ${igpu_render_gid}; iGPU userspace should still work) — mounting Intel iGPU render node into the container."
    fi
else
    echo "[rebuild-run] /dev/dri/renderD128 not present on host — local iGPU transcoding will be skipped."
fi

# Detect Intel N100 / N150 on the host and tell the Dockerfile to install
# the iHD VAAPI driver stack (intel-media-driver + libva-intel-driver +
# libva-utils + mesa-va-gallium). When the host CPU doesn't match, the
# driver is NOT installed and the local iGPU stage will be skipped at
# runtime by src/utils/cpuDetector.js. This keeps the image lean on hosts
# that don't benefit from the iGPU stage.
igpu_build_arg=""
host_cpu_model="$(grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | sed 's/^model name\s*:\s*//')"
if [ "${FORCE_INTEL_IGPU_DRIVER:-0}" = "1" ]; then
    # Manual override — useful when building on a different host than the
    # one that'll run the image.
    igpu_build_arg="--build-arg INSTALL_INTEL_IGPU_DRIVER=1"
    echo "[rebuild-run] FORCE_INTEL_IGPU_DRIVER=1 set — installing Intel iGPU VAAPI driver in the image."
elif echo "${host_cpu_model}" | grep -Eqi '\bN(100|150)\b'; then
    igpu_build_arg="--build-arg INSTALL_INTEL_IGPU_DRIVER=1"
    echo "[rebuild-run] Host CPU detected as '${host_cpu_model}' (N100/N150) — installing Intel iGPU VAAPI driver in the image."
else
    echo "[rebuild-run] Host CPU '${host_cpu_model:-unknown}' is not in the supported iGPU list — skipping driver install in the image."
fi

# Write rebuild timestamp (used by the bot's catch-up mechanic to scan for
# missed requests during the downtime window).
date -u +"%Y-%m-%dT%H:%M:%SZ" > rebuild_time.txt

# Notify the running container that a rebuild is starting (SIGUSR2 → the bot
# sets its Discord presence to "Upgrading..." / dnd so users see the update).
docker kill --signal=SIGUSR2 librarian-bot 2>/dev/null || true

# Clean any old progress file inside the container
docker exec librarian-bot rm -f /usr/src/app/build_progress.txt 2>/dev/null || true

BUILDX_GIT_INFO=false docker build --provenance=false ${igpu_build_arg} -t discord-librarian-bot . && \
docker stop librarian-bot || true && \
docker rm librarian-bot || true && \
docker run -d --name librarian-bot --restart unless-stopped -e SHARE_PASS -e HOST_PATH="$(pwd)" -e TRANSCODER_CONTAINER -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd):/usr/src/app" -v /usr/src/app/node_modules $cookies_mount $ssh_key_mount $igpu_mount discord-librarian-bot && \
sleep 15 && \
docker logs librarian-bot