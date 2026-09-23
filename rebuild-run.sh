#!/bin/sh
# =============================================================================
# rebuild-run.sh — librarian-bot one-command deploy
#
# A six-step pipeline. Each step logs exactly one greppable status line
# ("[deploy N/6] ..."), and every run ends with one verdict line:
#
#   DEPLOY OK    commit=<short-hash> image=sha256:<id>
#   DEPLOY FAILED step=<n> reason=<short reason>
#
# Exit code is 0 on DEPLOY OK and 1 on DEPLOY FAILED. Run it from any
# directory, with or without sudo — the script cds to its own directory
# and escalates to passwordless sudo itself when it is not already root:
#
#   git clone https://github.com/sneakyjoeru/ttrpg-librarian-bot.git
#   cd ttrpg-librarian-bot
#   ./rebuild-run.sh            # or: sudo ./rebuild-run.sh
#
#   1/6 env     docker present, passwordless sudo usable (when invoked
#               without it), iGPU render node detected for VAAPI
#   2/6 git     fetch origin + reset the deploy tree to the pushed state.
#               The build tree is normally SMB-synced from the dev machine,
#               so its .git can be stale or root-owned; aligning it with
#               origin here is what guarantees the baked commit is the commit
#               you pushed. Use --local to build the tree exactly as it sits
#               on disk instead (fresh clones, offline hosts, local edits).
#   3/6 bake    git-info.json regenerated from the deployed commit via
#               generate-git-info.sh (last commit + 30-day history). This is
#               the authoritative source of the "Latest Updates" thread
#               message: it always names the exact code the bot is running.
#   4/6 build   docker image (the old container keeps running meanwhile —
#               a failed build never takes the bot down)
#   5/6 swap    stop old container, start the new one (only after a
#               successful build)
#   6/6 verify  container running, baked commit in the container matches the
#               deployed commit, "Online as Librarian-Bot" in the logs
#
# Flags:
#   (none)     full deploy — git sync, bake, build, swap, verify
#   --local    skip the git sync; build the tree as-is on disk
#   --status   read-only report: tree vs origin, container state, lock,
#              rebuild timestamp. Takes no lock, changes nothing.
#   --help
#
# Reliability invariants (each came from a real outage — see README):
#   - the old container is stopped only after a successful docker build
#     (the old &&/|| chain could redeploy a stale image on a failed build)
#   - a lock file (rebuild.lock) carries the owning PID; a new run takes
#     over from a dead PID and preempts a live one (supersede semantics)
#   - rebuild_time.txt is always written fresh at deploy start, so the bot's
#     catch-up window covers exactly the real downtime and never an ancient
#     timestamp resurrected by the SMB sync
#   - all git calls are non-interactive (GIT_TERMINAL_PROMPT=0) and the
#     fetch is timed out, so a dead network fails this step fast
#   - the whole directory (including .git) is bind-mounted into the
#     container, so the baked git-info.json is visible in it at
#     /usr/src/app/git-info.json — the standard verification probe
# =============================================================================

stty onlcr 2>/dev/null || true
cd "$(dirname "$0")" || exit 1

# --- arguments ---------------------------------------------------------------
MODE="deploy"
LOCAL_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --local)   LOCAL_ONLY=true ;;
        --status)  MODE="status" ;;
        --help|-h)
            echo "Usage: rebuild-run.sh [--local | --status | --help]"
            echo "  (no flags)  full deploy: git sync, bake, build, swap, verify"
            echo "  --local     build the tree as-is on disk (no git sync)"
            echo "  --status    read-only state report (tree, container, lock)"
            exit 0 ;;
        *) echo "Unknown argument: $arg (try --help)" >&2; exit 2 ;;
    esac
done

# --- state for the exit verdict ----------------------------------------------
DEPLOY_STEP=0
FAIL_REASON=""
DEPLOYED_COMMIT=""
IMAGE_ID=""
VERDICT_EMITTED=false
on_exit() {
    [ "$MODE" = "deploy" ] || return 0
    if [ "$VERDICT_EMITTED" = "true" ]; then return 0; fi
    if [ -n "$DEPLOYED_COMMIT" ]; then
        echo "DEPLOY FAILED step=${DEPLOY_STEP:-?} reason=${FAIL_REASON:-unspecified (exit $?)}"
    else
        echo "DEPLOY FAILED step=${DEPLOY_STEP:-bootstrap} reason=${FAIL_REASON:-unspecified (exit $?)}"
    fi
}
trap on_exit EXIT
fail() { DEPLOY_STEP=${1:-$DEPLOY_STEP}; FAIL_REASON="$2"; exit 1; }

