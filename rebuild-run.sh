docker build -t discord-librarian-bot . && \
docker stop librarian-bot || true && \
docker rm librarian-bot || true && \
docker run -d --name librarian-bot --restart unless-stopped discord-librarian-bot