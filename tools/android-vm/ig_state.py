#!/usr/bin/env python3
"""ig_state.py - Instagram account health for the Android VM.

Used by ig-fetch.py (every extraction), ig-vm-service.py (refuses work while the account is blocked) and cron
(`python3 ig_state.py check`).  The account state lives in ~/android-vm/account-state.json:
    {"state": "OK|PENDING|BLOCKED|LOGGED_OUT|UNKNOWN", "detail": "...", "since": epoch, "checked_at": epoch, "alerted": "<state>"}
States
    OK         normal app screens (feed/reel/etc.) or a successful extraction
    PENDING    appeal / verification under review (account unusable for now, nothing to do but wait)
    BLOCKED    disabled / suspended / checkpoint / "action blocked" / unusual-activity / confirm-it's-you challenge
    LOGGED_OUT login screen shown (session was revoked)
    UNKNOWN    could not classify (app crashed, loading, ...) - not treated as a block
On a transition between states a Discord message goes to the owner's advisor channel via OpenClaw's bot, with a screenshot.
"""
import fcntl, json, os, re, subprocess, sys, tempfile, time, random, urllib.request

HOME = os.path.expanduser("~/android-vm")
STATE_F = os.path.join(HOME, "account-state.json")
UI_LOCK = os.path.join(HOME, "vm-ui.lock")
# Alerts: a file with DISCORD_BOT_TOKEN=<bot token> and the channel that receives account-state alerts.
# Both optional - without them the state is still tracked, only the Discord alert is skipped.
ENVF = os.path.expanduser(os.environ.get("IG_ALERT_ENV_FILE", "~/android-vm/ig-alert.env"))
CHANNEL = os.environ.get("IG_ALERT_CHANNEL_ID", "")
ADB = ["/usr/bin/adb", "-s", "127.0.0.1:5555"]
BAD = ("BLOCKED", "LOGGED_OUT", "PENDING")

BLOCK_WORDS = (
    "disabled", "suspended", "suspend", "community standards", "can't appeal", "cannot appeal", "we removed",
    "violat", "action blocked", "try again later", "we limit how often", "suspicious", "unusual activity",
    "confirm you're human", "confirm it's you", "confirm that it's you", "verify your identity", "temporarily locked",
    "we detected", "automated behavior", "checkpoint", "secure your account", "your account has been", "not able to use",
    "permanently",
)


def sh(*a, timeout=30):
    return subprocess.run(list(a), capture_output=True, text=True, timeout=timeout)


def adb(*a, timeout=30):
    return sh(*ADB, *a, timeout=timeout)


def load():
    try:
        return json.load(open(STATE_F))
    except Exception:
        return {"state": "UNKNOWN", "detail": "", "since": 0, "checked_at": 0, "alerted": ""}


def save(st):
    tmp = STATE_F + ".tmp"
    json.dump(st, open(tmp, "w"), indent=1)
    os.replace(tmp, STATE_F)


def classify(focus, texts):
    """pure function: (focus window string, list of on-screen texts) -> (state, detail)"""
    blob = " | ".join(t for t in texts if t)
    low = blob.lower()
    f = (focus or "")
    if "you submitted an appeal" in low or "review your information" in low or "check back here" in low:
        return "PENDING", blob[:300]
    if ("log in" in low and ("create new account" in low or "forgot password" in low)) or "LoginActivity" in f:
        return "LOGGED_OUT", blob[:300]
    if "ChallengeActivity" in f or any(k in low for k in BLOCK_WORDS):
        return "BLOCKED", blob[:300]
    fl = f.lower()
    if ("maintabactivity" in fl or "mainactivity" in fl or "urlhandlers" in fl or "clips" in fl) and \
            any(k in low for k in ("home", "search", "reels", "profile", "like", "comment", "share", "follow")):
        return "OK", blob[:120]
    return "UNKNOWN", blob[:300]


def read_screen(wait=0.0):
    """-> (focus, texts, png_path|None).  Does not touch the UI beyond a screenshot and a UI-tree dump."""
    if wait:
        time.sleep(wait)
    focus = adb("shell", "dumpsys window | grep -m1 mCurrentFocus").stdout.strip()
    png = tempfile.mktemp(prefix="igstate_", suffix=".png")
    adb("shell", "screencap -p /sdcard/_st.png")
    r = adb("pull", "/sdcard/_st.png", png)
    adb("shell", "rm -f /sdcard/_st.png")
    xml = adb("shell", "uiautomator dump /sdcard/_st.xml >/dev/null 2>&1; cat /sdcard/_st.xml; rm -f /sdcard/_st.xml", timeout=40).stdout
    texts = []
    for t in re.findall(r'(?:text|content-desc)="([^"]*)"', xml):
        t = t.strip()
        if t and t not in texts:
            texts.append(t)
    return focus, texts, (png if os.path.exists(png) else None)


