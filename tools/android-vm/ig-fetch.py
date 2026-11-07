#!/usr/bin/env python3
"""ig-fetch.py <reel-url-or-shortcode> [outdir]
Open an Instagram reel/post in the Android VM, read the media the app cached (ExoPlayer cache, needs adb root)
and write the result to outdir (default ~/android-vm/media/out):
  - static media (every frame identical, e.g. a still image shown as a video) -> <shortcode>.png  (image ONLY)
  - real video                                                                  -> <shortcode>.mp4
Exit codes: 0 ok | 3 no root | 4 nothing cached | 5/6 decode problems | 7 ACCOUNT BLOCKED/LOGGED OUT/PENDING | 8 RATE LIMITED
Behaviour designed to look like an ordinary person using the app, and to keep the account safe:
  * results are cached for 7 days (the same link never touches the app twice)
  * spacing between app sessions is randomized (45-120 s), plus hourly (10) and daily (40) caps
  * nothing is done to an account that is flagged blocked / logged out / under review (see ig_state.py)
  * the app is opened with a normal deep link (no scripted taps or swipes), watched for a human-ish random time, then left via HOME
"""
import base64, fcntl, glob, json, os, random, re, shutil, subprocess, sys, tempfile, time
from PIL import Image, ImageChops

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ig_state

HOME = os.path.expanduser("~/android-vm")
ADB = ["/usr/bin/adb", "-s", "127.0.0.1:5555"]
CACHE = "/data/data/com.instagram.android/cache/ExoPlayerCacheDir"
RESULT_CACHE = os.path.join(HOME, "media", "cache")
PACING_F = os.path.join(HOME, "ig-pacing.json")
AL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
STATIC_FRAC = 0.001   # a frame is identical to the reference if fewer than 0.1% of pixels differ by more than PIX_DELTA
PIX_DELTA = 24
RESULT_TTL = 7 * 86400
HOURLY_CAP, DAILY_CAP = 10, 40
GAP_MIN, GAP_MAX = 45, 120


def sh(*a, **k):
    return subprocess.run(list(a), capture_output=True, text=True, **k)


def adb(*a):
    return sh(*ADB, *a)


def shortcode_from(arg):
    m = re.search(r"/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", arg)
    return m.group(1) if m else arg.strip("/ ")


def kind_from(arg):
    m = re.search(r"/(reel|reels|p|tv)/", arg)
    k = m.group(1) if m else "reel"
    return "reel" if k == "reels" else k


def media_id(code):
    code = code[:11] if len(code) > 28 else code
    n = 0
    for c in code:
        n = n * 64 + AL.index(c)
    return n


def ensure_root():
    sh("/usr/bin/adb", "connect", "127.0.0.1:5555")
    if "uid=0" not in adb("shell", "id").stdout:
        adb("root")
        time.sleep(4)
        sh("/usr/bin/adb", "connect", "127.0.0.1:5555")
    return "uid=0" in adb("shell", "id").stdout


def list_spans(mid):
    r = adb("shell", f'find {CACHE} -name "{mid}_*" -type f')
    return [l.strip() for l in r.stdout.splitlines() if l.strip()]


IMG_DIR = "/data/data/com.instagram.android/cache/images.stash/clean"


def image_candidates(mid):
    """cached image variants of this media id, e.g. NDAx...Ng==.3-ccb7-5720_521 (width 720, height 521); sorted by pixel area"""
    key = base64.b64encode(str(mid).encode()).decode().rstrip("=")
    r = adb("shell", f'ls {IMG_DIR} | grep -F "{key}"')
    out = []
    for n in r.stdout.split():
        m = re.search(r"-5(\d+)_(\d+)$", n)
        if m:
            out.append((int(m.group(1)) * int(m.group(2)), n))
    return sorted(out)


def deliver_image(mid, code, outdir):
    """photo post: copy the largest cached original JPEG. Returns the destination path or None."""
    cands = image_candidates(mid)
    if not cands:
        return None
    area, name = cands[-1]
    tmp = tempfile.mktemp(suffix=".jpg")
    adb("pull", f"{IMG_DIR}/{name}", tmp)
    try:
        im = Image.open(tmp)
        im.verify()
    except Exception:
        return None
    if min(Image.open(tmp).size) < 200:       # only a thumbnail made it into the cache
        return None
    dest = os.path.join(outdir, f"{code}.jpg")
    shutil.copy(tmp, dest)
    shutil.copy(tmp, os.path.join(RESULT_CACHE, f"{code}.jpg"))
    os.remove(tmp)
    print(f"{code}: PHOTO POST, cached original {Image.open(dest).size[0]}x{Image.open(dest).size[1]} ({name[-12:]})")
    print("RESULT", dest, os.path.getsize(dest), "bytes")
    return dest


