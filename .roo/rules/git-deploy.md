# Git protocol (read before ANY git or deploy command)

## Where you are
- This working copy under `/distr-fun/` is the ONLY place you edit and commit. It is bind-mounted from the .99 host
  (`<host mirror of this working copy>`), and a 2-way rsync timer (`sync-distr-fun`, every ~5 min, last-writer-wins by mtime,
  excludes `.git/`) mirrors the working files to the NAS share. It can REVERT a file you just committed or RESURRECT a deleted
  file as a root-owned working-tree change. A dirty file that exactly reverses a recent commit is syncer damage: restore it
  from the commit (re-write the content); never treat it as someone else's work and never build a fix on top of it.

## Rules
1. Work on a feature branch. Commit there with clear messages. Do NOT merge into `main` and do NOT push unless the task
   explicitly says "merge" / "deploy" / "push". "Implement X" means: branch + commits, then report.
2. Before any git command that changes state, run `git status --short && git branch --show-current && git log --oneline -3`
   and state in one sentence what you see. If the tree shows files you did not touch, apply the syncer-damage check above.
3. Never force-push. Never rewrite history. Never `rm -rf` anything. Never `git checkout --` / `git stash` / `reset --hard` on host trees.
4. If a deploy step looks different from the recipe below, STOP and report instead of improvising.

## Keep a work ledger
At the start of every reply after a git/deploy action, keep one line up to date and repeat it verbatim:
`STATE: branch=<name> commits=<short shas> pushed=<yes/no> deployed=<yes/no/sha> verified=<yes/no>`
This line is what survives context condensation — never drop it.

## Deploy recipe (ONLY when asked to deploy)
1. Merge the feature branch into `main` (`--no-ff`) here and `git push origin main`.
2. Wait until the build tree has the new working files (grep a marker string in
   `<build tree on the n150 host>/<file>` over ssh; the share hop takes up to ~5 min + 30 s).
3. Advance the build tree's HEAD without touching files, in ONE ssh call as the deploy user on <n150 host>:
   `git -C <build tree on the n150 host> fetch origin main && git -C <build tree on the n150 host> reset --soft origin/main && git -C <build tree on the n150 host> reset`
   The librarian has NO rebuild watcher: after the reset run `sudo ./rebuild-run.sh` in <build tree on the n150 host> (or use the bot /restart command). Do NOT advance HEAD before the files landed (it would bake old content).
4. Verify: `docker exec librarian-bot cat /usr/src/app/git-info.json` shows the new commit, and grep the baked file inside the container.
5. Stop. If anything in steps 2-4 looks different from this description, report it instead of improvising.