# --- --status: read-only, no lock, no changes --------------------------------
if [ "$MODE" = "status" ]; then
    STATUS_SUDO=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        STATUS_SUDO="sudo -n"
    fi
    BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
    LOCAL=$(git log -1 --format="%h %s" 2>/dev/null || echo "no git repo")
    ORIGIN_HEAD=$(git log -1 --format="%h" "origin/$BR" 2>/dev/null || echo "(not fetched)")
    echo "STATUS bot=librarian-bot"
    echo "STATUS branch=$BR local=$LOCAL"
    echo "STATUS origin/$BR=$ORIGIN_HEAD"
    if [ -f git-info.json ]; then
        BAKED=$(grep -o '"hash": *"[^"]*"' git-info.json 2>/dev/null | head -1 | sed 's/.*"hash": *"\([^"]*\)".*/\1/')
        echo "STATUS baked-git-info=${BAKED:-unknown}"
    else
        echo "STATUS baked-git-info=(absent)"
    fi
    if [ -f rebuild_time.txt ]; then
        echo "STATUS rebuild_time=$(cat rebuild_time.txt 2>/dev/null)"
    else
        echo "STATUS rebuild_time=(absent)"
    fi
    if [ -f rebuild.lock ]; then
        LPID=$(cat rebuild.lock 2>/dev/null)
        if kill -0 "$LPID" 2>/dev/null; then
            echo "STATUS lock=ACTIVE (pid $LPID) — a rebuild is running"
        else
            echo "STATUS lock=STALE (pid $LPID dead) — next run will take it over"
        fi
    else
        echo "STATUS lock=free"
    fi
    CONTAINER=$($STATUS_SUDO docker inspect -f '{{.State.Status}} (restarts={{.RestartCount}}, started={{.State.StartedAt}})' librarian-bot 2>/dev/null)
    if [ -n "$CONTAINER" ]; then
        RUNNING_COMMIT=$($STATUS_SUDO docker exec librarian-bot sh -c "grep -o '\"hash\": *\"[^\"]*\"' git-info.json 2>/dev/null | head -1" | sed 's/.*"\([0-9a-f]*\)".*/\1/')
        echo "STATUS container=librarian-bot $CONTAINER"
        echo "STATUS running-commit=${RUNNING_COMMIT:-unknown}"
    else
        echo "STATUS container=librarian-bot (not present)"
    fi
    exit 0
fi

# --- 1/6 environment ----------------------------------------------------------
DEPLOY_STEP=1
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        SUDO="sudo -n"
    else
        fail 1 "passwordless sudo is required (or run with sudo). The bot owner needs NOPASSWD sudo for docker."
    fi
fi
if ! command -v git >/dev/null 2>&1; then
    fail 1 "git not found"
fi

# Restore correct ownership of repository files: the SMB watcher rsyncs
# files in as root, and Docker build (COPY . .) re-owns .git; both break
# later git operations. Fixing ownership up front is the reliable move.
if [ "$(id -u)" -eq 0 ]; then
    owner=$(stat -c '%U' . 2>/dev/null)
    if [ -n "$owner" ] && [ "$owner" != "root" ]; then
        chown -R "$owner:$owner" . 2>/dev/null || true
    fi
    if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "$(pwd)" 2>/dev/null; then
        git config --global --add safe.directory "$(pwd)" 2>/dev/null || true
    fi
fi

# Mount the Discord/Instagram cookie files into the container.
cookies_mount=""
if [ -f "cookies.txt" ]; then
    cookies_mount="-v $(pwd)/cookies.txt:/usr/src/app/cookies.txt"
elif [ -f "instagram-cookies.txt" ]; then
    cookies_mount="-v $(pwd)/instagram-cookies.txt:/usr/src/app/instagram-cookies.txt"
