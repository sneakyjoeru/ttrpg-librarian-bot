FROM node:20-alpine

# Bust the cache for yt-dlp download when there's a new release
ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /tmp/yt-dlp-latest.json
RUN apk add --no-cache curl python3 git ffmpeg sshpass openssh-client && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/bin/yt-dlp && \
    chmod a+rx /usr/bin/yt-dlp

WORKDIR /usr/src/app

RUN git config --global --add safe.directory '*'

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index-librarian.js"]
