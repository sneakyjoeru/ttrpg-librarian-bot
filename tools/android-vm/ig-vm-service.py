#!/usr/bin/env python3
"""ig-vm-service.py - HTTP front door to the Android VM's Instagram extractor (ig-fetch.py).

POST /fetch   {"url": "https://www.instagram.com/reel/<code>/", "guild_id": "<discord guild id>"}
              -> 200 + media bytes   (headers: X-Kind: image|video, X-Filename, Content-Type)
              -> 4xx/5xx + JSON {"error": "..."}   (503 account-blocked / vm-down, 429 busy / rate-limited)
GET  /health  -> {"ok": true, "vm": "device|down", "busy": bool, "account": "OK|PENDING|BLOCKED|LOGGED_OUT|UNKNOWN"}

Security (all enforced here, independently of the bot):
  * Authorization: Bearer <IG_VM_TOKEN> on every request (constant-time compare)
  * guild_id must be in IG_VM_ALLOWED_GUILDS (the Discord servers you allow); anything else -> 403, nothing runs
  * url must be an instagram.com reel/p/tv link (strict regex); no shell is ever involved
  * binds only to IG_VM_BIND (the docker bridge gateway), never 0.0.0.0
  * one extraction at a time (the VM has one screen); at most 3 jobs waiting
  * nothing is run while the Instagram account is flagged BLOCKED / LOGGED_OUT / PENDING (ig_state.py)
Config: env file (KEY=VALUE lines) given as argv[1], default ~/android-vm/ig-vm-service.env
"""
import hmac, json, os, re, subprocess, sys, tempfile, threading, time, shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~/android-vm")
sys.path.insert(0, HOME)
import ig_state

ENVF = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HOME, "ig-vm-service.env")
LOG = os.path.join(HOME, "ig-vm-service.log")
URL_RE = re.compile(r"^https?://(?:www\.)?instagram\.com/(?:reel|reels|p|tv)/[A-Za-z0-9_-]{5,40}/?(?:\?[^\s#]*)?$")
MAX_BYTES = 100 * 1024 * 1024
JOB_TIMEOUT = 300      # includes the randomized pacing wait (<=125 s) and the human-like dwell after the result
MAX_WAITING = 3


def load_env(path):
    cfg = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg


CFG = load_env(ENVF)
TOKEN = CFG["IG_VM_TOKEN"]
ALLOWED = {g.strip() for g in CFG.get("IG_VM_ALLOWED_GUILDS", "").split(",") if g.strip()}
BIND = CFG.get("IG_VM_BIND", "127.0.0.1")
PORT = int(CFG.get("IG_VM_PORT", "8911"))
if not TOKEN or len(TOKEN) < 24 or not ALLOWED:
    sys.exit("refusing to start: need IG_VM_TOKEN (>=24 chars) and IG_VM_ALLOWED_GUILDS")

LOCK = threading.Lock()
STATE = {"waiting": 0, "busy": False}
STATE_LOCK = threading.Lock()


def log(msg):
    with open(LOG, "a") as f:
        f.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), msg))


def vm_state():
    try:
        subprocess.run(["/usr/bin/adb", "connect", "127.0.0.1:5555"], capture_output=True, text=True, timeout=10)
        r = subprocess.run(["/usr/bin/adb", "-s", "127.0.0.1:5555", "get-state"], capture_output=True, text=True, timeout=10)
        return r.stdout.strip() or "down"
    except Exception:
        return "down"