elif [ -f "../robot-joe-dev/discord-joe/cookies.txt" ]; then
    # Fall back to the sibling discord-joe bot's cookies (same Instagram account).
    # Mount to /tmp/cookies.txt (NOT /usr/src/app/cookies.txt) because /usr/src/app
    # is already a bind mount of the repo dir, and Docker can shadow a file mount
    # on top of a directory mount. /tmp/cookies.txt is in INSTAGRAM_COOKIE_PATHS.
    cookies_mount="-v $(pwd)/../robot-joe-dev/discord-joe/cookies.txt:/tmp/cookies.txt"
elif [ -f "../robot-joe-dev/discord-joe/instagram-cookies.txt" ]; then
    cookies_mount="-v $(pwd)/../robot-joe-dev/discord-joe/instagram-cookies.txt:/tmp/instagram-cookies.txt"
elif [ -f "../robot-joe/cookies.txt" ]; then
    # Legacy fallback for older deployments where the sibling dir was named robot-joe.
    cookies_mount="-v $(pwd)/../robot-joe/cookies.txt:/tmp/cookies.txt"
elif [ -f "../robot-joe/instagram-cookies.txt" ]; then
    cookies_mount="-v $(pwd)/../robot-joe/instagram-cookies.txt:/tmp/instagram-cookies.txt"
fi

# Mount the bot's own SSH key (it SSHs to the host for maintenance).
ssh_key_mount=""
if [ -f "id_rsa" ]; then
    ssh_key_mount="-v $(pwd)/id_rsa:/usr/src/app/id_rsa"
elif [ -f "id_ed25519" ]; then
    ssh_key_mount="-v $(pwd)/id_ed25519:/usr/src/app/id_ed25519"
elif [ -f "id_ed25519_bot" ]; then
    ssh_key_mount="-v $(pwd)/id_ed25519_bot:/usr/src/app/id_rsa"
elif [ -f "../id_rsa" ]; then
    ssh_key_mount="-v $(pwd)/../id_rsa:/usr/src/app/id_rsa"
elif [ -f "../id_ed25519" ]; then
    ssh_key_mount="-v $(pwd)/../id_ed25519:/usr/src/app/id_ed25519"
elif [ -f "../id_ed25519_bot" ]; then
    ssh_key_mount="-v $(pwd)/../id_ed25519_bot:/usr/src/app/id_rsa"
fi

# Mount the host's /dev/dri (Intel iGPU render node) into the container if
# it exists, so the local VAAPI transcoding stage can run on supported Intel
# SoCs (N100 / N150). Skipped automatically on hosts without an Intel iGPU.
igpu_mount=""
igpu_card_devices=""
if [ -e "/dev/dri/renderD128" ]; then
    for card_dev in /dev/dri/card0 /dev/dri/card1; do
        if [ -e "${card_dev}" ]; then
            igpu_card_devices="${igpu_card_devices} --device ${card_dev}"
        fi
    done
    igpu_render_gid="$(stat -c '%g' /dev/dri/renderD128 2>/dev/null || echo 109)"
    igpu_mount="--device /dev/dri/renderD128${igpu_card_devices} --group-add ${igpu_render_gid}"
    echo "[deploy 1/6] env ok — iGPU render node present (render gid ${igpu_render_gid}), mounting into container"
else
    echo "[deploy 1/6] env ok — no /dev/dri/renderD128 on host; VAAPI transcoding will use CPU"
fi

# Detect Intel N100 / N150 on the host and tell the Dockerfile to install
# the iHD VAAPI driver stack. When the host CPU doesn't match, the driver
# is NOT installed and the local iGPU stage is skipped at runtime by
# src/utils/cpuDetector.js — keeps the image lean on hosts that don't need it.
igpu_build_arg=""
host_cpu_model="$(grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | sed 's/^model name\s*:\s*//')"
if [ "${FORCE_INTEL_IGPU_DRIVER:-0}" = "1" ]; then
    igpu_build_arg="--build-arg INSTALL_INTEL_IGPU_DRIVER=1"
    echo "[deploy 1/6] FORCE_INTEL_IGPU_DRIVER=1 — installing iGPU VAAPI driver in the image"
