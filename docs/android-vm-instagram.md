# Instagram media through an Android VM (last-resort fallback)

When every normal downloader (yt-dlp, cobalt, scrapers, the direct GraphQL scrape, the
InstaFix-style mirrors) gets only a reel's cover image, the bot used to post
**"Video is unavailable for embedding."** With this fallback it asks an Android VM that runs
the real Instagram app for the media instead. The post then carries the real video (or the
image) and the line `-# 🛠 processed using a dirty hack`.

It is optional and off by default: without the three `IG_VM_*` variables the bot behaves
exactly as before.

## How it works

```
Discord link ──► bot cascade (yt-dlp / cobalt / scrapers / direct / mirrors)
                    │ only the cover came back
                    ▼
        src/services/igVmClient.js  ── POST /fetch {url, guild_id}  (Bearer token)
                    ▼
        tools/android-vm/ig-vm-service.py   (HTTP, one job at a time, caps + pacing)
                    ▼
        tools/android-vm/ig-fetch.py  ── adb ──► Android VM, Instagram app logged in
            1. deep-link the post into the app (am start -a VIEW …)
            2. reel/video: read the app's ExoPlayer cache (<mediaId>_*.exo) and remux it with ffmpeg
               (a "video" that is really a still image is returned as a PNG)
            3. photo post: copy the largest cached original from images.stash → JPG
                    ▼
        bytes back to the bot (X-Kind: video|image) → edited into the Discord post
```

No taps or swipes are scripted; the app is only opened through deep links, and the
service spaces app sessions randomly (45-120 s), caps them at 10/hour and 40/day, and
caches every result for 7 days so a repeated link never touches the app.

## What you need

| item | used here |
|---|---|
| Linux host with KVM | Intel N150, Debian, `qemu-system-x86_64`, `adb`, `ffmpeg`, Python 3 + Pillow |
| Android x86 image | BlissOS 15.9.2 (Android 12, x86_64) with the **libhoudini** ARM bridge |
| Instagram app | the stock arm64 APK (435.0.0.37.76 works; patched "Piko" builds crash libhoudini) |
| an Instagram account | a dedicated one, logged in inside the VM (expect a selfie/ID check on first login) |
| the bot container | must reach the service address (here the Docker bridge gateway `172.19.0.1:8911`) |

## Setup (about 2 hours the first time)

1. **Create the VM disk and install BlissOS.** `qemu-img create -f qcow2 disk.img 16G`, boot the
   ISO with KVM, install to the disk. Give it 2 vCPU / 2 GB RAM.
2. **Make it boot headless.** Software rendering (`HWACCEL=0` on the kernel cmdline) — without a
   GPU the zygote crash-loops otherwise — and a fixed portrait screen (`video=Virtual-1:800x1280`).
   Add a sound card (`-device intel-hda -device hda-duplex`): without one the app cannot create an
   AudioTrack and never fills its video cache. `tools/android-vm/vm-start.sh` is the exact
   QEMU command line (adb forwarded to `127.0.0.1:5555`, VNC on display :10).
3. **Fix guest networking for adb** if `adb connect` stays offline: the guest needs an e1000 NIC,
   a static `10.0.2.15/24` via `10.0.2.2`, and `ip rule add pref 99 lookup main` (Android's
   catch-all `unreachable` rule swallows the replies). `tools/android-vm/newinit39` is an initrd
   init that does all three.
4. **Install and log in to Instagram** over VNC (`novnc-start.sh` gives a browser view):
   `adb install instagram.apk`, open it, log in, finish any verification, scroll a little.
