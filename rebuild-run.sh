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
igpu_mount=""
if [ -e "/dev/dri/renderD128" ]; then
    igpu_mount="--device /dev/dri/renderD128 --device /dev/dri/card0"
    echo "[rebuild-run] /dev/dri/renderD128 detected — mounting Intel iGPU into the container."
else
    echo "[rebuild-run] /dev/dri/renderD128 not present on host — local iGPU transcoding will be skipped."
fi

BUILDX_GIT_INFO=false docker build --provenance=false -t discord-librarian-bot . && \
docker stop librarian-bot || true && \
docker rm librarian-bot || true && \
docker run -d --name librarian-bot --restart unless-stopped -e SHARE_PASS -e HOST_PATH="$(pwd)" -e TRANSCODER_CONTAINER -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd):/usr/src/app" -v /usr/src/app/node_modules $cookies_mount $ssh_key_mount $igpu_mount discord-librarian-bot && \
sleep 15 && \
docker logs librarian-bot