elif echo "${host_cpu_model}" | grep -Eqi '\bN(100|150)\b'; then
    igpu_build_arg="--build-arg INSTALL_INTEL_IGPU_DRIVER=1"
    echo "[deploy 1/6] host CPU '${host_cpu_model}' (N100/N150) — installing iGPU VAAPI driver in the image"
else
    echo "[deploy 1/6] host CPU '${host_cpu_model:-unknown}' not in iGPU list — skipping driver install"
fi

# --- lock: one rebuild at a time ---------------------------------------------
# Carries our PID; a run whose lock belongs to a dead process removes it and
# proceeds, and a run whose lock is held by a live process preempts it (a
# newer rebuild supersedes an older one).
LOCKFILE="rebuild.lock"
acquire_lock() {
    while true; do
        if (set -o noclobber; echo "$$" > "$LOCKFILE") 2>/dev/null; then
            return 0
        fi
        LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null)
        if [ -z "$LOCK_PID" ]; then
            rm -f "$LOCKFILE" 2>/dev/null
            sleep 1
            continue
        fi
        if [ "$LOCK_PID" -eq "$$" ] 2>/dev/null; then
            rm -f "$LOCKFILE" 2>/dev/null
            continue
        fi
        if kill -0 "$LOCK_PID" 2>/dev/null; then
            echo "[deploy] Lock held by live process $LOCK_PID — taking over."
            kill "$LOCK_PID" 2>/dev/null
            sleep 1
            if kill -0 "$LOCK_PID" 2>/dev/null; then
                kill -9 "$LOCK_PID" 2>/dev/null
                sleep 1
            fi
            rm -f "$LOCKFILE" 2>/dev/null
            continue
        fi
        echo "[deploy] Stale lock (pid $LOCK_PID dead) — removing."
        rm -f "$LOCKFILE" 2>/dev/null
        continue
    done
}
acquire_lock
trap 'rm -f "$LOCKFILE"' EXIT
trap 'exit 1' INT TERM

# Mark the rebuild start (catch-up window) before anything changes.
# Written fresh on every deploy so the bot's catch-up covers exactly this
# downtime — never a stale timestamp resurrected by the SMB sync.
date -u +"%Y-%m-%dT%H:%M:%SZ" > rebuild_time.txt

# Notify the running container that a rebuild is starting (SIGUSR2 → the bot
# sets its Discord presence to "Upgrading...").
$SUDO docker kill --signal=SIGUSR2 librarian-bot 2>/dev/null || true

# Clean any old progress file inside the container
$SUDO docker exec librarian-bot rm -f /usr/src/app/build_progress.txt 2>/dev/null || true

# Git helper: run as the repository owner when we are root, so .git state
# (and any files git writes) stay owner-owned instead of root-owned.
run_git() {
    if [ "$(id -u)" -eq 0 ]; then
        owner=$(stat -c '%U' . 2>/dev/null)
        if [ -n "$owner" ] && [ "$owner" != "root" ] && [ "$owner" != "UNKNOWN" ] \
            && id "$owner" >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
            sudo -H -u "$owner" git "$@"
            return $?
        fi
    fi
    git "$@"
}