class H(BaseHTTPRequestHandler):
    server_version = "ig-vm/2"

    def log_message(self, fmt, *a):  # silence default stderr logging
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _auth(self):
        got = self.headers.get("Authorization", "")
        want = "Bearer " + TOKEN
        return hmac.compare_digest(got.encode(), want.encode())

    def do_GET(self):
        if not self._auth():
            return self._json(401, {"error": "unauthorized"})
        if self.path == "/health":
            st = ig_state.load()
            return self._json(200, {"ok": True, "vm": vm_state(), "busy": STATE["busy"], "waiting": STATE["waiting"],
                                    "account": st.get("state"), "account_since": st.get("since"), "account_checked": st.get("checked_at")})
        self._json(404, {"error": "not-found"})

    def do_POST(self):
        if not self._auth():
            return self._json(401, {"error": "unauthorized"})
        if self.path != "/fetch":
            return self._json(404, {"error": "not-found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > 4096:
                return self._json(400, {"error": "bad-body"})
            req = json.loads(self.rfile.read(n))
            url = str(req.get("url", ""))
            guild = str(req.get("guild_id", ""))
        except Exception:
            return self._json(400, {"error": "bad-json"})
        if guild not in ALLOWED:
            log("DENY guild=%s url=%s" % (guild[:24], url[:80]))
            return self._json(403, {"error": "guild-not-allowed"})
        if not URL_RE.match(url):
            return self._json(400, {"error": "bad-url"})
        if ig_state.blocked():
            st = ig_state.load()
            log("503 account-blocked state=%s guild=%s" % (st.get("state"), guild))
            return self._json(503, {"error": "account-blocked", "state": st.get("state")})
        if vm_state() != "device":
            log("503 vm-down guild=%s" % guild)
            return self._json(503, {"error": "vm-down"})
        with STATE_LOCK:
            if STATE["waiting"] >= MAX_WAITING:
                return self._json(429, {"error": "busy"})
            STATE["waiting"] += 1
        got_lock = LOCK.acquire(timeout=JOB_TIMEOUT)
        with STATE_LOCK:
            STATE["waiting"] -= 1
        if not got_lock:
            return self._json(429, {"error": "busy"})
        STATE["busy"] = True
        out = tempfile.mkdtemp(prefix="igvm_")
        t0 = time.time()
        proc = None
        try:
            proc = subprocess.Popen(["python3", os.path.join(HOME, "ig-fetch.py"), url, out], stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            lines, result_seen = [], False
            deadline = t0 + JOB_TIMEOUT
            # answer as soon as the RESULT line appears; the extractor then finishes its human-like dwell on its own
            while time.time() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                lines.append(line.strip())
                if line.startswith("RESULT"):
                    result_seen = True
                    break
            else:
                proc.kill()
                log("TIMEOUT guild=%s url=%s" % (guild, url[:80]))
                return self._json(504, {"error": "timeout"})
            if not result_seen:
                rc = proc.wait(timeout=30)
                tail = " | ".join(lines[-3:])[:200]
                log("FAIL guild=%s url=%s rc=%s %s" % (guild, url[:80], rc, tail))
                if rc == 7:
                    st = ig_state.load()
                    return self._json(503, {"error": "account-blocked", "state": st.get("state"), "detail": tail})
                if rc == 8:
                    return self._json(429, {"error": "rate-limited", "detail": tail})
                return self._json(502, {"error": "extract-failed", "detail": tail})
            files = [f for f in os.listdir(out) if f.lower().endswith((".png", ".jpg", ".mp4"))]
            if not files:
                return self._json(502, {"error": "extract-failed", "detail": "no output file"})
            fn = files[0]
            path = os.path.join(out, fn)
            size = os.path.getsize(path)
            if size > MAX_BYTES:
                return self._json(413, {"error": "too-large", "size": size})
            data = open(path, "rb").read()
            kind = "video" if fn.endswith(".mp4") else "image"
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4" if kind == "video" else ("image/jpeg" if fn.endswith(".jpg") else "image/png"))
            self.send_header("X-Kind", kind)
            self.send_header("X-Filename", fn)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
            log("OK guild=%s %s kind=%s bytes=%d %.1fs" % (guild, fn, kind, size, time.time() - t0))
            try:  # keep the UI lock until the extractor has left the app
                proc.wait(timeout=90)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception as e:
            log("ERROR guild=%s %r" % (guild, e))
            try:
                self._json(500, {"error": "internal"})
            except Exception:
                pass
        finally:
            if proc and proc.poll() is None:
                proc.kill()
            STATE["busy"] = False
            LOCK.release()
            shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    log("start bind=%s:%d allowed=%s" % (BIND, PORT, sorted(ALLOWED)))
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
