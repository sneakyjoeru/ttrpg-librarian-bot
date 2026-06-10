# Librarian Bot for Channels & Roles

Librarian Bot is an advanced Discord bot designed to automate and manage tabletop gaming (TTRPG) server campaigns. It orchestrates the creation of campaign channels, manages associated roles, logs history, automates thread archival, posts recurring announcements, and integrates a retrieval-augmented generation (RAG) assistant using local Ollama (Llama 3.1) and SearXNG instances.

## Features

- **Campaign Management**: Automated creation of active text channels with synced permissions, automatic role creation, and automated sync on channel renames.
- **System Message Updates**: Dynamically pulls the last 3 git updates (commit logs) and displays them in the global system help message on startup to keep users informed of the latest bot developments.
- **Natural 1 Roasting**: Integrates with local Llama 3.1 model to generate snarky roasts when players roll a critical fail (Nat 1).
- **RAG QA Mention Pipeline**: Answer player questions using web search context from local SearXNG instances and recent channel chat history via local LLM. Include `"no bs"` in mentions for short, direct responses.
- **Monthly Scheduler**: Cron scheduling for monthly miniature queues with a randomized set of fantasy prompts.
- **Administrative Utilities**: Includes tools like `/retro-setup` to configure old channels, interactive customized polling, pinning/unpinning, and topic overrides.
- **Automatic Archival**: Clean parent transition to archived categories and role cleanup.

## Codebase Layout

The project follows a modular architecture for ease of maintenance:

- **`index-librarian.js`**: Main entry point and orchestrator. Wires event listeners and schedules cron jobs.
- **`src/config.js`**: Centralized configuration store for Discord IDs, API endpoints, fallback values, and slash command metadata.
- **`src/utils/helpers.js`**: Shared utilities, token estimators, and the git log dynamic updates retriever.
- **`src/services/`**: Contain external services like RAG LLM queries and Instagram link scrapers.
- **`src/handlers/`**: Houses modules that process Discord events (`interactionCreate`, `messageCreate`, `channelUpdate`, `channelDelete`, `reactions`).

---

## Installation & Setup

### Requirements & Prerequisites

#### Core Requirements (Always Required)
- **[Node.js](https://nodejs.org/)**: Version 18+ (if running locally without Docker)
- **Discord Bot Application**: A valid token from the [Discord Developer Portal](https://discord.com/developers/applications).
  * **Intents Needed**: Make sure to enable the **Message Content Intent** (privileged intent) under the "Bot" tab of your application settings, along with standard Server Members intents.

#### Optional Requirements (For AI/RAG Features)
- **[Ollama](https://ollama.com/)** (Running `llama3.1`): For dynamic AI QA responses and customized Natural 1 roasts.
- **[SearXNG](https://github.com/searxng/searxng)**: For live web-search context inside the QA pipeline.

*Note: If Ollama or SearXNG are offline or unreachable, the bot will gracefully degrade, falling back to static predefined roasts for Nat 1s and a standard interactive command reference when mentioned, leaving core TTRPG orchestration commands fully functional.*

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

3. Update the server and category IDs in the top section of `index.js`, or configure them through environment variables:
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
This script will automatically stop and remove any existing container named `campaign-bot`, rebuild the image, and start a new detached, self-restarting container.

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

## Environment Variables

You can configure the bot's RAG endpoints using the following environment variables:

- `SEARXNG_URL` (Default: `http://192.168.0.100:9080/search`)
- `OLLAMA_URL` (Default: `http://192.168.0.101:11434/api/generate`)
- `DISCORD_TOKEN` (Fallback if `secrets_discord.php` is missing)
