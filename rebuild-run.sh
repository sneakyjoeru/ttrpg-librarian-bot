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

docker build --provenance=false -t discord-librarian-bot . && \
docker stop librarian-bot || true && \
docker rm librarian-bot || true && \
docker run -d --name librarian-bot --restart unless-stopped -e SHARE_PASS -e HOST_PATH="$(pwd)" -e TRANSCODER_CONTAINER -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd):/usr/src/app" -v /usr/src/app/node_modules $cookies_mount $ssh_key_mount discord-librarian-bot && \
sleep 15 && \
docker logs librarian-bot