def span_sizes(mid):
    out = adb("shell", f'find {CACHE} -name "{mid}_*" -type f -exec stat -c %s {{}} \\;').stdout.split()
    return sorted(int(x) for x in out if x.isdigit())


def worst_change(frames):
    """largest fraction of pixels that differ by > PIX_DELTA between any sampled frame and the middle frame"""
    ref = Image.open(frames[len(frames) // 2]).convert("L")
    worst = 0.0
    for f in frames:
        d = ImageChops.difference(ref, Image.open(f).convert("L"))
        hist = d.histogram()
        changed = sum(hist[PIX_DELTA + 1:])
        worst = max(worst, changed / float(d.size[0] * d.size[1]))
    return worst


# ---------------------------------------------------------------- pacing
def pacing_load():
    try:
        t = json.load(open(PACING_F)).get("times", [])
    except Exception:
        t = []
    now = time.time()
    return [x for x in t if now - x < 86400]


def pacing_check_and_wait():
    """returns None when allowed (after any needed wait) or a reason string when a cap is hit"""
    t = pacing_load()
    now = time.time()
    if len([x for x in t if now - x < 3600]) >= HOURLY_CAP:
        return "hourly cap (%d) reached" % HOURLY_CAP
    if len(t) >= DAILY_CAP:
        return "daily cap (%d) reached" % DAILY_CAP
    if t:
        gap = random.uniform(GAP_MIN, GAP_MAX)
        wait = (max(t) + gap) - now
        if wait > 0:
            if wait > 125:
                return "too soon after the previous session"
            time.sleep(wait)
    return None


def pacing_record():
    t = pacing_load()
    t.append(time.time())
    json.dump({"times": t}, open(PACING_F, "w"))


def cache_lookup(code):
    for ext in ("png", "mp4"):
        p = os.path.join(RESULT_CACHE, f"{code}.{ext}")
        if os.path.exists(p) and time.time() - os.path.getmtime(p) < RESULT_TTL:
            return p
    return None


def leave_app():
    """end the session like a person pressing Home"""
    adb("shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    code = shortcode_from(sys.argv[1])
    outdir = os.path.expanduser(sys.argv[2] if len(sys.argv) > 2 else "~/android-vm/media/out")
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(RESULT_CACHE, exist_ok=True)

    hit = cache_lookup(code)
    if hit:                       # no app activity at all
        dest = os.path.join(outdir, os.path.basename(hit))
        shutil.copy(hit, dest)
        print(f"{code}: served from result cache")
        print("RESULT", dest, os.path.getsize(dest), "bytes")
        return

    if ig_state.blocked():
        st = ig_state.load()
        print("ACCOUNT_STATE", st.get("state"), st.get("detail", "")[:120])
        sys.exit(7)

    fd = os.open(ig_state.UI_LOCK, os.O_CREAT | os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX)          # one UI user at a time (health check / other extraction)
    try:
        why = pacing_check_and_wait()
        if why:
            print("RATE_LIMITED", why)
            sys.exit(8)
        mid = media_id(code)
        if not ensure_root():
            print("ERROR: could not get adb root"); sys.exit(3)
        time.sleep(random.uniform(2, 7))    # a person does not act the instant a link arrives
        url = f"https://instagram.com/{kind_from(sys.argv[1])}/{code}/"
        adb("shell", "input keyevent 224")
        adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, "-p", "com.instagram.android")
        pacing_record()
        # wait for cache spans to appear and stop growing (video + audio)
        stable, last, t0, looked = 0, None, time.time(), False
        img_stable, last_imgs = 0, None
        while time.time() - t0 < 120:
            time.sleep(3)
            sizes = span_sizes(mid)
            if sizes and sizes == last:
                stable += 1
                if stable >= 3:
                    break
            else:
                stable = 0
            last = sizes
            if not sizes and time.time() - t0 >= 15:      # no video after 15 s: maybe a photo post - watch the image cache
                imgs = image_candidates(mid)
                img_stable = img_stable + 1 if (imgs and imgs == last_imgs) else 0
                last_imgs = imgs
                if img_stable >= 2:
                    break
            if not sizes and not looked and time.time() - t0 > 20:
                looked = True               # nothing cached yet: is the account the problem?
                focus, texts, png = ig_state.read_screen()
                state, detail = ig_state.classify(focus, texts)
                if state in ig_state.BAD:
                    ig_state.record(state, detail, png, source="extraction")
                    leave_app()
                    print("ACCOUNT_STATE", state, detail[:120])
                    sys.exit(7)
        spans = list_spans(mid)
        if not spans:
            photo = deliver_image(mid, code, outdir)
            if photo:
                ig_state.record("OK", "extraction ok (photo)", None, source="extraction")
                time.sleep(random.uniform(4, 12))      # a viewer looks at the picture for a moment
                leave_app()
                return
            focus, texts, png = ig_state.read_screen()
            state, detail = ig_state.classify(focus, texts)
            ig_state.record(state, detail, png, source="extraction")
            leave_app()
            if state in ig_state.BAD:
                print("ACCOUNT_STATE", state, detail[:120]); sys.exit(7)
            print("ERROR: no cached media for", code, "(post unreachable / photo post / not logged in)"); sys.exit(4)
        ig_state.record("OK", "extraction ok", None, source="extraction")   # a working extraction proves the account is fine
        work = tempfile.mkdtemp(prefix="igfetch_")
        try:
            streams = {}
            for f in spans:
                b = os.path.basename(f)
                m = re.match(rf"{mid}_\d+\.null\.(\d+)([av])\.-1\.[0-9a-f]+\.(\d+)\.\d+\.v2\.exo", b)
                if not m:
                    continue
                dst = os.path.join(work, b)
                adb("pull", f, dst)
                if os.path.exists(dst):
                    streams.setdefault((m.group(2), m.group(1)), []).append((int(m.group(3)), dst))
            files = {}
            for (kind, key), lst in streams.items():
                lst.sort()
                p = os.path.join(work, f"{kind}_{key}.mp4")
                with open(p, "wb") as o:
                    for _, fn in lst:
                        o.write(open(fn, "rb").read())
                files.setdefault(kind, []).append(p)
            if "v" not in files:
                leave_app(); print("ERROR: no video stream cached"); sys.exit(5)
            vid = max(files["v"], key=os.path.getsize)
            aud = max(files.get("a", []), key=os.path.getsize) if files.get("a") else None
            fr = os.path.join(work, "f_%03d.png")
            sh("ffmpeg", "-v", "error", "-y", "-i", vid, "-vf", "fps=4", fr)
            frames = sorted(glob.glob(os.path.join(work, "f_*.png")))
            if not frames:
                leave_app(); print("ERROR: could not decode video"); sys.exit(6)
            worst = worst_change(frames)
            static = worst < STATIC_FRAC
            print(f"{code}: {len(frames)} sampled frames, max changed-pixel fraction vs middle frame = {worst*100:.3f}% -> {'STATIC IMAGE' if static else 'REAL VIDEO'}")
            if static:
                full = os.path.join(work, "full.png")
                sh("ffmpeg", "-v", "error", "-y", "-i", vid, "-vf", "select=eq(n\\,%d)" % max(1, len(frames) // 2 * 8), "-frames:v", "1", full)
                src = full if os.path.exists(full) else frames[len(frames) // 2]
                dest = os.path.join(outdir, f"{code}.png")
                img = Image.open(src).convert("RGB")
                bbox = img.convert("L").point(lambda p: 255 if p > 14 else 0).getbbox()
                if bbox and (bbox[2] - bbox[0]) > 32 and (bbox[3] - bbox[1]) > 32:
                    img = img.crop(bbox)
                img.save(dest)
            else:
                dest = os.path.join(outdir, f"{code}.mp4")
                cmd = ["ffmpeg", "-v", "error", "-y", "-i", vid]
                if aud:
                    cmd += ["-i", aud, "-map", "0:v", "-map", "1:a", "-c", "copy", "-shortest"]
                else:
                    cmd += ["-c", "copy"]
                sh(*cmd, dest)
            shutil.copy(dest, os.path.join(RESULT_CACHE, os.path.basename(dest)))
            print("RESULT", dest, os.path.getsize(dest), "bytes")
        finally:
            shutil.rmtree(work, ignore_errors=True)
        # a viewer stays on the post for a while before leaving; vary it, occasionally linger longer
        time.sleep(random.uniform(4, 12) + (random.uniform(8, 20) if random.random() < 0.25 else 0))
        leave_app()
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


if __name__ == "__main__":
    main()
