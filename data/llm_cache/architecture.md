# TTRPG Librarian Bot — Architecture Map (LLM Cache)

> Machine-readable, high-density structural breakdown of the **TTRPG Librarian**
> Discord bot.
> Read this BEFORE tree-parsing the repo.
> Source of truth: live code. This cache MUST be updated atomically with any
> structural change.

---

## 0. TL;DR

- **Runtime:** Node.js (CommonJS), `discord.js` v14, single process. Hosts as
  a Docker container (Alpine `node:20`, see `Dockerfile`).
- **Entry point:** `index-librarian.js` (root). Builds the gateway client,
  registers slash commands, edits the system help message on every restart,
  schedules the monthly mini-printing cron, and wires every Discord event
  to a handler module.
- **Core routing layer:** `src/handlers/` — delegates gateway events
  (`messageCreate`, `interactionCreate`, `messageReactionAdd/Remove`,
  `channelUpdate`, `channelDelete`) to services.
- **Domain logic (services):** `src/services/`
  - `rag.js` — RAG pipeline (SearXNG context, history collection, persona).
    DeepSeek-primary: routes to **DeepSeek first** while the user has quota
    (`src/utils/quota.js`, persisted to `data/quota.json`), and falls back to
    **local Ollama** (`qwen2.5:7b` at `localhost:11434`) with a single direct
    attempt (no quality estimation) when quota is exhausted or DeepSeek fails.
    The old local-Ollama quality-estimator + DeepSeek-from-Ollama fallback chain
    has been dropped — DeepSeek answers are accepted directly. **Two tiers** are tracked
    per user in independent buckets: regular users get
    `QUOTA_MAX_REQUESTS` (= 10) per `QUOTA_WINDOW_HOURS` (= 5h); admins
    get `QUOTA_ADMIN_MAX_REQUESTS` (= 30) per `QUOTA_ADMIN_WINDOW_HOURS`
    (= 3h). The admin tier is granted to any guild member who has the
    `ADMIN_ROLE_ID` role, **or** the `DM_ROLE_ID` role, **or** the
    `PermissionFlagsBits.Administrator` permission — these are three
    distinct role/permission concepts (server admin vs. dungeon-master vs.
    Discord's native admin flag), and the quota check is intentionally
    more generous than the slash-command permission check
    (`src/handlers/interactions.js`) which only honours `DM_ROLE_ID` /
    `Administrator` for the campaign-management commands. The tier is
    computed in `handleRagQuery` from `message.member` and passed as the
    second arg to `consumeQuota(userId, isAdmin)`. Also generates Natural-1
    roasts for `/roll`.
  - `instagram.js` — Instagram link interceptor with multi-source
    downloading (fixer domains `eeinstagram` / `kkinstagram` / `uuinstagram`,
    parallel scrapers `instagram-url-direct` + `snapinsta`, and `yt-dlp`
    with auth cookies) and oversized video re-encoding.
- **Media compressor:** `src/utils/mediaCompressor.js`. Two-stage pipeline
  (the remote NAS network transcoder at `192.168.0.100` has been REMOVED):
  **local iGPU** (Intel N100/N150 only, gated by `src/utils/cpuDetector.js` +
  `/dev/dri/renderD128`) → **local CPU** (`libx264 ultrafast` CRF ladder).
  `src/utils/shell.js` `buildSshPrefix()`/`hasRemoteAccess()` are now no-ops
  (return `""`/`false`) so the network transcoder stage is always skipped. All
  oversized Instagram videos funnel through it. See section 4.
- **Discord features the bot owns:**
  - Campaign lifecycle — channel creation, role provisioning, OP workflow,
    archive, auto-rename sync. Persistence via the
    `[LIBRARIAN_DATA|DM:<id>|ROLE:<id>]` token in the channel topic.
  - Instagram media interception — see `src/services/instagram.js`.
  - Slash commands — 13 commands (see section 7).
  - Text commands `!pin` / `!unpin` for the DM/admin.
  - Reaction-based role self-assignment on campaign OPs (`✋`).
  - System help message + updates thread — see section 6. The system
    message itself is minimal (no commit history): just a `/librarian-bot`
    hint, a single link to the locked thread, and the "Last updated"
    timestamp. The updates themselves live ONLY in the thread's first
    bot message — the last 10 git log entries, edited in place on every
    restart.
  - Self-rebuild via `/restart` (uses Docker socket).
  - Monthly cron (`CRON_SCHEDULE_MONTHLY_MINI`) — auto-posts the 3D
    printing queue to `GENERAL_CHANNEL_ID` with a ±2h randomized delay,
    tagging `SNEAKYJOE_USER_ID` and linking to `RULES_MESSAGE_ID`.
- **Character/Persona:** Old, senile but helpful librarian NPC in
  D&D/TTRPG-centric Discord servers. Persona is steered by a per-query
  randomly-selected "quirk" line and a numeric seed embedded in the system
  prompt to keep roleplay output deterministic yet varied.
- **Secrets:** `$token` and `$deepseek_api_key` live in
  `secrets_discord.php` (gitignored). The PHP file is regex-parsed at
  startup so the container doesn't need a PHP runtime.

---

## 1. Repository Layout (logical grouping)

```
<repo-root>/
├── index-librarian.js            # ENTRY POINT — gateway client, restart
│                                 #   message patch, slash command registration,
│                                 #   system message editor, monthly mini cron,
│                                 #   event-listener wiring
├── Dockerfile                    # node:20-alpine + ffmpeg + curl + sshpass
│                                 #   + openssh + yt-dlp. Optionally installs
│                                 #   intel-media-driver (iHD) and friends via
│                                 #   build arg INSTALL_INTEL_IGPU_DRIVER=1.
├── rebuild-run.sh                # Host-side build+run helper. Auto-detects
│   #   Intel iGPU + driver, sends SIGUSR2 to the running container (bot sets
│   #   Discord presence to "Upgrading..." / dnd), writes rebuild_time.txt
│   #   (for the bot's catch-up mechanic), and runs a fresh docker run with
│   #   --device /dev/dri passthrough.
│                                 #   N100/N150 on the host and passes the
│                                 #   iGPU build arg; auto-mounts
│                                 #   /dev/dri/renderD128 (and any present
│                                 #   /dev/dri/card* device) into the container;
│                                 #   mounts cookies.txt and SSH keys if found
│                                 #   in the repo / parent directory; passes
│                                 #   SHARE_PASS / TRANSCODER_CONTAINER env
│                                 #   vars; mounts /var/run/docker.sock for
│                                 #   /restart self-rebuild.
├── ttrpg librarian bot.code-workspace  # VS Code workspace config
├── secrets_discord.php           # gitignored: $token, $deepseek_api_key,
│                                 #   $client_secret, $share_pass, $app_id,
│                                 #   $public_key, $client_id
├── secrets_discord_example.php   # Template for secrets_discord.php
├── package.json                  # node deps (axios, discord.js,
│                                 #   instagram-url-direct, snapinsta,
│                                 #   node-cron)
├── README.md                     # Human-readable project docs
├── PRIVACY_POLICY.md             # User-facing privacy notice
├── TOS.md                        # User-facing terms of service
├── data/                         # PERSISTED STATE & CACHES
│   ├── llm_cache/                #   THIS CACHE (architecture.md,
│   │                             #   schemas.json) — DO NOT touch from
│   │                             #   runtime code
│   ├── quota.json                #   Per-user DeepSeek quota state
│   │                             #   (created at runtime by
│   │                             #   src/utils/quota.js)
│   ├── schedules.json            #   /schedule-poll state: per poll-message
│   │                             #   { channelId, guildId, creatorId, roleId,
│   │                             #   options:[{emoji,isoDate,start,end,allDay,
│   │                             #   label}], lastEmittedConfirmed, createdAt } (created at
│   │                             #   runtime by src/utils/scheduling.js)
│   └── system_state.json         #   Thread id + updates-message id for the
│                                 #   system help thread (created at runtime
│                                 #   by src/utils/systemState.js)
├── src/
│   ├── config.js                 # CONFIGURATION — loads secrets from PHP
│   │                             #   file, env vars, hard-coded Discord IDs,
│   │                             #   endpoint URLs, slash command metadata,
│   │                             #   fallback roasts, FFMPEG constants, IGPU
│   │                             #   constants, quota constants, system-
│   │                             #   updates constants, etc.
│   ├── handlers/                 # EVENT HANDLERS (Routing layer)
│   │   ├── channelDelete.js      #   Auto-removes the campaign role when an
│   │   │                         #   active or archived channel is deleted
│   │   ├── channelUpdate.js      #   Auto-renames the role to match the
│   │   │                         #   channel when a DM manually renames it
│   │   ├── interactions.js       #   Slash command dispatcher (13 commands;
│   │   │                         #   see section 7)
│   │   ├── messageCreate.js      #   Text dispatcher — Instagram link
│   │   │                         #   detection (instagram.com + dd/kk/ee/uu/rx
│   │   │                         #   mirror domains, optional protocol, URL
│   │   │                         #   normalization), @mention → RAG, !pin/!unpin,
│   │   │                         #   OP auto-pinning + role assignment
│   │   ├── polls.js              #   /poll-librarian + /schedule-poll live
│   │   │                         #   results: recount number reactions, show
│   │   │                         #   voter mentions per option, declare winner +
│   │   │                         #   runner-up; recognizes both `📊 ` (custom
│   │   │                         #   poll) and `📅 ` (scheduling poll) embed title
│   │   │                         #   markers and matches NUMBER_EMOJIS OR
│   │   │                         #   RANDOM_EMOJIS option prefixes; in game
│   │   │                         #   (active campaign) channels only the channel
│   │   │                         #   DM and campaign-role members may vote (others
│   │   │                         #   are auto-removed). Refreshed on add/remove.
│   │   ├── scheduling.js         #   /schedule-poll: parses the free-text spec
│   │   │                         #   (days + optional per-day time + weeks) via
│   │   │                         #   src/utils/scheduling.js, expands it into one
│   │   │                         #   poll option per (weekday × week), picks
│   │   │                         #   NUMBER_EMOJIS (≤9 dates) or RANDOM_EMOJIS
│   │   │                         #   (>9) for voting, posts the `📅 ` embed,
│   │   │                         #   persists state to data/schedules.json, and
│   │   │                         #   on every vote change checks which options
│   │   │                         #   every eligible voter (campaign role + DM)
│   │   │                         #   voted for → auto-generates + posts a Google-
│   │   │                         #   importable .ics whenever the confirmed set
│   │   │                         #   changes (lastEmittedConfirmed signature).
│   │   └── reactions.js          #   ✋ reaction → campaign role assignment
│   │                             #   (only if 🤖 is also present, i.e. the
│   │                             #   bot reacted to the OP). Also delegates
│   │                             #   number-emoji reactions on poll messages to
│   │                             #   polls.js for live vote recounting.
│   ├── services/                 # SERVICES (Domain logic layer)
│   │   ├── rag.js                #   Search RAG, target-user resolution,
│   │   │                         #   history collection, persona quirks,
│   │   │                         #   quota-gated LLM pipeline, natural-1
│   │   │                         #   roast generator
│   │   └── instagram.js          #   Instagram link interceptor with
│   │                             #   multi-source download (fixer domains,
│   │                             #   parallel scrapers, yt-dlp), media-queue
│   │                             #   serialization, oversized video re-encoding
│   └── utils/                    # UTILITIES
│       ├── cpuDetector.js        #   Host CPU / iGPU detection (Intel
│       │                         #   N100/N150 + /dev/dri/renderD128 probe)
│       ├── helpers.js            #   getLibrarianData() topic-token parser,
│       │                         #   estimateTokens() (rough char/2-byte
│       │                         #   model), isHistoryOrAnalysisQuery()
│       │                         #   keyword sniffer, getLastUpdates(n) —
│       │                         #   runs `git log -N --reverse` and formats
│       │                         #   it as a markdown list (count is
│       │                         #   SYSTEM_UPDATES_LIMIT)
│       ├── mediaCompressor.js    #   ffmpeg compression utilities. Pipeline:
│       │                         #   iGPU → network → local CPU. Also
│       │                         #   getGuildFileLimit() (boost tier →
│       │                         #   bytes) and chunkAttachmentsBySize() for
│       │                         #   Discord's 10-attachment-per-message
│       │                         #   and per-size limits
│       ├── mediaQueue.js         #   Serialized concurrency=1 execution queue
│       │                         #   so two Instagram downloads don't race
│       │                         #   for temp files or bandwidth
│       ├── messageTracker.js     #   In-memory cap-1000 map of bot/webhook
│       │                         #   message IDs to the user who triggered
│       │                         #   them, used for "is this bot message
│       │                         #   tied to me?" checks in /roll, !pin,
│       │                         #   etc.
│       ├── quota.js              #   Per-user DeepSeek quota tracker
│       │                         #   (sliding window, persistent JSON store)
│       ├── scheduling.js         #   /schedule-poll support: parseSchedulingInput
│       │                         #   (days + optional per-day HH:MM[-HH:MM] +
│       │                         #   weeks → spec with per-weekday time windows),
│       │                         #   generateScheduleOptions (TZ-aware
│       │                         #   via Intl.DateTimeFormat in TIMEZONE, caps at
│       │                         #   SCHEDULE_MAX_OPTIONS=20), buildIcs (RFC 5545
│       │                         #   .ics with floating local times / all-day
│       │                         #   VALUE=DATE), and the schedules.json state
│       │                         #   store (atomic temp-file + rename, in-process
│       │                         #   write Promise chain).
│       ├── shell.js              #   runCommand (exec), prepareSshKey /
│       │                         #   buildSshPrefix / hasRemoteAccess (SSH
│       │                         #   key or sshpass), runCommandWithProgress
│       │                         #   (parses ffmpeg time= stderr), findYtDlpPath
│       ├── systemState.js        #   Persistent (threadId, updatesMessageId)
│       │                         #   store for the system-updates thread.
│       │                         #   Atomic temp-file + rename writes; in-process
│       │                         #   write mutex.
│       └── webhook.js            #   Placeholder manager: sendWorkingPlaceholder,
│                                 #   updatePlaceholderStage, updateWorkingPlaceholder,
│                                 #   sendRepostedMessage. Reposts use a channel
│                                 #   webhook (created on demand) so the original
│                                 #   user's name + avatar are preserved
└── .clinerules                   # AI agent rules & instructions (not in cache)
```

---

## 2. Event → Logic → Response Data Flow

```
Discord Gateway
   │
   ├─ messageCreate ────────────► handleMessageCreate (src/handlers/messageCreate.js)
   │                                 │
   │                                 ├─ Instagram URL?  ──► handleInstagramMessage
   │                                 │                      (src/services/instagram.js)
   │                                 │                      ├─ Placeholder message + delete original
   │                                 │                      ├─ mediaQueue (single-flight)
   │                                 │                      ├─ Try fixers (ee/kk/uu-instagram.com)
   │                                 │                      ├─ Try parallel scrapers (yt-dlp +
   │                                 │                      │   instagram-url-direct/snapinsta)
   │                                 │                      ├─ For each oversized mp4 → compressVideoToFit
   │                                 │                      └─ Repost via webhook (preserves user
   │                                 │                         identity); markdown link fallback if
   │                                 │                         all downloads fail
   │                                 │
   │                                 ├─ @LibrarianBot mention ──► handleRagQuery
   │                                 │                           (src/services/rag.js)
   │                                 │                           ├─ sendTyping (10s keepalive)
   │                                 │                           ├─ SearXNG search (top N results)
   │                                 │                           ├─ Target-user resolution
   │                                 │                           │   (mention / username / fuzzy)
   │                                 │                           ├─ Channel history fetch
   │                                 │                           ├─ System prompt with persona
   │                                 │                           │   quirk + numeric seed
   │                                 │                           ├─ consumeQuota(authorId)
   │                                 │                           │   (src/utils/quota.js)
   │                                 │                           └─ LLM pipeline (branched by quota):
   │                                 │                                ├─ quota OK   ─► DeepSeek first
   │                                 │                                │                  └─ on failure ─► Local Ollama (direct, no quality check)
   │                                 │                                └─ exhausted   ─► Local Ollama (direct, no quality check)
   │                                 │                                                  └─ on fail ─► help-text fallback
   │                                 │
   │                                 └─ Active campaign channel + text command
   │                                    (`!pin [id]` / `!unpin [id]`):
   │                                       DM-only (or Admin). Pins the OP or
   │                                       last message; unpins a specific or
   │                                       most-recent pinned message. Then
   │                                       deletes the command message itself.
   │
   │   ── and the OP workflow ──
   │   First non-empty message in a new active campaign channel whose
   │   topic starts with `SETUP|DM:<id>|USERS:<id,...>`:
   │       ├─ pin it
   │       ├─ react 🤖 (bot) and ✋ (player self-assign)
   │       ├─ create a role named after the channel
   │       ├─ give that role the @everyone mention override
   │       ├─ add the role to every user in USERS
   │       └─ rewrite the topic to
   │          `Active Campaign [LIBRARIAN_DATA|DM:<id>|ROLE:<id>]`
   │
    ├─ messageReactionAdd/Remove ► handleReactionAdd / handleReactionRemove
    │   (src/handlers/reactions.js)
    │       If the reaction is ✋ and 🤖 (bot) is also present on the
    │       message, toggle the campaign role (parsed from the channel
    │       topic) on the reacting member.
    │       Always delegates number-emoji / random-emoji reactions on poll
    │       messages to polls.js for live vote recounting (both `📊 ` custom
    │       polls and `📅 ` scheduling polls), then — for `📅 ` scheduling
    │       polls only — calls scheduling.js's handleSchedulingVoteChange
    │       which, when every eligible voter (campaign role + DM) has voted
    │       for the same date(s), emits a fresh Google-importable .ics
    │       whenever the confirmed set changes (lastEmittedConfirmed).
   │
   ├─ channelUpdate ───────────► handleChannelUpdate (src/handlers/channelUpdate.js)
   │   When an active campaign channel is renamed, edit the linked role's
   │   name to match (skipped when the role name already matches, to
   │   avoid feedback loops with /update-players).
   │
   ├─ channelDelete ───────────► handleChannelDelete (src/handlers/channelDelete.js)
   │   When an active or archived campaign channel is deleted, delete
   │   the linked role (or, failing that, a same-named role).
   │
   ├─ interactionCreate ──────► handleInteraction (src/handlers/interactions.js)
   │       ├─ /librarian-bot       — show help (ephemeral)
   │       ├─ /set-topic           — update topic, preserve LIBRARIAN_DATA
   │       ├─ /archive             — confirmation-typed move to ARCHIVED_CATEGORY_ID
   │       ├─ /retro-setup         — admin: pin OP, set reactions, create role
   │       │                         and append LIBRARIAN_DATA
     │       ├─ /poll-librarian      — embed poll, auto-react 1️⃣..🔟; live
     │       │                         voter names + winner/runner-up via polls.js;
     │       │                         in game channels voting restricted to the
     │       │                         channel DM + campaign-role members
      │       ├─ /schedule-poll       — DM/Admin: free-text spec (days + optional
      │       │                         per-day time + weeks) → one `📅 ` poll option per
      │       │                         weekday × week (≤9 → NUMBER_EMOJIS, >9 →
     │       │                         RANDOM_EMOJIS); unanimous campaign-role vote
     │       │                         auto-emits a Google-importable .ics
    │       ├─ /new-campaign        — public channel under ACTIVE_CATEGORY_ID
   │       ├─ /new-private-campaign — same, hidden from @everyone
   │       ├─ /new-thread          — public thread, 1-day auto-archive
   │       ├─ /new-private-thread  — private thread (DM/Admin), add mentioned users
   │       ├─ /update-players      — rename channel & role with new count
   │       ├─ /roll                — dice + (if natural 1) Ollama roast
   │       └─ /restart             — admin: re-run rebuild-run.sh via the
   │                                 mounted Docker socket
   │
   └─ RESTART_TOKEN / RESTART_CHANNEL_ID+RESTART_MESSAGE_ID env vars
     ── patched by index-librarian.js's ClientReady handler so the
         /restart ephemeral (or fallback channel) message shows a
         "✅ Restart successful!" completion timestamp; auto-deleted
         after 20s.

Cron
   │
   └─ CRON_SCHEDULE_MONTHLY_MINI (0 9 1 * * in TIMEZONE)
      Schedules a randomized 0-4h delay, then posts the monthly 3D
      printing queue to GENERAL_CHANNEL_ID, tagging SNEAKYJOE_USER_ID and
      linking to RULES_MESSAGE_ID. Idempotent guard inside the cron
      callback (target server lookup) so off-server restarts don't crash.
```

---

## 3. External Endpoints

| Endpoint (default, from `src/config.js`) | Use |
|---|---|
| `http://ollama:11434/api/generate` | Local Ollama API (`qwen2.5:7b`) — reached by container name on the shared `ollama_default` Docker network (not `localhost`, which inside the bot container is the container itself) |
| `https://api.deepseek.com/v1/chat/completions` | DeepSeek API (PRIMARY on quota, direct fallback when Ollama fails) |
| `http://searxng:8080/search` | SearXNG Search Instance (Docker container on the N150 host, on `ollama_default`; internal port 8080) |
| `eeinstagram.com`, `kkinstagram.com`, `uuinstagram.com` | Instagram fixer domains (priority order for Reel/TV; also fallback for non-Reel) |
| `/dev/dri/renderD128` (and any present `/dev/dri/card*`) | VAAPI render node on the host; auto-mounted into the container by `rebuild-run.sh` when the iGPU build arg is set. Card device is optional — ffmpeg VAAPI only needs the render node. |

> The remote NAS network transcoder (`sneakyjoe@192.168.0.100:22`) has been
> REMOVED. `src/utils/shell.js` `buildSshPrefix()`/`hasRemoteAccess()` are no-ops,
> so media compression is now local-iGPU → local-CPU only.

> **Host history:** The bot previously relied on remote network resources — a
> remote Ollama server at `192.168.0.101` and a remote NAS network-transcoder at
> `192.168.0.100`. Those were removed in two commits: `eccb3f1` *“Replace all local
> Ollama (192.168.0.101) LLM calls with DeepSeek API”* (dropped the remote Ollama
> host) and `02b466a` *“DeepSeek-primary RAG + localhost endpoints + drop NAS
> transcoder”* (dropped the NAS transcoder; media compressor → local-iGPU →
> local-CPU only; endpoints switched to `localhost`). From `02b466a` onward the
> bot runs entirely on the N150 host (DeepSeek cloud API excepted). Later
> (`6fc6b0d`) the endpoints were switched from `localhost` to the Docker container
> names (`ollama`/`searxng`) on the shared `ollama_default` network, and
> `rebuild-run.sh` attaches the bot container to that network.

Auth: `secrets_discord.php` (regex-parsed) → `$token`, `$deepseek_api_key`,
`$client_secret`, `$share_pass`. Env-var fallbacks:
`DISCORD_TOKEN`, `DEEPSEEK_API_KEY`, `SHARE_PASS`, `TRANSCODER_CONTAINER`,
`SEARXNG_URL`, `OLLAMA_URL`, `DEEPSEEK_API_URL`, `DEEPSEEK_MODEL`.

---

## 4. Video Transcoding Pipeline

Triggered when an incoming Instagram media attachment exceeds the guild's
Discord upload limit (10MB default, scales with boost tier; see
`getGuildFileLimit`). Implemented in `src/utils/mediaCompressor.js` with
detection in `src/utils/cpuDetector.js`.

Three stages, tried in order:

1. **Local iGPU (host)** — `src/utils/cpuDetector.js` reads `/proc/cpuinfo`
   for an `Intel(R) N100` / `Intel(R) N150` model name **and** checks that
   `/dev/dri/renderD128` exists. If both pass, ffmpeg runs locally with
   `h264_vaapi` and outputs MP4 directly (no TS→MP4 remux). The iGPU stage
   first tries a **bitrate-capped single pass** (`-b:v`/`-maxrate` computed
   from `targetSizeBytes/duration`) so long clips fit on the first try
   instead of climbing a 4-rung CQP ladder; if that overshoots it falls
   through to a CQP ladder `-rc_mode CQP -qp {28,32,36,40}`. `h264_vaapi` is
   used instead of `hevc_vaapi` because HEVC encode is not exposed on the
   Alpine `intel-media-driver` build for the N150 (fails instantly with
   code 234); `h264_vaapi` is universally supported on Intel iGPUs and
   Discord plays it natively. The container must be started with
   `--device /dev/dri/renderD128` and `--group-add <render_gid>` (handled
   automatically by `rebuild-run.sh` when the render node exists on the host).
   `DISCORD_FILE_LIMIT_DEFAULT=25MB` (Discord raised the free-tier upload
   limit to 25MB; was 10MB, which forced heavy over-compression).
2. **Local CPU (libx264)** — final fallback (the old NAS network transcoder
   stage at `192.168.0.100` has been REMOVED; `buildSshPrefix()`/`hasRemoteAccess()`
   are no-ops). Iterates CRF `[28, 33, 38, 44]`
   with `preset ultrafast`, scaling the LONGEST dimension to 720 (so a
   720x1280 portrait reel downscales to ~406x720 instead of staying at full
   resolution). If the whole CRF ladder overshoots (long clips), a hard
   bitrate-cap pass (`-b:v`/`-maxrate` computed from target size / duration,
   audio 64k) guarantees the output fits.

Both VAAPI stages share the `scale_vaapi` filter (factored into
`buildVaapiScaleFilter()`). Progress updates carry a `stage` field of
`'igpu' | 'local'`, mapped to human-readable labels in
`src/services/instagram.js` (`local iGPU` / `local CPU`).
The effective per-attachment size budget is `floor(guildFileLimit * 0.97)`
to leave headroom for the upload wrapper.

### Build-time VAAPI driver install

The `intel-media-driver` (iHD) + `libva-intel-driver` (legacy) + `libva-utils`
+ `mesa-va-gallium` userspace stack is **not** baked into the base image —
it adds weight that's wasted on hosts without an Intel N100/N150. The
`Dockerfile` exposes an `INSTALL_INTEL_IGPU_DRIVER` build arg
(default `0`). `rebuild-run.sh` greps the **host's** `/proc/cpuinfo` for
`N100` / `N150` and automatically passes
`--build-arg INSTALL_INTEL_IGPU_DRIVER=1` to `docker build` when matched,
so the resulting image contains the driver stack the runtime iGPU stage
needs. `FORCE_INTEL_IGPU_DRIVER=1` env override is honoured for CI/cross-
build. The runtime gate in `src/utils/cpuDetector.js` is the source of
truth: even on an image with the drivers installed, the iGPU stage is
skipped if the host doesn't expose a render node or the CPU model doesn't
match.

---

## 5. Campaign Channel State Machine

Driven entirely by the **channel topic** — there's no database.

```
[created via /new-campaign]
   topic = "SETUP|DM:<dm-id>|USERS:<id>,<id>,..."
   role  = none
   parent = ACTIVE_CATEGORY_ID
   permissions: @everyone=view (or deny for private), DM=view, bot=all,
                mentioned users=view

[first non-empty message in the channel]
   ├─ bot pins it (OP)
   ├─ bot reacts 🤖 and ✋
   ├─ bot creates a role named = channel.name
   ├─ role gets @everyone mention override
   ├─ role added to every user in USERS
   └─ topic rewritten to
      "Active Campaign [LIBRARIAN_DATA|DM:<dm-id>|ROLE:<role-id>]"

[steady state]
   - Channel renames (manual or via /update-players) auto-sync the role
   - ✋ reactions on the OP toggle the role
   - 🤖 must be present (i.e. bot reacted) for ✋ to take effect

[/archive with confirmation: "yes, I want to archive <channel-name>"]
   parent = ARCHIVED_CATEGORY_ID
   role deleted

[channel deleted (manual)]
   role deleted by handleChannelDelete

[/retro-setup (admin only)]
   back-fills pin + reactions + role + LIBRARIAN_DATA token for an
   already-populated campaign channel that predates the bot
```

`getLibrarianData(channel)` in `src/utils/helpers.js` parses the
`[LIBRARIAN_DATA|DM:<id>|ROLE:<id>]` token. The role name <-> channel name
binding is also looked up by name as a fallback (used by `channelDelete`).

---

## 6. System Help Message + Updates Thread

- **Channel:** `SYSTEM_CHANNEL_ID`. **Anchor message:** `SYSTEM_MESSAGE_ID`
  (the thread OP). If the message is missing the operator gets a warning
  and the rest of the flow is skipped — we don't auto-create a new anchor
  because we'd have to put the new id back into `config.js` manually.
- **System message (the thread OP)** body on every restart:
  ```
  Use `/librarian-bot` to see instructions for bot privately.

  📜 Updates Log: https://discord.com/channels/<guild>/<thread-id>

  *Last updated: 23 June 2026, 19:42:13*
  ```
  Per the user's spec, the system message **must not** contain any commit
  history (no `**Last N Updates:**` block, no bulleted list). It only
  carries a one-line pointer to the updates thread plus the "Last updated"
  timestamp in `TIMEZONE`. The pointer is a **plain URL**, not markdown
  `[text](url)` — Discord does not reliably render markdown-link syntax for
  internal `discord.com/channels/...` URLs (it shows the raw text), whereas
  a plain URL is always auto-linked as a clickable jump link. The actual
  updates live exclusively in the thread. Any legacy `**Last N Updates:**`
  block left in the body from an older deploy is stripped on the next
  restart by the same `systemMessage.edit(...)` call that writes the new
  content.
- **Updates thread** is auto-created on the first restart after this
  feature was deployed, name `SYSTEM_UPDATES_THREAD_NAME`
  (= `📜 Updates Log`), auto-archive `THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS`.
  **The thread contains exactly one bot message** — the bot's own
  `**Last 10 Updates:** …` post (10 = `SYSTEM_UPDATES_LIMIT`), posted
  plainly (no spoiler); on every subsequent restart that exact message is
  **edited in place** with the rolling last 10 git log entries, never
  re-posted. The thread is `locked: true` so nobody — including admins —
  can post in it; the lock is re-applied on every restart as a safety net
  (and temporarily lifted beforehand so the bot can `send()`/`edit()`
  inside the locked thread without edge-case failures). No other messages
  should ever appear in the thread.
- **Thread adoption** (in order, first match wins):
  1. **`systemMessage.thread`** — discord.js exposes the thread started on
     a message directly via this getter. This is the primary path and works
     for both regular text channels and forum-style channels where the
     post's opening message and its thread **share the same id**.
  2. **`systemMessage.startThread(...)`** — only when no thread exists yet
     (fresh anchor). `MessageExistingThread` is swallowed and we fall
     through to the remaining fallbacks.
  3. **Persisted thread id** from `data/system_state.json`, fetched by id.
  4. **Scan the channel's active threads** (`systemChannel.threads.fetchActive()`).
  5. **Scan the channel's archived public threads**
     (`systemChannel.threads.fetchArchived({ type: 'public' })`); unarchive
     on adoption.

  A candidate is validated by `isThread()` + parent **channel** id + name
  contains "Updates Log". **`ThreadChannel.parentId` is the parent CHANNEL
  id, not the starter message id** — comparing it to `systemMessage.id`
  never matches and is a trap. Do **not** reject a thread just because
  `thread.id === systemMessage.id`; that is legitimate in forum-style
  channels. The bot's updates message inside the thread is found by
  scanning `thread.messages.fetch({ limit: 20 })` for the oldest
  bot-authored, non-system message (skipping the OP and Discord's
  auto-generated "thread created" system message, both of which throw
  `DiscordAPIError 50021` if edited); if none exists, a fresh message is
  posted via `thread.send(...)`.
- **`getLastUpdates(n)`** runs
  `git log -N --reverse --pretty=format:"%as%x09%s%x09%h"` from the repo
  root and rebuilds each line in JS as `- <date>: <subject> ([<short>](url))`.
  `N` is `SYSTEM_UPDATES_LIMIT` (= 10); the helper clamps to [1, 50] for
  safety. Commit URLs use the **short hash** (GitHub redirects short
  hashes) and subjects are truncated to 80 chars so 10 entries fit
  Discord's 2000-char message limit. Falls back to a hard-coded example
  list if git fails (e.g. WORKDIR isn't a git checkout). The handler
  additionally enforces the 2000-char limit by dropping the oldest entries
  (front of the `--reverse` list, keeping the most recent) with a dynamic
  `**Last N Updates:**` header, hard-truncating only as an absolute last
  resort.
- **Persistence:** `src/utils/systemState.js` stores
  `{ systemUpdatesThreadId, systemUpdatesMessageId }` in
  `data/system_state.json` (atomic temp-file + rename, in-process write
  mutex). The pair is re-persisted at the end of every successful run, so
  the saved state is always the **last validated** pair.
- Time is formatted in `TIMEZONE` (`Europe/Tallinn` by default).
- **`getLastUpdates(n)`** runs `git log -N --reverse --pretty=format:"..."`
  from the repo root. `N` is `SYSTEM_UPDATES_LIMIT` (= 10); the helper
  clamps to [1, 50] for safety. Falls back to a hard-coded example list
  if git fails (e.g. WORKDIR isn't a git checkout).
- Time is formatted in `TIMEZONE` (`Europe/Tallinn` by default).

### Data flow per restart

```
ClientReady
  └─► fetch systemChannel
        └─► fetch systemMessage  (the anchor; if missing, warn and skip)
              │
              ├─ THREAD ADOPTION (first match wins; validate by isThread()
              │   + parent CHANNEL id + name contains "Updates Log"):
              │    1. systemMessage.thread                    (primary; works for
              │       forum-style channels where thread.id === systemMessage.id)
              │    2. systemMessage.startThread(...)           (fresh anchor only;
              │       MessageExistingThread swallowed → fall through)
              │    3. saved threadId from system_state.json    (fetch by id)
              │    4. scan systemChannel.threads.fetchActive() by name
              │    5. scan fetchArchived({ type: 'public' }) by name; unarchive
              │
              ├─ UPDATES-MESSAGE DISCOVERY (scoped to the thread):
              │    scan thread.messages.fetch({ limit: 20 }) for the oldest
              │    bot-authored, non-system message (skip the OP + the auto
              │    "thread created" system msg — editing either throws 50021);
              │    if none → thread.send(...) a fresh updates body
              │
              ├─ temporarily thread.edit({ locked: false }) if locked
              ├─ edit-in-place OR send the **Last N Updates:** body (≤ 2000 chars;
              │   drop oldest entries if too long, dynamic N in the header)
              ├─ thread.setArchived(false) if archived
              ├─ thread.edit({ locked: true })            (idempotent re-lock)
              ├─ setSystemUpdatesIds({ threadId, updatesMessageId })
              │       (re-persisted at the end so saved state is always last-validated)
              └─ systemMessage.edit(...)  with minimal body + plain thread URL
```

The adoption order guarantees that on a brand-new deploy with no state, a
manually-created thread, or an orphaned thread from a prior deploy, the bot
converges to a single locked thread with a single bot-authored updates
message and a clean minimal system message body — without ever crashing.

---

## 7. Slash Commands

All commands are registered per-guild via `REST` on every start. DM-only or
Admin-only checks use the `DM_ROLE_ID` role or `PermissionFlagsBits.Administrator`.

| Command | Who | Notes |
|---|---|---|
| `/librarian-bot` | anyone | ephemeral help text |
| `/new-campaign <name> <users>` | DM/Admin | public channel; permission scheme `ViewChannel=allow` for @everyone |
| `/new-private-campaign <name> <users>` | DM/Admin | same, but `ViewChannel=deny` for @everyone |
| `/new-thread <name>` | anyone | public thread, 1-day auto-archive |
| `/new-private-thread <users>` | DM/Admin | private thread, mentions added |
| `/archive <confirmation>` | DM/Admin | requires the exact string `yes, I want to archive <channel-name>` |
| `/retro-setup` | Admin | back-fill pin + reactions + role + LIBRARIAN_DATA for legacy channels |
| `/set-topic <text>` | DM/Admin | rewrites topic but preserves the LIBRARIAN_DATA token; trims to fit Discord's 1024-char limit |
| `/update-players <count>` | DM/Admin | renames channel AND linked role to `<name>-<newcount>` (note: Discord limits renames to 2/10min) |
| `/poll-librarian <question> <options>` | anyone | 2-10 comma-separated options, auto-reacts 1️⃣..🔟; embed is edited live to show voter mentions per option plus 🥇 winner / 🥈 runner-up; in game (active campaign) channels only the channel DM + campaign-role members may vote |
| `/schedule-poll <input>` | DM/Admin | Free-text spec `days [time] [days [time] ...] weeks` (e.g. `Wednesday Friday 4`, `Wed Fri 18:00-22:00 4`, `Wed 14:00-16:00 Fri 18:00-22:00 4`) → one `📅 ` poll option per weekday × week for the next N weeks (≤9 dates vote with 1️⃣..🔟, >9 dates switch to RANDOM_EMOJIS; cap 20 options / 10 weeks). A time token applies to all days in its preceding group; days with no time are all-day. Reuses polls.js live results + game-channel voter restriction (active channels: only channel DM + campaign-role members + admins may vote; others auto-removed). State persisted to `data/schedules.json`. In an active campaign channel, whenever every eligible voter (campaign role + DM) has voted for the same date(s) (unanimous), the bot auto-generates + posts a Google-importable `.ics` (floating local times; all-day → `VALUE=DATE`) — and re-posts a fresh `.ics` each time the confirmed set of dates changes (tracked via the `lastEmittedConfirmed` signature). Dates are computed in `TIMEZONE` via `Intl.DateTimeFormat` (no tz library). |
| `/roll <formula> [class] [context]` | anyone | dice parser; on natural 1 (d20) generates an Ollama roast with the class + context + last 10 channel messages as flavour; falls back to `FALLBACK_ROASTS[]` if Ollama is down |
| `/restart` | Admin | exec `rebuild-run.sh` via the mounted Docker socket; the ephemeral completion message is patched via `RESTART_TOKEN`/channel fallback and auto-deleted 20s later |

Text-command companions (in `handleMessageCreate`, only inside active
campaign channels):
- `!pin [messageId]` — pin a specific or the last (preceding) message
- `!unpin [messageId]` — unpin a specific or the most-recent pinned
  message (refuses to unpin the OP for non-admins). The command message
  itself is deleted in both cases.

---

## 8. Webhook Repost Identity

Instagram reposts use `sendRepostedMessage` to send via a per-channel
webhook (created on demand) so the reposted message keeps the original
author's display name + avatar. This matters because the bot deletes the
original message (so the only thing the channel sees is the reposted
attribution). The webhook sender is filtered by `wh.owner.id === client.user.id`
so foreign webhooks don't get hijacked.

`messageTracker` records every bot-sent / webhook-sent message id paired
with the triggering user so other handlers (`/roll`, `!pin`) can answer
"is this message tied to me?" by exact id without scraping content.

---

## 9. Persisted State Summary

| File | Owner | Format | Purpose |
|---|---|---|---|
| `data/quota.json` | `src/utils/quota.js` | JSON: `{ "<userSnowflake>": { regular: [ms…], admin: [ms…] } }` | Sliding-window DeepSeek quota (two tiers) |
| `data/schedules.json` | `src/utils/scheduling.js` | JSON: `{ "<pollMessageId>": { channelId, guildId, creatorId, roleId, options:[{emoji,isoDate,start,end,allDay,label}], lastEmittedConfirmed, createdAt } }` | `/schedule-poll` state: option datetimes for the unanimous-vote check + `.ics` emission on confirmed-set change (`lastEmittedConfirmed` signature) |
| `data/system_state.json` | `src/utils/systemState.js` | JSON: `{ systemUpdatesThreadId, systemUpdatesMessageId }` | Persists the system-updates thread + the bot's first-message id inside it across restarts |
| Channel topic tokens | every handler | inline string `[LIBRARIAN_DATA\|DM:<id>\|ROLE:<id>]` / `SETUP\|DM:<id>\|USERS:<id>,...` | Campaign metadata |
| In-memory `trackedMessages` | `src/utils/messageTracker.js` | capped 1000 entries | bot/webhook msg → userId |
| In-memory `mediaQueue` | `src/utils/mediaQueue.js` | JS class | single-flight Instagram downloads |
| In-memory `cachedResult` in `cpuDetector` | `src/utils/cpuDetector.js` | object | memoised iGPU detection |
| In-memory `cachedState` in `systemState` | `src/utils/systemState.js` | object | memoised thread/message id state |
| In-memory `store` in `quota` | `src/utils/quota.js` | object | memoised per-user quota buckets |

`data/quota.json`, `data/schedules.json`, and `data/system_state.json` are the
on-disk state files besides the cache. All three are written atomically (temp
file + rename) and serialised through an in-process Promise chain so
concurrent writes never clobber each other.

---

## 10. Known Runtime Quirks (worth a code reader knowing)

- `getLibrarianData()` returns `null` for channels with a `SETUP|` topic
  (i.e. before the OP is posted). The handlers that need to do work
  pre-OP must re-parse the topic manually — see `messageCreate.js`'s OP
  workflow and `interactions.js`'s `/set-topic`, `/archive`,
  `/update-players` for the duplicated regex.
- `compressVideoToFit` clamps the output bitrate ladder, but the local CPU
  CRF values `[28, 33, 38, 44]` are still hard-coded (not config-driven).
  Same for `FALLBACK_ROASTS[]` in `config.js`.
- `isHistoryOrAnalysisQuery` is a coarse keyword sniffer; it can
  false-positive on terse prompts containing "recent" or "post".
- `messageTracker` is a per-process array; a restart loses all
  associations. Handlers that depend on it (e.g. the
  `isMessageTiedToUser` heuristic) fall back to content-based heuristics
  on a miss.
- The 2-rename-per-10-minute Discord limit is a hard ceiling on
  `/update-players`; the handler does not retry.
