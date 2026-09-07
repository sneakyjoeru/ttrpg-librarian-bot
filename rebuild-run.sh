cookies_mount=""
if [ -f "cookies.txt" ]; then
    cookies_mount="-v $(pwd)/cookies.txt:/usr/src/app/cookies.txt"
elif [ -f "instagram-cookies.txt" ]; then
    cookies_mount="-v $(pwd)/instagram-cookies.txt:/usr/src/app/instagram-cookies.txt"
elif [ -f "../robot-joe-dev/discord-joe/cookies.txt" ]; then
    # Fall back to the sibling discord-joe bot's cookies (same Instagram account).
    # Mount to /tmp/cookies.txt (NOT /usr/src/app/cookies.txt) because /usr/src/app
    # is already a bind mount of the repo dir, and Docker can shadow a file mount
    # on top of a directory mount. /tmp/cookies.txt is in INSTAGRAM_COOKIE_PATHS.
    cookies_mount="-v $(pwd)/../robot-joe-dev/discord-joe/cookies.txt:/tmp/cookies.txt"
elif [ -f "../robot-joe-dev/discord-joe/instagram-cookies.txt" ]; then
    cookies_mount="-v $(pwd)/../robot-joe-dev/discord-joe/instagram-cookies.txt:/tmp/instagram-cookies.txt"
elif [ -f "../robot-joe/cookies.txt" ]; then
    # Legacy fallback for older deployments where the sibling dir was named robot-joe.
    cookies_mount="-v $(pwd)/../robot-joe/cookies.txt:/tmp/cookies.txt"
elif [ -f "../robot-joe/instagram-cookies.txt" ]; then
    cookies_mount="-v $(pwd)/../robot-joe/instagram-cookies.txt:/tmp/instagram-cookies.txt"
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

BUILDX_GIT_INFO=false docker build ${igpu_build_arg} -t discord-librarian-bot . && \
# Fix .git ownership: Docker (root) changes .git ownership during build
# (COPY . ., git operations inside Dockerfile), causing subsequent
# git fetch/reset to fail with "Permission denied". Always chown .git
# back to the repo owner after the build completes.
if [ "$(id -u)" -eq 0 ]; then
    local_owner="$(stat -c '%U' . 2>/dev/null)"
    local_group="$(stat -c '%G' . 2>/dev/null)"
    if [ -n "$local_owner" ] && [ "$local_owner" != "root" ]; then
        chown -R "${local_owner}:${local_group}" .git 2>/dev/null || true
        echo "[rebuild-run] Fixed .git ownership back to ${local_owner}:${local_group}"
    fi
fi && \
docker stop librarian-bot || true && \
docker rm librarian-bot || true && \
# Attach the bot to the shared ollama_default network (when present) so it can
# resolve the Ollama and SearXNG containers by name (ollama / searxng). localhost
# inside the container refers to the container itself and cannot reach host services.
ollama_network_args=""
if docker network inspect ollama_default >/dev/null 2>&1; then
    ollama_network_args="--network ollama_default"
fi

# One-time extended catch-up: if CATCHUP_EXTENDED_HOURS is set in the
# environment, pass it through to the container so the bot runs an extended
# catch-up scan on boot (covers links posted during long outages >6h).
catchup_env=""
if [ -n "${CATCHUP_EXTENDED_HOURS:-}" ]; then
    catchup_env="-e CATCHUP_EXTENDED_HOURS=${CATCHUP_EXTENDED_HOURS}"
    echo "[rebuild-run] CATCHUP_EXTENDED_HOURS=${CATCHUP_EXTENDED_HOURS} — running extended catch-up on boot."
fi

docker run -d --name librarian-bot --restart unless-stopped $ollama_network_args -e SHARE_PASS -e HOST_PATH="$(pwd)" -e TRANSCODER_CONTAINER -e BROWSER_BOT_WS="${BROWSER_BOT_WS:-ws://browser-bot:3000}" -e STREAMER_JOE_API_URL="${STREAMER_JOE_API_URL:-http://192.168.0.99:8777}" $catchup_env -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd):/usr/src/app" -v /usr/src/app/node_modules $cookies_mount $ssh_key_mount $igpu_mount discord-librarian-bot && \
sleep 15 && \
# --- STALE-CODE GUARD ---
# The smb-watcher daemon (bots/smb-watcher) rsyncs the NAS working copy into
# this deploy dir every ~60s (rsync -c compares content checksums, and the
# watch loop re-checks every poll). Because the bot bind-mounts /usr/src/app
# from this dir, Node can load one version of a file at boot while the watcher
# rewrites files on disk milliseconds later (recreating them as root) — leaving
# the RUNNING process on stale code even though disk == git HEAD. This happened
# on 2026-09-07: a mid-edit intermediate version of interactions.js (line 618,
# role.members.cache.has) was loaded at boot; the fix landed on disk 86s later;
# the bot then crashed every /campaign-members add with
# "Cannot read properties of undefined (reading 'has')" until restarted.
# Mitigation: record the boot-time checksums of all source files, then verify
# AFTER the watcher's next poll window(s) have elapsed. If any file on disk no
# longer matches what the process loaded, print a LOUD warning telling the
# operator to restart the container (a plain docker restart reloads the fixed
# code — no image rebuild needed).
boot_stamp="$(date +%s)"
boot_dir="$(pwd)"
boot_manifest="$(mktemp)"
find src tests -type f \( -name '*.js' -o -name '*.json' \) -exec md5sum {} + 2>/dev/null | sort > "$boot_manifest" || true
(
    # Re-check after 2 watcher poll windows (2 * ~60s), then again at boot+10min.
    for delay in 130 600; do
        sleep "$delay"
        cd "$boot_dir" || exit 0
        now_manifest="$(mktemp)"
        find src tests -type f \( -name '*.js' -o -name '*.json' \) -exec md5sum {} + 2>/dev/null | sort > "$now_manifest" || true
        if ! diff -q "$boot_manifest" "$now_manifest" >/dev/null 2>&1; then
            changed="$(diff "$boot_manifest" "$now_manifest" | grep '^>' | awk '{print $2}' | head -8 | tr '\n' ' ')"
            echo "⚠️  [rebuild-run][STALE-CODE WARNING] Files changed on disk AFTER the bot booted: ${changed}"
            echo "⚠️  The running bot process is now on STALE code (smb-watcher rsync or manual edit)."
            echo "⚠️  Run: docker restart librarian-bot   (no rebuild needed — disk code is what will load)"
            rm -f "$boot_manifest" "$now_manifest"
            exit 0
        fi
        rm -f "$now_manifest"
    done
    rm -f "$boot_manifest"
) &
echo "[rebuild-run] Stale-code guard armed (checks at +130s and +10min after boot)."
docker logs librarian-bot