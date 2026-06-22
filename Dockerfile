FROM node:20-alpine

# Bust the cache for yt-dlp download when there's a new release
ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /tmp/yt-dlp-latest.json
RUN apk add --no-cache curl python3 git ffmpeg sshpass openssh-client docker-cli && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/bin/yt-dlp && \
    chmod a+rx /usr/bin/yt-dlp

# Intel iGPU (N100 / N150) VAAPI driver — only installed when explicitly
# requested via the build arg. The runtime gate in src/utils/cpuDetector.js
# still skips the iGPU stage when the host CPU doesn't match, so this block
# is purely a "have the right userspace driver present" toggle.
#
#   docker build --build-arg INSTALL_INTEL_IGPU_DRIVER=1 ...
#
# rebuild-run.sh automatically sets this arg to 1 when the host CPU is
# detected as an Intel N100 or N150.
ARG INSTALL_INTEL_IGPU_DRIVER=0
RUN if [ "$INSTALL_INTEL_IGPU_DRIVER" = "1" ]; then \
        echo "[Dockerfile] Installing Intel iGPU VAAPI driver stack (intel-media-driver)..."; \
        apk add --no-cache \
            intel-media-driver \
            libva-intel-driver \
            libva-utils \
            mesa-va-gallium; \
        # Smoke-test that the iHD driver can be loaded; non-fatal if it can't
        # (e.g. running this image on a different host later) so the rest of
        # the image still builds.
        (vainfo 2>&1 | head -20 || echo "[Dockerfile] vainfo not functional at build time — that's OK, the iGPU stage will be skipped at runtime if it doesn't work."); \
    else \
        echo "[Dockerfile] Skipping Intel iGPU driver install (INSTALL_INTEL_IGPU_DRIVER=0). Local iGPU stage will be skipped at runtime on non-supported hosts."; \
    fi

WORKDIR /usr/src/app

RUN git config --global --add safe.directory '*'

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index-librarian.js"]