def discord(text, png=None):
    try:
        tok, channel = None, CHANNEL
        for line in open(ENVF):
            if line.startswith("DISCORD_BOT_TOKEN="):
                tok = line.split("=", 1)[1].strip()
            elif line.startswith("IG_ALERT_CHANNEL_ID=") and not channel:
                channel = line.split("=", 1)[1].strip()
        if not tok or not channel:
            return False
        url = "https://discord.com/api/v10/channels/%s/messages" % channel
        if png and os.path.exists(png):
            r = sh("curl", "-s", "-m", "30", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", url,
                   "-H", "Authorization: Bot " + tok, "-H", "User-Agent: OpenClaw-advisor/1.0",
                   "-F", "payload_json=" + json.dumps({"content": text[:1900]}),
                   "-F", "files[0]=@%s;filename=instagram-vm-status.png" % png, timeout=45)
        else:
            req = urllib.request.Request(url, data=json.dumps({"content": text[:1900]}).encode(),
                                         headers={"Authorization": "Bot " + tok, "Content-Type": "application/json",
                                                  "User-Agent": "OpenClaw-advisor/1.0"})
            urllib.request.urlopen(req, timeout=20)
        return True
    except Exception as e:
        sys.stderr.write("discord post failed: %r\n" % (e,))
        return False


def record(state, detail="", png=None, source="check"):
    """store the observed state; alert on a transition (and on recovery)."""
    st = load()
    now = int(time.time())
    prev = st.get("state", "UNKNOWN")
    changed = state != prev
    if state == "UNKNOWN" and prev in BAD + ("OK",):
        # an unclassifiable screen never overrides a known state (app might just be loading)
        st["checked_at"] = now
        save(st)
        return st
    st.update({"state": state, "detail": detail, "checked_at": now})
    if changed:
        st["since"] = now
    alert_needed = changed and st.get("alerted") != state
    if alert_needed:
        if state == "BLOCKED":
            msg = ("Instagram VM account looks BLOCKED / restricted by Instagram. The VM fallback is paused (the bot keeps using its normal "
                   "downloaders). Screen says: %s" % detail[:600])
        elif state == "LOGGED_OUT":
            msg = "Instagram VM account got LOGGED OUT (login screen). VM fallback paused until it is logged in again."
        elif state == "PENDING":
            msg = "Instagram VM account is under review (appeal/verification pending). VM fallback paused. Screen says: %s" % detail[:400]
        elif state == "OK" and prev in BAD:
            msg = "Instagram VM account is working again (was %s). VM fallback resumed." % prev
        else:
            msg = None
        if msg:
            discord(msg + " [%s]" % source, png)
        st["alerted"] = state
    save(st)
    return st


def blocked():
    """True while the account must not be used."""
    return load().get("state") in BAD


def check(force=False):
    """cron entry: look at the app (only when due) and record the state."""
    st = load()
    age = time.time() - st.get("checked_at", 0)
    due = {"OK": 3 * 3600, "UNKNOWN": 3600, "PENDING": 1800, "BLOCKED": 6 * 3600, "LOGGED_OUT": 6 * 3600}.get(st.get("state", "UNKNOWN"), 3600)
    if not force and age < due * random.uniform(0.9, 1.25):
        return "skip (checked %d min ago, state %s)" % (age // 60, st.get("state"))
    fd = os.open(UI_LOCK, os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return "skip (VM busy)"
    try:
        sh("/usr/bin/adb", "connect", "127.0.0.1:5555")
        if adb("get-state").stdout.strip() != "device":
            return "skip (VM down)"
        adb("shell", "input keyevent 224")
        adb("shell", "am", "start", "-n", "com.instagram.android/.activity.MainTabActivity")
        time.sleep(random.uniform(12, 18))
        focus, texts, png = read_screen()
        state, detail = classify(focus, texts)
        record(state, detail, png, source="health check")
        adb("shell", "am start -a android.intent.action.MAIN -c android.intent.category.HOME")
        if png:
            os.remove(png)
        return "%s - %s" % (state, detail[:100])
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "check":
        print(check(force="--force" in sys.argv))
    elif cmd == "show":
        print(json.dumps(load(), indent=1))
    elif cmd == "set":  # manual override: ig_state.py set OK|BLOCKED|... [detail]
        record(sys.argv[2], " ".join(sys.argv[3:]), None, source="manual")
        print(json.dumps(load(), indent=1))
    else:
        print(__doc__)
