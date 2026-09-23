#!/bin/sh
# Auto-generate git-info.json
#
# Bakes BOTH:
#   - the single last commit (hash/author/message/date) for the startup
#     "Bot updated!" message, AND
#   - a `history` array of the last month of commits (hash/author/message/date)
#     so the bot can populate the "Latest Updates" thread message from a
#     baked file. The bot prefers this file over a live `git log` — on the
#     production host the deployment directory is SMB-synced and its .git
#     state is not guaranteed to be fresh, whereas this file is regenerated
#     by rebuild-run.sh from exactly the commit being deployed.
#
# This script is called by rebuild-run.sh (step 3/6) on every deploy, and can
# be run standalone (`sh ./generate-git-info.sh`) whenever a fresh bake is
# needed. It is safe to run as root: it drops to the repository owner for the
# git calls when possible.

# Helper function to run git commands as the repository owner when executed under sudo/root
#
# Dropping to the owner is a best-effort step, NOT a requirement: it only exists
# so root-run git doesn't trip over "dubious ownership". When it can't be done
# the command still has to run, because a failed run_git silently bakes
# "unknown" into git-info.json and the bot then reports an unknown version.
# Two ways it could not be done:
#   - the owner's uid has no passwd entry, so `stat -c %U` prints a bare uid or
#     "UNKNOWN" and `sudo -u` rejects it (the dev container mounts this repo as
#     uid 1000, which doesn't exist inside the image);
#   - sudo isn't installed, or refuses non-interactively.
# In both cases root registers safe.directory and runs git directly instead.
run_git() {
    if [ "$(id -u)" -eq 0 ]; then
        local owner
        owner=$(stat -c '%U' . 2>/dev/null)
        # Add the directory to root's safe.directory config to prevent "dubious
        # ownership" git errors — needed for the direct-git fallback below too,
        # so it is registered regardless of whether the drop to $owner works.
        if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "$(pwd)" 2>/dev/null; then
            git config --global --add safe.directory "$(pwd)" 2>/dev/null || true
        fi
        if [ -n "$owner" ] && [ "$owner" != "root" ] && [ "$owner" != "UNKNOWN" ] \
            && id "$owner" >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
            local out
            if out=$(sudo -H -u "$owner" git "$@" 2>/dev/null); then
                printf '%s' "$out"
                return 0
            fi
            # sudo/git failed as the owner — fall through and try as root.
        fi
    fi
    git "$@"
}

hash=$(run_git log -1 --pretty=format:"%h" 2>/dev/null || echo "unknown")
author=$(run_git log -1 --pretty=format:"%an" 2>/dev/null || echo "unknown")
message=$(run_git log -1 --pretty=format:"%s" 2>/dev/null || echo "unknown")
date=$(run_git log -1 --pretty=format:"%cr" 2>/dev/null || echo "unknown")
generatedAt=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")

# Escape backslashes and double quotes for JSON safety
escape_json() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

author=$(escape_json "$author")
message=$(escape_json "$message")

# Build the history array: last 30 days of commits.
# Fields separated by TAB (%x09), one commit per line.
# Format: <hash>\t<author>\t<YYYY-MM-DD>\t<message>
history_raw=$(run_git log --since="1 month ago" --pretty=format:"%h%x09%an%x09%ad%x09%s" --date=short 2>/dev/null || echo "")

history_json=""
if [ -n "$history_raw" ]; then
    printf '%s\n' "$history_raw" | while IFS="$(printf '\t')" read -r h a d m; do
        [ -z "$h" ] && continue
        h=$(escape_json "$h")
        a=$(escape_json "$a")
        d=$(escape_json "$d")
        m=$(escape_json "$m")
        printf '    { "hash": "%s", "author": "%s", "date": "%s", "message": "%s" },\n' "$h" "$a" "$d" "$m"
    done > /tmp/git_history_entries_$$
    # Strip the trailing comma on the last entry for valid JSON.
    if [ -s /tmp/git_history_entries_$$ ]; then
        # Remove trailing ",\n" from the last line.
        history_json=$(sed -e '$ s/,$//' /tmp/git_history_entries_$$)
    fi
    rm -f /tmp/git_history_entries_$$
fi

rm -f git-info.json
cat <<EOF > git-info.json
{
  "hash": "$hash",
  "author": "$author",
  "message": "$message",
  "date": "$date",
  "generatedAt": "$generatedAt",
  "history": [
$history_json
  ]
}
EOF
echo "[Git Info] Generated git-info.json successfully."
