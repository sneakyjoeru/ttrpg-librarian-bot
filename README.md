# Librarian Bot for Channels & Roles

Librarian Bot is an advanced Discord bot designed to automate and manage tabletop gaming (TTRPG) server campaigns. It orchestrates the creation of campaign channels, manages associated roles, logs history, automates thread archival, posts recurring announcements, and integrates a retrieval-augmented generation (RAG) assistant using local Ollama (Llama 3.1) and SearXNG instances.

## Features

- **Campaign Management**: Automated creation of active text channels with synced permissions, automatic role creation, and automated sync on channel renames.
- **Natural 1 Roasting**: Integrates with local Llama 3.1 model to generate snarky roasts when players roll a critical fail (Nat 1).
- **RAG QA Mention Pipeline**: Answer player questions using web search context from local SearXNG instances and recent channel chat history via local LLM. Include `"no bs"` in mentions for short, direct responses.
- **Monthly Scheduler**: Cron scheduling for monthly miniature queues with a randomized set of fantasy prompts.
- **Administrative Utilities**: Includes tools like `/retro-setup` to configure old channels, interactive customized polling, pinning/unpinning, and topic overrides.
- **Automatic Archival**: Clean parent transition to archived categories and role cleanup.

---

## Installation & Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (version 18+ recommended)
- Local or remote [Ollama](https://ollama.com/) instance running `llama3.1`
- Local [SearXNG](https://github.com/searxng/searxng) instance (optional, for web RAG queries)
- A Discord Bot Application Token (from the [Discord Developer Portal](https://discord.com/developers/applications))

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

### Running the Bot

Install the dependencies:
```bash
npm install
```

Start the bot:
```bash
npm start
```

---

## Docker Deployment

This repository includes a `Dockerfile` and a `rebuild-run.sh` script to build and run the bot as a detached, self-restarting container.

To deploy via Docker:
```bash
chmod +x rebuild-run.sh
./rebuild-run.sh
```

---

## Environment Variables

You can configure the bot's RAG endpoints using the following environment variables:

- `SEARXNG_URL` (Default: `http://192.168.0.100:9080/search`)
- `OLLAMA_URL` (Default: `http://192.168.0.101:11434/api/generate`)
- `DISCORD_TOKEN` (Fallback if `secrets_discord.php` is missing)
