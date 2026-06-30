# Librarian Bot for Channels & Roles

Librarian Bot is an advanced Discord bot designed to automate and manage tabletop gaming (TTRPG) server campaigns. It orchestrates the creation of campaign channels, manages associated roles, logs history, automates thread archival, posts recurring announcements, and integrates a retrieval-augmented generation (RAG) assistant using the **DeepSeek API** (primary) with a local **Ollama** fallback (`qwen2.5:7b`) and a local **SearXNG** instance.

## Host

The bot runs in a Docker container on an **Intel N150 Mini PC** (12GB RAM + 8GB swap, 512GB SSD, Intel iGPU). Ollama and SearXNG run as separate Docker containers on the same host; all three are attached to the shared `ollama_default` Docker network, so the bot reaches them **by container name** (`ollama`, `searxng`) — not `localhost` (which inside the container is the container itself). The only external dependency is the DeepSeek cloud API. `rebuild-run.sh` attaches the bot container to `ollama_default` automatically when that network exists.

> **Host history:** The bot previously relied on remote network resources — a remote Ollama server at `192.168.0.101` and a remote NAS network-transcoder at `192.168.0.100`. Those remote dependencies were removed in two commits: [`eccb3f1`](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/eccb3f1) *“Replace all local Ollama (192.168.0.101) LLM calls with DeepSeek API”* (dropped the remote Ollama host) and [`02b466a`](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/02b466a) *“DeepSeek-primary RAG + localhost endpoints + drop NAS transcoder”* (dropped the NAS transcoder and switched the local media compressor to local-iGPU → local-CPU only). From commit `02b466a` onward the bot runs entirely on the N150 host with no remote/network resource dependencies (DeepSeek cloud API excepted).

## Features