# --- 2/6 git sync -------------------------------------------------------------
# Align the deploy tree with the pushed state before baking/building, so
# "the commit in the image" == "the commit pushed". Non-interactive + timed
# fetch: a dead network must fail this step fast, not hang the deploy.
DEPLOY_STEP=2
BRANCH=$(run_git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
if [ "$LOCAL_ONLY" = "true" ]; then
    DEPLOYED_COMMIT=$(run_git rev-parse --short HEAD 2>/dev/null || echo unknown)
    echo "[deploy 2/6] git sync: SKIPPED (--local) — building tree at $DEPLOYED_COMMIT ($BRANCH)"
else
    if ! run_git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        DEPLOYED_COMMIT=$(run_git rev-parse --short HEAD 2>/dev/null || echo unknown)
        echo "[deploy 2/6] git sync: no git repo here — building tree as-is (like --local)"
    else
        FETCH_OK=true
        if run_git remote get-url origin >/dev/null 2>&1; then
            if ! timeout 60 run_git fetch origin "$BRANCH" 2>build_fetch.log; then
                FETCH_OK=false
                echo "[deploy 2/6] WARNING: git fetch origin $BRANCH failed — building the current local HEAD."
                sed 's/^/[deploy 2/6]   /' build_fetch.log 2>/dev/null | tail -3
            fi
        else
            echo "[deploy 2/6] git sync: no origin remote — building tree as-is"
        fi
        if [ "$FETCH_OK" = "true" ]; then
            LOCAL_HEAD=$(run_git rev-parse HEAD 2>/dev/null)
            ORIGIN_HEAD=$(run_git rev-parse "origin/$BRANCH" 2>/dev/null)
            if [ -n "$LOCAL_HEAD" ] && [ -n "$ORIGIN_HEAD" ] && [ "$LOCAL_HEAD" != "$ORIGIN_HEAD" ]; then
                echo "[deploy 2/6] git sync: $BRANCH $(run_git rev-parse --short HEAD) -> $(run_git rev-parse --short "$ORIGIN_HEAD") — resetting to origin/$BRANCH."
                run_git reset --hard "origin/$BRANCH" >/dev/null 2>&1 || fail 2 "git reset --hard origin/$BRANCH failed"
            fi
        fi
        DEPLOYED_COMMIT=$(run_git rev-parse --short HEAD 2>/dev/null || echo unknown)
        if [ "$DEPLOYED_COMMIT" = "unknown" ]; then
            fail 2 "cannot determine HEAD (empty repo?)"
        fi
        if [ "$FETCH_OK" = "true" ]; then
            echo "[deploy 2/6] git sync: on $BRANCH at $DEPLOYED_COMMIT (origin aligned)"
        fi
    fi
fi
ORIGIN_SHORT=$(run_git rev-parse --short "origin/$BRANCH" 2>/dev/null || echo "?")
if [ -n "$DEPLOYED_COMMIT" ] && [ "$DEPLOYED_COMMIT" != "?" ] && [ "$ORIGIN_SHORT" != "?" ] && [ "$DEPLOYED_COMMIT" != "$ORIGIN_SHORT" ]; then
    echo "[deploy 2/6] NOTE: local $DEPLOYED_COMMIT != origin/$BRANCH $ORIGIN_SHORT — verify the tree is in the expected state."
fi

# --- 3/6 bake git-info.json ---------------------------------------------------
# The "Latest Updates" thread message is built from this file. Regenerated
# on every rebuild from the deployed commit (full file: last commit +
# 30-day history) so the thread always names the exact code that is running.
DEPLOY_STEP=3
BAKE_OK=false
if [ -f generate-git-info.sh ] && sh ./generate-git-info.sh >/dev/null 2>&1; then
    if grep -q '"history"' git-info.json 2>/dev/null; then
        BAKED=$(grep -o '"hash": *"[^"]*"' git-info.json | head -1 | sed 's/.*"hash": *"\([^"]*\)".*/\1/')
        HISTORY_COUNT=$(( $(grep -c '"hash"' git-info.json) - 1 ))
        [ -n "$BAKED" ] && [ "$BAKED" != "unknown" ] && BAKE_OK=true
    fi
fi
if [ "$BAKE_OK" = "true" ]; then
    echo "[deploy 3/6] baked git-info.json commit=${BAKED:-?} (history: ${HISTORY_COUNT:-0} commits)"
else
    hash=$(run_git log -1 --pretty=format:"%h" 2>/dev/null || echo "unknown")
    author=$(run_git log -1 --pretty=format:"%an" 2>/dev/null || echo "unknown")
    message=$(run_git log -1 --pretty=format:"%s" 2>/dev/null || echo "unknown")
    date_rel=$(run_git log -1 --pretty=format:"%cr" 2>/dev/null || echo "unknown")
    generatedAt=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    author=$(esc "$author"); message=$(esc "$message")
    rm -f git-info.json
    cat <<EOF > git-info.json
{
  "hash": "$hash",
  "author": "$author",
  "message": "$message",
  "date": "$date_rel",
  "generatedAt": "$generatedAt"
}
EOF
    echo "[deploy 3/6] baked git-info.json commit=$hash (fallback: last commit only)"
fi

# --- 4/6 docker build ---------------------------------------------------------
# Build FIRST, old container untouched until success. A build failure exits
# here and the running bot keeps its current image.
DEPLOY_STEP=4
echo "[deploy 4/6] docker build started"
BUILDX_GIT_INFO=false $SUDO docker build ${igpu_build_arg} -t discord-librarian-bot . 2>build.log
BUILD_RC=$?
if [ $BUILD_RC -ne 0 ]; then
    LAST_LOG=$(tail -n 3 build.log 2>/dev/null | tr '\n' ' ' | cut -c1-200)
    echo "[deploy 4/6] docker build FAILED (exit $BUILD_RC): ${LAST_LOG:-no log}"
    fail 4 "docker build failed (exit $BUILD_RC): ${LAST_LOG:-no log}"
fi
# Fix .git ownership: Docker (root) changes .git ownership during the build
# (COPY . .), which breaks the next fetch/reset. Restore it before the swap.
$SUDO bash -c '
    local_owner="$(stat -c "%U" . 2>/dev/null)"
    local_group="$(stat -c "%G" . 2>/dev/null)"
    if [ -n "$local_owner" ] && [ "$local_owner" != "root" ]; then
        chown -R "$local_owner:$local_group" .git 2>/dev/null || true
    fi
'
echo "[deploy 4/6] build done"

# --- 5/6 swap containers -------------------------------------------------------
DEPLOY_STEP=5
echo "[deploy 5/6] stopping old container librarian-bot"
$SUDO docker stop librarian-bot 2>/dev/null || true
$SUDO docker rm librarian-bot 2>/dev/null || true

# Attach the bot to the shared ollama_default network (when present) so it can
# resolve the Ollama and SearXNG containers by name (ollama / searxng). localhost
# inside the container refers to the container itself and cannot reach host services.
ollama_network_args=""
if $SUDO docker network inspect ollama_default >/dev/null 2>&1; then
    ollama_network_args="--network ollama_default"
fi

# One-time extended catch-up: if CATCHUP_EXTENDED_HOURS is set in the
# environment, pass it through to the container so the bot runs an extended
# catch-up scan on boot (covers links posted during long outages >6h).
catchup_env=""
if [ -n "${CATCHUP_EXTENDED_HOURS:-}" ]; then
    catchup_env="-e CATCHUP_EXTENDED_HOURS=${CATCHUP_EXTENDED_HOURS}"
    echo "[deploy 5/6] CATCHUP_EXTENDED_HOURS=${CATCHUP_EXTENDED_HOURS} — extended catch-up on boot"
fi

echo "[deploy 5/6] starting new container"
$SUDO docker run -d --name librarian-bot --restart unless-stopped $ollama_network_args \
    -e SHARE_PASS -e HOST_PATH="$(pwd)" \
    -e TRANSCODER_CONTAINER \
    -e BROWSER_BOT_WS="${BROWSER_BOT_WS:-ws://browser-bot:3000}" \
    -e STREAMER_JOE_API_URL="${STREAMER_JOE_API_URL:-http://192.168.0.99:8777}" \
    -e DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-flash}" \
    $catchup_env \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$(pwd)":/usr/src/app \
    -v /usr/src/app/node_modules \
    $cookies_mount $ssh_key_mount $igpu_mount \
    discord-librarian-bot
