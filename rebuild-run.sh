docker build --provenance=false -t discord-librarian-bot . && \
docker stop librarian-bot || true && \
docker rm librarian-bot || true && \
docker run -d --name librarian-bot --restart unless-stopped -e HOST_PATH="$(pwd)" -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd):/usr/src/app" -v /usr/src/app/node_modules discord-librarian-bot && \
sleep 15 && \
docker logs librarian-bot