5. **Root adb** (needed to read the app's private cache): `adb root` — repeat after every VM reboot.
   Disable the lock screen once (`adb shell locksettings set-disabled true`): with the keyguard up
   the deep link opens behind it and the app never caches anything (`ig-fetch.py` also runs
   `wm dismiss-keyguard` before every link).
6. **Copy the tools** to the host, e.g. `~/android-vm/`: `ig-fetch.py`, `ig_state.py`,
   `ig-vm-service.py`, `vm-start.sh`, `vm-stop.sh`, `vm-supervise.sh`. Test one link by hand:
   `python3 ig-fetch.py https://www.instagram.com/reel/<code>/ /tmp/out` → `/tmp/out/<code>.mp4`.
7. **Keep the VM alive** — the step that was missing on 2026-11-09, when a guest that had wedged at
   the boot logo left the service answering `503 vm-down` for two days and every reel silently fell
   back to its cover image. `vm-supervise.sh` is idempotent and safe to run often: it starts QEMU
   when it is not running (host-reboot autostart), `adb root`s a freshly booted guest, resets a
   guest that has been at the logo or unreachable for 15 min, restarts QEMU when a reset does not
   help, and posts to the alert channel on every up↔down change. Install it with a timer:
   ```
   sudo cp android-vm-supervise.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now android-vm-supervise.service
   systemctl status android-vm-supervise.service      # active (running), QEMU as its child
   tail -f ~/android-vm/vm-supervise.log              # "ok (qemu age …, root=yes)"
   ```
   Run it as a **long-running loop** unit, never as a `oneshot` + timer: a oneshot's cgroup teardown
   kills the QEMU child it just started (measured 2026-11-09). Also keep QEMU out of the script's lock
   fd (`9>&-` when spawning) or the lock is never released and every later cycle skips itself.
8. **Start the service.** Create `~/android-vm/ig-vm-service.env` (mode 600):
   ```
   IG_VM_TOKEN=<random string, 24+ chars>
   IG_VM_ALLOWED_GUILDS=<guild id>,<guild id>
   IG_VM_BIND=172.19.0.1          # an address the bot container can reach, never 0.0.0.0
   IG_VM_PORT=8911
   ```
   Run `python3 ig-vm-service.py` under systemd. `curl -H "Authorization: Bearer <token>"
   http://172.19.0.1:8911/health` → `{"ok": true, "vm": "device", "account": "OK", …}`.
8. **Point the bot at it.** Create `~/android-vm/ig-vm-librarian.env` (mode 600, outside the repo):
   ```
   IG_VM_URL=http://172.19.0.1:8911
   IG_VM_TOKEN=<same token>
   IG_VM_GUILD_IDS=<guild id>
   ```
   `rebuild-run.sh` sources it (or the file named by `IG_VM_ENV_FILE`) and passes the three
   variables into the container. The app reads the process environment, not `.env`.
9. **Optional health alerts.** `python3 ig_state.py check` from cron every 30 min classifies the
   app screen (OK / PENDING / BLOCKED / LOGGED_OUT). Put `DISCORD_BOT_TOKEN=` and
   `IG_ALERT_CHANNEL_ID=` in `~/android-vm/ig-alert.env` to get a Discord message with a
   screenshot on every state change. While the account is not OK the service answers 503 and
   the bot silently keeps its normal result.

## Re-process old "unavailable" posts

```
docker exec librarian-bot node scripts/reprocess-instagram.js --dry-run          # list the newest 20
docker exec librarian-bot node scripts/reprocess-instagram.js --limit 20 --gap 370
```
Posts are edited in place. `--gap 370` keeps a large backlog under the 10/hour cap.

## Known limits

- Carousels: only the first slide.
- Photo size is what the app cached (~720 px wide).
- One extraction at a time, ~20-40 s each plus pacing; a busy queue answers 429 and the post keeps
  "Video is unavailable for embedding" (run the re-process script later).
- The supervisor autostarts the VM and heals a wedged one within ~5-15 min; until it has, the
  service answers 503 `vm-down` and nothing changes for users.
- Cold start is slow: under libhoudini the app crash-restarts for ~45 s before it stays up.
  `ig-fetch.py` starts the app and waits for the feed before sending the deep link (up to 190 s).
- **A busy host starves the guest.** Measured 2026-11-09: with a desktop browser and a remote-desktop
  server running, the app never left its crash loop and every extraction returned "no cached media";
  after stopping them it converged in ~50 s. Keep the N150 light while the VM works, and read the
  load in the bot log (`INTERCEPTOR STAGE … Android VM`) when the VM suddenly stops producing.
  `tools/android-vm/nightly-browser-cleanup.sh` (+ `/etc/cron.d/nightly-browser-cleanup`, 04:00
  daily) kills vivaldi / google-chrome / chromium on the host so a desktop session left open never
  starves the guest overnight, then restarts openclaw's browser containers (`oc-browser`,
  `oc-external`) so automation starts each day with a fresh, session-less browser; it logs every
  kill and restart to `~/nightly-browser-cleanup.log` and supports `--dry-run`.
- Meta shows consent prompts from time to time (EU cookie choice, "subscribe or use free with
  ads"). While one is open nothing gets cached; `ig-fetch.py` reports it and you click it through
  once over VNC. A stuck guest (clock frozen, adb offline) recovers with a QEMU monitor
  `system_reset` (`echo system_reset | socat - UNIX-CONNECT:/tmp/mon.sock`), then `adb root` again.
- Disable app-store/updater apps in the guest (`pm disable-user --user 0 <package>`): with 2 GB RAM
  they starve the Instagram app.
- Instagram can tell this is an emulator (QEMU board, x86 + ARM bridge). Identity is deliberately
  not spoofed; behaviour is kept human-paced. Use an account you can afford to lose.