RUN_RC=$?
if [ $RUN_RC -ne 0 ]; then
    fail 5 "docker run failed (exit $RUN_RC)"
fi
IMAGE_ID=$($SUDO docker image inspect --format '{{.Id}}' discord-librarian-bot 2>/dev/null || echo "?")

# --- 6/6 verify -----------------------------------------------------------------
DEPLOY_STEP=6
sleep 15
STATE=$($SUDO docker inspect -f '{{.State.Status}}' librarian-bot 2>/dev/null)
EXIT_CODE=$($SUDO docker inspect -f '{{.State.ExitCode}}' librarian-bot 2>/dev/null)
RESTARTS=$($SUDO docker inspect -f '{{.RestartCount}}' librarian-bot 2>/dev/null)
if [ "$STATE" != "running" ]; then
    LAST_LOG=$($SUDO docker logs --tail 5 librarian-bot 2>&1 | tr '\n' ' ' | cut -c1-200)
    fail 6 "container not running (state=$STATE exit=$EXIT_CODE): ${LAST_LOG:-no logs}"
fi
# The baked file is bind-mounted into the container — it must name the
# commit we just deployed.
RUNNING_COMMIT=$($SUDO docker exec librarian-bot sh -c "grep -o '\"hash\": *\"[^\"]*\"' git-info.json 2>/dev/null | head -1" | sed 's/.*"\([0-9a-f]*\)".*/\1/')
if [ -n "$RUNNING_COMMIT" ] && [ "$RUNNING_COMMIT" != "$DEPLOYED_COMMIT" ]; then
    fail 6 "commit mismatch: container has $RUNNING_COMMIT, deployed $DEPLOYED_COMMIT"