- **Campaign Management**: Automated creation of active text channels with synced permissions, automatic role creation, and automated sync on channel renames.
- **Instagram Media Interceptor**: Automatically intercepts Instagram posts, stories, and Reels. It retrieves images and videos using a multi-layered downloading system: proxy fixers (`eeinstagram`, `kkinstagram`), parallel scrapers (`instagram-url-direct`, `snapinsta`), and `yt-dlp` using authentication cookies. It also supports slide-selection modifiers (e.g. `1,2` or `-1` to filter specific slides). **Profile URLs** (`instagram.com/<username>`) are parsed into a card showing the user's display name, bio, profile picture, and the last 4 posts' thumbnails + links — instead of butchering the URL into a broken fallback link.
- **Twitter/X Media Interceptor**: Reposts `twitter.com`/`x.com` status links with the tweet text quoted and all media (photos + best-quality videos) attached, fetched via the fxtwitter API (Nitter HTML scrape fallback). Oversized videos are compressed with ffmpeg. Discord's own embed is suppressed.
- **Facebook Media Interceptor**: Reposts `facebook.com`/`fb.watch` reels, posts, photos, and videos. Download strategy: `yt-dlp` (original fbcdn mp4) → `fdown.net` fixer → generic `og:video`/`og:image` scrape. Oversized videos are compressed with ffmpeg.
- **News Article Interceptor**: For known news domains (themoscowtimes.com, meduza.io, and others), the bot suppresses Discord's link-preview embed, attaches the article's lead image, and reposts the article body text as a blockquote inside a thread on the bot's message.
- **iGPU & Local CPU Media Compressor**: Automatically compresses oversized video attachments to fit Discord's file size limits. The transcoding pipeline tries (in order): a local iGPU VAAPI stage on supported hosts, and finally a local CPU `libx264 ultrafast` fallback. The old remote NAS network-transcoder stage has been REMOVED (the bot now runs entirely on the N150 host). The local iGPU stage is automatically detected at runtime for Intel N100 / N150 hosts and uses the host's `/dev/dri/renderD128` VAAPI render node for hardware HEVC encoding. See [Intel N100 / N150 iGPU build](#intel-n100--n150-igpu-build-optional) below.
- **System Message Updates**: Dynamically pulls the last 10 git updates (commit logs) and posts them as clickable GitHub links in a locked `📜 Updates Log` thread attached to the system help message on every restart, keeping the main message uncluttered (just a pointer link + "Last updated" timestamp).
- **Natural 1 Roasting**: Integrates with the local Ollama LLM (`qwen2.5:7b` by default) to generate snarky roasts when players roll a critical fail (Nat 1).
- **RAG QA Mention Pipeline (DeepSeek-primary)**: Answer player questions using web-search context from the local SearXNG instance and recent channel chat history. **DeepSeek is the primary model** while a user has quota (`src/utils/quota.js`, regular + admin tiers); answers are accepted directly (no quality estimation). When quota is exhausted or DeepSeek fails, a single local Ollama attempt (`qwen2.5:7b`) is used. Include `"no bs"` in mentions for short, direct responses.
- **Monthly Scheduler**: Cron scheduling for monthly miniature queues with a randomized set of fantasy prompts.
- **Administrative Utilities**: Includes tools like `/retro-setup` to configure old channels, `/restart` to rebuild/restart the bot via Docker socket, interactive customized polling, pinning/unpinning, and topic overrides.
- **Live Poll Results**: `/poll-librarian` polls are edited live as people vote. Each option lists the names of everyone who reacted, and a `Results` field ( preceded by a `======` separator) declares the 🥇 winner and 🥈 runner-up based on reaction counts. In game (active campaign) channels, only the channel's DM and campaign-role members may vote — unauthorized reactions are automatically removed.
- **Scheduling Poll + Calendar Export**: `/schedule-poll [input]` turns a free-text spec like `Wednesday Friday 4`, `Wed Fri 18:00-22:00 4` (shared time), or `Wed 14:00-16:00 Fri 18:00-22:00 4` (per-day times) into a live poll with one option per weekday for each of the next N weeks (up to 10 weeks / 20 dates). Day names also accept the group tokens `weekdays`/`wdy` (Mon–Fri) and `weekends`/`wke`/`wkd` (Sat–Sun). When there are more than 9 dates, random emojis are used for voting instead of 1️⃣..🔟. In an active campaign channel, the moment every member of the channel's campaign role has voted for the same date(s) (unanimous), the bot auto-generates and posts a Google-importable `.ics` calendar file. *(DM or Admin)*
- **Automatic Archival**: Clean parent transition to archived categories and role cleanup.

## Codebase Layout

The project follows a modular architecture for ease of maintenance:

- **`index-librarian.js`**: Main entry point and orchestrator. Wires event listeners and schedules cron jobs.
- **`src/config.js`**: Centralized configuration store for Discord IDs, API endpoints, fallback values, and slash command metadata.
- **`src/utils/helpers.js`**: Shared utilities, token estimators, and the git log dynamic updates retriever.
- **`src/services/`**: Contain external services like RAG LLM queries and the Instagram link scraper (with profile parsing).
- **`src/handlers/`**: Houses modules that process Discord events (`interactionCreate`, `messageCreate`, `channelUpdate`, `channelDelete`, `reactions`, `polls`) plus the Twitter/X, Facebook, and news-article interceptors (`twitterHandler.js`, `facebookHandler.js`, `articleHandler.js`).

---

## Installation & Setup

### Requirements & Prerequisites

#### Core Requirements (Always Required)

- **[Node.js](https://nodejs.org/)**: Version 18+ (if running locally without Docker)
- **Discord Bot Application**: A valid token from the [Discord Developer Portal](https://discord.com/developers/applications).
  - **Intents Needed**: Make sure to enable the **Message Content Intent** (privileged intent) under the "Bot" tab of your application settings, along with standard Server Members intents.

#### Optional Requirements (For AI/RAG Features)

- **[Ollama](https://ollama.com/)** (Running `qwen2.5:7b` by default): Local fallback for the DeepSeek-primary RAG pipeline and customized Natural 1 roasts. Shared with robot joe on the same N150 Ollama daemon (one resident model).
- **[SearXNG](https://github.com/searxng/searxng)**: For live web-search context inside the QA pipeline. Both Ollama and SearXNG run as Docker containers on the N150 host, attached to the shared `ollama_default` network so the bot reaches them by container name (`ollama` / `searxng`).
- **DeepSeek API key** (`$deepseek_api_key` in `secrets_discord.php`): the PRIMARY response model.

_Note: If Ollama or SearXNG are offline or unreachable, the bot will gracefully degrade, falling back to static predefined roasts for Nat 1s and a standard interactive command reference when mentioned, leaving core TTRPG orchestration commands fully functional._

### Configuration

1. Copy `secrets_discord_example.php` to `secrets_discord.php`:
   ```bash
   cp secrets_discord_example.php secrets_discord.php
   ```
2. Open `secrets_discord.php` and fill in your Discord credentials:

   ```php
   $app_id        = 'YOUR_APP_ID';
   $public_key    = 'YOUR_PUBLIC_KEY';
   $token         = 'YOUR_DISCORD_BOT_TOKEN';
   $client_id     = 'YOUR_CLIENT_ID';
   $client_secret = 'YOUR_CLIENT_SECRET';
   ```

3. Update the server and category IDs in `src/config.js`, or configure them through environment variables:
   - `SERVER_ID`
   - `ACTIVE_CATEGORY_ID`
   - `ARCHIVED_CATEGORY_ID`
   - `DM_ROLE_ID`

### Running the Bot (Recommended: Docker)

The easiest way to build, run, and update the bot is using the provided Docker configuration. This ensures all dependencies are managed correctly inside the container.

To deploy or update the bot, simply run the helper script:

```bash
chmod +x rebuild-run.sh
./rebuild-run.sh
```

This script will automatically stop and remove any existing container named `librarian-bot`, rebuild the image, and start a new detached, self-restarting container. The script mounts the host's Docker socket (`/var/run/docker.sock`) and code volume dynamically so that the bot can perform administrative rebuilds and self-restarts via the `/restart` slash command.

### Running Locally (Alternative: Node.js)

If you prefer to run the bot directly on your host machine:

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Start the bot:
   ```bash
   npm start
   ```

---

## Intel N100 / N150 iGPU Build (Optional)

When the bot is hosted on an Intel N100 or N150 mini PC, the on-board Intel
UHD Graphics iGPU (Quick Sync / VAAPI) is dramatically faster than the CPU
for HEVC encoding. The transcoding pipeline takes advantage of it
automatically, but only if the right userspace drivers are baked into the
image.

`rebuild-run.sh` automatically detects the **host** CPU and passes
`--build-arg INSTALL_INTEL_IGPU_DRIVER=1` to `docker build` only when the
host `/proc/cpuinfo` reports an N100 or N150. The Dockerfile then installs
`intel-media-driver` (iHD, the modern driver for N100/N150), the legacy
`libva-intel-driver` for safety, `libva-utils` (provides `vainfo` for
debugging) and `mesa-va-gallium`. On any other host the driver stack is
**not** installed, keeping the image lean.

The runtime gate lives in `src/utils/cpuDetector.js`: even with the
drivers installed, the iGPU stage is skipped unless both
- the host CPU model matches N100/N150, **and**
- `/dev/dri/renderD128` is accessible from the container.

`rebuild-run.sh` also auto-mounts `/dev/dri/renderD128` and `/dev/dri/card0`
into the container when those nodes exist on the host, so no manual
`--device` flags are needed.

If you need to override the auto-detection (e.g. building the image on
a beefy machine and pushing it to a remote N150), set the env var
manually before invoking `rebuild-run.sh`:

```bash
FORCE_INTEL_IGPU_DRIVER=1 ./rebuild-run.sh
```

To verify the iGPU stage is working after a deploy, run
`docker exec librarian-bot vainfo` — you should see `Driver version:
Intel iHD driver for Intel(R) Gen Graphics` and at least one VAEntrypoint
listed. If `vainfo` errors with "Failed to open /dev/dri/renderD128",
double-check that the render node is mounted and that the container's
user is in the `render` group (GID 106 on most distros).

---

## Environment Variables

You can configure the bot's RAG endpoints using the following environment variables:

- `SEARXNG_URL` (Default: `http://searxng:8080/search` — container name on the `ollama_default` network; override with `http://localhost:9080/search` only if running the bot outside Docker on the host)
- `OLLAMA_URL` (Default: `http://ollama:11434/api/generate` — container name on the `ollama_default` network; override with `http://localhost:11434/api/generate` only if running outside Docker)
- `DISCORD_TOKEN` (Fallback if `secrets_discord.php` is missing)
