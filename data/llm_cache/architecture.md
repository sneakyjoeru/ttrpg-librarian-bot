# TTRPG Librarian Bot — Architecture Map (LLM Cache)

> Machine-readable, high-density structural breakdown of the **TTRPG Librarian** Discord bot.
> Read this BEFORE tree-parsing the repo.
> Source of truth: live code. This cache MUST be updated atomically with any structural change.

---

## 0. TL;DR

- **Runtime:** Node.js (CommonJS), `discord.js` v14, single process.
- **Entry point:** `index-librarian.js` (root). Sets up gateway clients, registers slash commands, schedules monthly mini-printing cron flows, and handles Discord events.
- **Core routing layer:** `src/handlers/` — delegates gateway interactions (interactions, message creation, reactions, channel deletions/updates) to services.
- **Domain logic:** `src/services/rag.js` — manages internet search retrieval via SearXNG and local/cloud LLM completion pipelines.
- **LLM Pipeline:** Defaults to local Ollama (at `192.168.0.101:11434`) running `qwen3.5:9b`. Automatically evaluates the response using a local quality checker, falling back to DeepSeek API (`deepseek-chat` via `$deepseek_api_key`) if local Ollama's quality is poor or if the local service is offline.
- **Character/Persona:** Bot acts as an old, senile but helpful librarian NPC in D&D/TTRPG-centric Discord servers.

---

## 1. Repository Layout (logical grouping)

```
<repo-root>/
├── index-librarian.js            # ENTRY POINT — gateway connection, cron jobs, status presences
├── src/
│   ├── config.js                 # CONFIGURATION — resolved from environment & secrets_discord.php
│   ├── handlers/                 # EVENT HANDLERS (Routing layer)
│   │   ├── channelDelete.js      #   Handles channel deletion cleanup
│   │   ├── channelUpdate.js      #   Manages category transition logic & permissions
│   │   ├── interactions.js       #   Slash command dispatcher (/roll, /poll-librarian, etc.)
│   │   ├── messageCreate.js      #   Text message dispatcher (handles bot mentions, RAG triggers)
│   │   └── reactions.js          #   Reaction listener (role self-assignment on OP campaigns)
│   ├── services/                 # SERVICES (Domain logic layer)
│   │   └── rag.js                #   Search RAG, target user resolution, history collection & LLM pipeline
│   └── utils/                    # UTILITIES
│       ├── helpers.js            #   Text processing, token estimation, and Git log helpers
│       ├── mediaCompressor.js    #   Ffmpeg compression utilities for files
│       ├── mediaQueue.js         #   Serialized concurrency=1 execution queues
│       ├── messageTracker.js     #   Association mapping for bot replies and triggers
│       ├── shell.js              #   Command runners and script triggers
│       └── webhook.js            #   Placeholder message manager (typing indicators, status updates)
├── data/                         # PERSISTED STATE & CACHES
│   ├── llm_cache/                #   THIS CACHE (architecture.md, schemas.json)
├── secrets_discord.php           # gitignored: $token, $deepseek_api_key, etc.
├── package.json                  # Node dependencies
└── .clinerules                   # AI agent rules & instructions
```

---

## 2. Event → Logic → Response Data Flow

```
Discord Gateway
   │
   ├─ messageCreate ────────────► handleMessageCreate (src/handlers/messageCreate.js)
   │                                 │
   │                                 └─ @LibrarianBot / mention ──► handleRagQuery (src/services/rag.js)
   │                                       ├─ sendTyping
   │                                       ├─ SearXNG Search (context lookup)
   │                                       ├─ Target User / Member lookup
   │                                       ├─ Fetch recent channel history
   │                                       └─ Run LLM Pipeline:
   │                                             ├─ Attempt 1: Local Ollama (192.168.0.101)
   │                                             ├─ Attempt 1 Quality Check (Local Ollama)
   │                                             └─ Fallback (if Check fails / down) ──► DeepSeek API
   │
   └─ interactionCreate ────────► handleInteraction (src/handlers/interactions.js)
                                     ├─ /librarian-bot  -> help message
                                     ├─ /roll           -> roll dice
                                     └─ /poll-librarian -> create reactions poll
```

---

## 3. External Endpoints

| Endpoint | Use |
|---|---|
| `http://192.168.0.101:11434/api/generate` | Local Ollama API (qwen3.5:9b) |
| `https://api.deepseek.com/v1/chat/completions` | DeepSeek API (fallback) |
| `http://192.168.0.100:9080/search` | SearXNG Search Instance |