fi
# Ready signal: the bot prints the 🏁 "Online as Librarian-Bot" banner once
# the Discord gateway connection is up. Give late bootstrapping a short
# second look before we settle for "not seen yet".
READY=""
if $SUDO docker logs --tail 200 librarian-bot 2>&1 | grep -q "Online as Librarian-Bot"; then
    READY="ready signal seen"
else
    sleep 20
    if $SUDO docker logs --tail 200 librarian-bot 2>&1 | grep -q "Online as Librarian-Bot"; then
        READY="ready signal seen"
    else
        READY="no ready signal yet (check: docker logs librarian-bot)"
    fi
fi
echo "[deploy 6/6] verified: container running (restarts=$RESTARTS), baked commit=${RUNNING_COMMIT:-$DEPLOYED_COMMIT}, $READY"
echo "DEPLOY OK commit=$DEPLOYED_COMMIT image=$IMAGE_ID"
VERDICT_EMITTED=true

# --- STALE-CODE GUARD (after the verdict, background) ---------------------------
# The SMB watcher rsyncs the NAS working copy into this deploy dir every
# ~60s. Because the bot bind-mounts /usr/src/app from this dir, Node can load
# one version of a file at boot while the watcher rewrites files on disk
# milliseconds later (recreating them as root) — leaving the RUNNING process
# on stale code even though disk == git HEAD. This happened on 2026-09-07:
# a mid-edit intermediate version of interactions.js was loaded at boot; the
# fix landed on disk 86s later; the bot then crashed every /campaign-members
# add until restarted. Mitigation: record the boot-time checksums of all
# source files, then verify AFTER the watcher's next poll window(s). If any
# file no longer matches what the process loaded, print a LOUD warning telling
# the operator to restart the container (a plain docker restart reloads the
# fixed code — no image rebuild needed).
boot_stamp="$(date +%s)"
boot_dir="$(pwd)"
boot_manifest="$(mktemp)"
find src tests -type f \( -name '*.js' -o -name '*.json' \) -exec md5sum {} + 2>/dev/null | sort > "$boot_manifest" || true
(
    for delay in 130 600; do
        sleep "$delay"
        cd "$boot_dir" || exit 0
        now_manifest="$(mktemp)"
        find src tests -type f \( -name '*.js' -o -name '*.json' \) -exec md5sum {} + 2>/dev/null | sort > "$now_manifest" || true
        if ! diff -q "$boot_manifest" "$now_manifest" >/dev/null 2>&1; then
            changed="$(diff "$boot_manifest" "$now_manifest" | grep '^>' | awk '{print $2}' | head -8 | tr '\n' ' ')"
            echo "⚠️  [rebuild-run][STALE-CODE WARNING] Files changed on disk AFTER the bot booted: ${changed}"
            echo "⚠️  The running bot process is now on STALE code (smb-watcher rsync or manual edit)."
            echo "⚠️  Run: docker restart librarian-bot   (no rebuild needed — disk code is what will load)"
            rm -f "$boot_manifest" "$now_manifest"
            exit 0
        fi
        rm -f "$now_manifest"
    done
    rm -f "$boot_manifest"
) &
echo "[rebuild-run] Stale-code guard armed (checks at +130s and +10min after boot)."
# Dump the boot logs — for a human at the terminal this is where a misbehaving
# container shows its first error lines.
$SUDO docker logs --tail 60 librarian-bot 2>&1 | tail -60
exit 0
