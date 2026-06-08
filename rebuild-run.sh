docker stop campaign-bot || true && docker rm campaign-bot || true
docker build -t discord-campaign-bot . && docker run -d --name campaign-bot --restart unless-stopped discord-campaign-bot