docker build --provenance=false -t discord-librarian-bot . && \
docker stop librarian-bot || true && \
docker rm librarian-bot || true && \
docker run -d --name librarian-bot --restart unless-stopped discord-librarian-bot && \
sleep 15 && \
docker logs librarian-bot