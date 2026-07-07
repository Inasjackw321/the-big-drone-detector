#!/usr/bin/env python3
"""
The Big Drone Detector — local Python app.

Tracks Russian/Ukrainian aerial threats (drones, Shaheds, cruise & ballistic
missiles) from public Telegram channels. Reading runs locally through an
Ollama model (default gemma4:12b) that classifies each object's type and
separates distinct objects in a post; results are geocoded offline, correlated
into per-object flight tracks, and served to a live dark map with a timeline.

Run it:

    python drone_detector.py

It opens in a native desktop window (via pywebview, if installed), downloads
new history on startup, correlates it into flight tracks, and keeps polling
until you close the window / press Ctrl+C. Results are cached on disk, so the
map repaints instantly on the next launch and only NEW posts are extracted.

Requirements: Python 3.8+, and Ollama running with the model pulled:
    ollama pull gemma4:12b
    ollama serve

For the native window (recommended):  pip install pywebview
Without it, the app falls back to opening your browser.
"""

import json
import math
import os
import re
import sys
import time
import socket
import threading
import webbrowser
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# --------------------------------------------------------------------------- #
# Paths & config
# --------------------------------------------------------------------------- #
HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
DATA_OUT = os.path.join(WEB_DIR, "data")          # served to the browser
GAZETTEER = os.path.join(HERE, "data", "ru-gazetteer.json")
os.makedirs(DATA_OUT, exist_ok=True)


def env(name, default):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def app_data_dir():
    """Platform-appropriate writable dir for the persistent cache."""
    override = os.environ.get("DDX_DATA_DIR")
    if override:
        d = override
    elif sys.platform.startswith("win"):
        d = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "TheBigDroneDetector")
    elif sys.platform == "darwin":
        d = os.path.expanduser("~/Library/Application Support/TheBigDroneDetector")
    else:
        d = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")),
                         "the-big-drone-detector")
    os.makedirs(d, exist_ok=True)
    return d


STATE_FILE = os.path.join(app_data_dir(), "state.json")


CONFIG = {
    "ollama_url": env("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/"),
    # A capable general instruction model reads the posts far more accurately
    # than a translation-only model — it classifies threat type, separates
    # distinct objects and geocodes far better. gemma4:12b is the default;
    # any pulled Ollama model works (gemma3:12b / gemma3:4b for older/faster).
    "ollama_model": env("OLLAMA_MODEL", "gemma4:12b"),
    "verify": env("DDX_VERIFY", "1") not in ("0", "false", "no"),
    "channels": [c.strip() for c in env(
        "TELEGRAM_CHANNELS", "radarrussiia,kpszsu,lpr1_treugolnik,locatorru").split(",") if c.strip()],
    # At startup, grab only the last hour of messages and plot them.
    "backfill_hours": float(env("DDX_BACKFILL_HOURS", "1")),
    # Retain a longer window so the session timelapse video has material, and
    # so tracks can keep their recent path. The live map still shows only ~1h.
    "history_hours": float(env("DDX_HISTORY_HOURS", "24")),
    "poll_seconds": int(env("POLL_INTERVAL_SECONDS", "60")),
    "backfill_max_pages": int(env("DDX_BACKFILL_MAX_PAGES", "40")),
    "max_new_posts": int(env("DDX_MAX_POSTS", "80")),
    "port": int(env("DDX_PORT", "8700")),
    "enable_nominatim": env("DDX_NOMINATIM", "1") not in ("0", "false", "no"),
    # During bulk backfill, only use the slow (1 req/sec) Nominatim lookup for
    # posts newer than this; older history resolves from the gazetteer / LLM
    # coords / region centroid instantly.
    "nominatim_recent_hours": float(env("DDX_NOMINATIM_RECENT_HOURS", "6")),
    "llm_timeout": int(env("DDX_LLM_TIMEOUT", "120")),
    # Concurrent extractions during backfill — overlaps Telegram fetch, geocode
    # and LLM calls so a busy history loads several times faster.
    "concurrency": max(1, int(env("DDX_CONCURRENCY", "3"))),
    # Skip the LLM entirely for posts that mention no aerial-threat keyword —
    # they are never sightings, so this cuts model calls (and load time)
    # dramatically on busy channels full of unrelated chatter.
    "llm_prefilter": env("DDX_LLM_PREFILTER", "1") not in ("0", "false", "no"),
    # During bulk backfill, only run the (slower) verification pass on posts
    # newer than this many hours — keeps current threats accurate while old
    # history loads fast. Live polling always verifies.
    "verify_recent_hours": float(env("DDX_VERIFY_RECENT_HOURS", "6")),
    # How to show the map:  auto (default) = a standalone desktop app window
    # when pywebview + a display are available, otherwise the browser;
    # 1/native/app = force the desktop window;  0/browser = force the browser.
    "native_mode": env("DDX_NATIVE", "auto").strip().lower(),
    # If Ollama can't be reached, fall back to the deterministic parser so the
    # app still works (less accurate, but never blank).
    "allow_heuristic_only": env("DDX_ALLOW_HEURISTIC_ONLY", "1") not in ("0", "false", "no"),
}

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def log(msg):
    print(f"[ddx] {msg}", flush=True)


def now_ms():
    return int(time.time() * 1000)


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    if not s:
        return 0
    try:
        s = s.replace("Z", "+00:00")
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return 0


# --------------------------------------------------------------------------- #
# Geo helpers
# --------------------------------------------------------------------------- #
def normalize_key(s):
    s = (s or "").lower().replace("ё", "е")
    s = re.sub(r"[«»\"'`.,()]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def haversine_km(lat1, lon1, lat2, lon2):
    to_rad = math.radians
    d_la, d_lo = to_rad(lat2 - lat1), to_rad(lon2 - lon1)
    a = (math.sin(d_la / 2) ** 2 +
         math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lo / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def bearing_between(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def in_region_bbox(lat, lon):
    return isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and \
        41 <= lat <= 78 and 19 <= lon <= 180


COMPASS = {
    "n": 0, "north": 0, "север": 0, "ne": 45, "north-east": 45, "northeast": 45, "северо-восток": 45,
    "e": 90, "east": 90, "восток": 90, "se": 135, "south-east": 135, "southeast": 135, "юго-восток": 135,
    "s": 180, "south": 180, "юг": 180, "sw": 225, "south-west": 225, "southwest": 225, "юго-запад": 225,
    "w": 270, "west": 270, "запад": 270, "nw": 315, "north-west": 315, "northwest": 315, "северо-запад": 315,
}


def heading_to_bearing(heading):
    if not heading:
        return None
    k = str(heading).strip().lower().replace(" ", "-")
    if k in COMPASS:
        return COMPASS[k]
    for w, v in COMPASS.items():
        if len(w) > 2 and w in k:
            return v
    return None


# A location named as a district/raion/oblast is an AREA, not a point — mark it
# region-precision so the map shades it as a zone instead of a false pinpoint.
AREA_NAME_RE = re.compile(r"\b(district|raion|region|oblast|krai)\b|район|область|облас|краю?\b|окру", re.I)


def is_area_name(name):
    return bool(name and AREA_NAME_RE.search(name))


# Extra offline anchors so common Kuban/Crimea places and airbase towns geocode
# precisely without hitting the network (better, faster geolocation). Only fills
# gaps — existing gazetteer entries win.
EXTRA_PLACES = [
    {"name": "Primorsko-Akhtarsk", "ru": "Приморско-Ахтарск", "lat": 46.051, "lon": 38.171, "region": "Krasnodar Krai"},
    {"name": "Slavyansk-na-Kubani", "ru": "Славянск-на-Кубани", "lat": 45.261, "lon": 38.126, "region": "Krasnodar Krai"},
    {"name": "Krymsk", "ru": "Крымск", "lat": 44.934, "lon": 37.982, "region": "Krasnodar Krai"},
    {"name": "Temryuk", "ru": "Темрюк", "lat": 45.276, "lon": 37.386, "region": "Krasnodar Krai"},
    {"name": "Anapa", "ru": "Анапа", "lat": 44.894, "lon": 37.316, "region": "Krasnodar Krai"},
    {"name": "Novorossiysk", "ru": "Новороссийск", "lat": 44.724, "lon": 37.768, "region": "Krasnodar Krai"},
    {"name": "Taman", "ru": "Тамань", "lat": 45.213, "lon": 36.712, "region": "Krasnodar Krai"},
    {"name": "Yeysk", "ru": "Ейск", "lat": 46.711, "lon": 38.277, "region": "Krasnodar Krai"},
    {"name": "Kushchyovskaya", "ru": "Кущёвская", "aliases": ["Kushchevskaya"], "lat": 46.556, "lon": 39.635, "region": "Krasnodar Krai"},
    {"name": "Bryukhovetskaya", "ru": "Брюховецкая", "lat": 45.797, "lon": 38.990, "region": "Krasnodar Krai"},
    {"name": "Poltavskaya", "ru": "Полтавская", "lat": 45.351, "lon": 38.160, "region": "Krasnodar Krai"},
    {"name": "Akhtanizovskaya", "ru": "Ахтанизовская", "lat": 45.322, "lon": 37.101, "region": "Krasnodar Krai"},
    {"name": "Kropotkin", "ru": "Кропоткин", "lat": 45.434, "lon": 40.575, "region": "Krasnodar Krai"},
    {"name": "Tikhoretsk", "ru": "Тихорецк", "lat": 45.856, "lon": 40.126, "region": "Krasnodar Krai"},
    {"name": "Armavir", "ru": "Армавир", "lat": 44.999, "lon": 41.123, "region": "Krasnodar Krai"},
    {"name": "Engels", "ru": "Энгельс", "lat": 51.498, "lon": 46.125, "region": "Saratov Oblast"},
    {"name": "Morozovsk", "ru": "Морозовск", "lat": 48.352, "lon": 41.827, "region": "Rostov Oblast"},
    {"name": "Millerovo", "ru": "Миллерово", "lat": 48.923, "lon": 40.394, "region": "Rostov Oblast"},
    {"name": "Taganrog", "ru": "Таганрог", "lat": 47.209, "lon": 38.935, "region": "Rostov Oblast"},
    {"name": "Dzhankoi", "ru": "Джанкой", "aliases": ["Dzhankoy"], "lat": 45.708, "lon": 34.393, "region": "Crimea"},
    {"name": "Saky", "ru": "Саки", "lat": 45.135, "lon": 33.599, "region": "Crimea"},
    {"name": "Gvardeyskoye", "ru": "Гвардейское", "lat": 45.111, "lon": 33.977, "region": "Crimea"},
]


# --------------------------------------------------------------------------- #
# Offline geocoder (gazetteer + optional Nominatim), thread-safe
# --------------------------------------------------------------------------- #
class Geocoder:
    def __init__(self):
        self.index = {}
        self.cache = {}
        self.negative = set()  # cache_keys Nominatim couldn't resolve (skip re-query)
        self._lock = threading.Lock()
        self._nom_lock = threading.Lock()
        self._last_nom = 0.0
        self._load()

    def load_cache(self, cache, negatives=None):
        """Warm-start resolved-place cache from a previous run (instant repeats)."""
        if isinstance(cache, dict):
            with self._lock:
                for k, v in cache.items():
                    if isinstance(v, dict) and isinstance(v.get("lat"), (int, float)):
                        self.cache[k] = v
        if isinstance(negatives, list):
            with self._lock:
                self.negative.update(negatives)

    def dump_cache(self):
        with self._lock:
            return {k: v for k, v in self.cache.items() if v}

    def dump_negatives(self):
        with self._lock:
            return list(self.negative)[:8000]

    def _load(self):
        try:
            with open(GAZETTEER, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            log(f"gazetteer load failed: {e}")
            return
        for p in list(data.get("places", [])) + EXTRA_PLACES:
            entry = {"name": p["name"], "region": p.get("region", ""),
                     "lat": p["lat"], "lon": p["lon"], "source": "gazetteer"}
            keys = {normalize_key(p["name"]), normalize_key(p.get("ru", ""))}
            for a in p.get("aliases", []):
                keys.add(normalize_key(a))
            for k in keys:
                if k:
                    self.index.setdefault(k, entry)

    def lookup_local(self, name, region=""):
        if not name:
            return None
        key = normalize_key(name)
        if key in self.index:
            return self.index[key]
        if region:
            combo = normalize_key(f"{name} {region}")
            if combo in self.index:
                return self.index[combo]
        if len(key) >= 4:
            for k, entry in self.index.items():
                if key in k:
                    return entry
        return None

    def lookup_region(self, region):
        if not region:
            return None
        rk = normalize_key(region)
        if rk in self.index:
            e = dict(self.index[rk])
            e["source"] = "gazetteer-region"
            return e
        return None

    def _nominatim(self, query, timeout=12):
        if not CONFIG["enable_nominatim"]:
            return None
        with self._nom_lock:  # serialise + rate-limit to 1 req/sec
            wait = 1.1 - (time.time() - self._last_nom)
            if wait > 0:
                time.sleep(wait)
            self._last_nom = time.time()
            url = ("https://nominatim.openstreetmap.org/search?format=json&limit=1"
                   "&accept-language=en&countrycodes=ru,ua&q=" + urllib.parse.quote(query))
            try:
                req = urllib.request.Request(url, headers={
                    "User-Agent": "the-big-drone-detector/1.0", "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    arr = json.load(r)
                if isinstance(arr, list) and arr:
                    return {"name": (arr[0].get("display_name", query).split(",")[0]),
                            "region": "", "lat": float(arr[0]["lat"]), "lon": float(arr[0]["lon"]),
                            "source": "nominatim"}
            except Exception:
                return None
        return None

    def resolve(self, sighting, allow_nominatim=True):
        loc = sighting.get("location", "")
        region = sighting.get("region", "")
        cache_key = normalize_key(f"{loc}|{region}")
        with self._lock:
            if cache_key in self.cache:
                return self.cache[cache_key]
            neg = cache_key in self.negative

        # 1) gazetteer (instant)  2) confident in-region LLM coords (instant,
        # avoids the network)  3) Nominatim (slow, rate-limited)  4) centroid.
        hit = self.lookup_local(loc, region)
        if not hit and in_region_bbox(sighting.get("lat"), sighting.get("lon")):
            hit = {"lat": sighting["lat"], "lon": sighting["lon"], "source": "llm",
                   "name": loc, "region": region}
        if not hit and allow_nominatim and not neg:
            q = f"{loc}, {region}" if region else loc
            hit = self._nominatim(q)
            if not hit:  # remember the miss so we don't re-query it every run
                with self._lock:
                    self.negative.add(cache_key)
        if not hit:
            hit = self.lookup_region(region)
        # Region sanity: a town >450 km from its oblast centroid is the wrong namesake.
        if hit and hit["source"] in ("nominatim", "llm") and region:
            rc = self.lookup_region(region)
            if rc and haversine_km(hit["lat"], hit["lon"], rc["lat"], rc["lon"]) > 450:
                hit = rc

        result = None
        if hit:
            # A district/raion/oblast name is an area → region precision, so the
            # map shades it as a zone rather than pretending to a single point.
            area = hit["source"] == "gazetteer-region" or is_area_name(loc) or is_area_name(hit.get("name"))
            result = {"lat": hit["lat"], "lon": hit["lon"], "source": hit["source"],
                      "matchedName": hit.get("name") or loc,
                      "region": hit.get("region") or region,
                      "precision": "region" if area else "point"}
        with self._lock:
            self.cache[cache_key] = result
        return result


# --------------------------------------------------------------------------- #
# Telegram public preview scraping
# --------------------------------------------------------------------------- #
_ENTITY = {"&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
           "&nbsp;": " ", "&amp;": "&"}


def decode_entities(s):
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), s)
    s = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), s)
    for k, v in _ENTITY.items():
        s = s.replace(k, v)
    return s


def html_to_text(html):
    if not html:
        return ""
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    html = re.sub(r"</(p|div)>", "\n", html, flags=re.I)
    txt = re.sub(r"<[^>]+>", "", html)
    lines = [l.strip() for l in decode_entities(txt).split("\n")]
    out = []
    for i, l in enumerate(lines):
        if l == "" and i > 0 and lines[i - 1] == "":
            continue
        out.append(l)
    return "\n".join(out).strip()


def parse_preview(html, channel):
    messages = {}
    if not html:
        return []
    anchors = [(m.group(1), m.start()) for m in re.finditer(r'data-post="([^"]+)"', html)]
    for i, (data_post, idx) in enumerate(anchors):
        end = anchors[i + 1][1] if i + 1 < len(anchors) else len(html)
        block = html[idx:end]
        try:
            post_num = int(data_post.split("/")[-1])
        except ValueError:
            continue
        tm = re.search(r'<div class="[^"]*js-message_text[^"]*"[^>]*>([\s\S]*?)</div>', block)
        text = html_to_text(tm.group(1)) if tm else ""
        dm = re.search(r'<time[^>]*datetime="([^"]+)"', block)
        date = dm.group(1) if dm else None
        has_photo = bool(re.search(r"tgme_widget_message_photo_wrap|message_video|message_roundvideo", block))
        if not text and not has_photo:
            continue
        prev = messages.get(post_num)
        if prev is None or (not prev["text"] and text):
            messages[post_num] = {"id": f"{channel}/{post_num}", "postId": post_num,
                                  "channel": channel, "link": f"https://t.me/{channel}/{post_num}",
                                  "text": text, "date": date}
    return sorted(messages.values(), key=lambda m: m["postId"])


def fetch_channel(channel, before_id=None, timeout=15):
    url = "https://t.me/s/" + urllib.parse.quote(channel)
    if before_id:
        url += f"?before={before_id}"
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9,ru;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        html = r.read().decode("utf-8", "replace")
    return parse_preview(html, channel)


# --------------------------------------------------------------------------- #
# Heuristic fallback parser (deterministic; Russian + Ukrainian)
# --------------------------------------------------------------------------- #
DRONE_RE = re.compile(r"бпла|дрон|беспилотн|безпілотн|шахед|шахід|мопед|fpv", re.I)
MISSILE_RE = re.compile(r"ракет|крылат|крилат|баллист|балістич", re.I)
# Crewed aircraft: jets, bombers, helicopters, and named types (МиГ/Су/Ту).
AIRCRAFT_RE = re.compile(
    r"авиац|авіац|самол[еёо]т|літак|бомбардир|истребител|винищувач|штурмовик|"
    r"вертол[еёі]т|гелікоптер|тактичн\w*\s*авіац|\bбортов|ми[гj]-?\s?\d|су-?\s?\d|ту-?\s?\d|"
    r"\bmig-?\d|\bsu-?\d|kinzhal|кинжал|кинджал", re.I)
# Any aerial-threat signal (threat type OR a threat status word). A post with
# none of these can't be a mappable sighting, so we skip the LLM for it.
THREAT_ANY_RE = re.compile(
    r"бпла|дрон|беспилотн|безпілотн|шахед|шахід|мопед|fpv|ракет|крылат|крилат|баллист|балістич|"
    r"авиац|авіац|самол[еёо]т|літак|вертол[её]т|ми[гj]-?\d|су-?\d|ту-?\d|kinzhal|кинжал|"
    r"отбой|відбій|тревог|тривог|опасн|загроз|угроз|прил[её]т|приліт|вибух|влучан|пво|ппо", re.I)
REGION_RE = re.compile(r"(област|край|краю|республик|округ|\bА[РP]\b)", re.I)
FOOTER_RE = re.compile(r"(радар по всей|обход белых|@\w|https?:|t\.me|подписат|бот[аы]?\b)", re.I)
PHRASE_RE = re.compile(r"(бпла|дрон|беспилотн|безпілотн|шахед|fpv|опасн|сбит|збит|пво|ппо|отбой|"
                       r"відбій|мер[аы]\s+безопасн|фиксац|работа|повторно|ракет|угроз|загроз|"
                       r"внимание|увага|тревог|тривог)", re.I)


def detect_status(text):
    t = text.lower()
    if re.search(r"отбой|відбій", t):
        return "all_clear"
    if re.search(r"(прил[её]т|приліт|взрыв|вибух[иів]*|поврежд|попадан|влучан|удар(?!н))", t):
        return "impact"
    if re.search(r"(сбит|уничтож|пораж|збит|збил|знищ)", t):
        return "shot_down"
    if re.search(r"(работа\s+пво|пво\s+работа|работает\s+пво|отражени|робот[а-яёіїєґ]*\s+ппо|ппо\s+прац|відбива)", t):
        return "overhead"
    if re.search(r"(опасн|угроз|тревог|тривог|загроз)", t):
        return "alert"
    if re.search(r"(в сторону|в направлени|курс|лет(?:ят|ит|еть|ел|ить)\s+на|движ|приближ|"
                 r"зафіксован|виявлен|фиксац|пересека|руха|прямую|проліта|у напрямку|в бік|"
                 r"прямують|detected)", t):
        return "approaching"
    return "unknown"


def detect_count(text):
    m = re.search(r"(?:від|от)\s+(\d{1,4})\s*(?:бпла|дрон\w*|беспилотн|безпілотн\w*|шахед\w*|об'єкт\w*|ціл\w*|fpv)", text, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d{1,4})\s*(?:бпла|дрон[ів]*|беспилотн|безпілотн\w*|шахед[ів]*|об'єкт[ів]*|ціл[ей]*|fpv)", text, re.I)
    return int(m.group(1)) if m else None


def detect_destination(text):
    m = re.search(
        r"(?:в\s+сторону|в\s+направлении|у\s+напрямку|в\s+бік|курс[а-яёіїєґ]*\s+на|"
        r"лет(?:ят|ит|еть|ел|ить)\s+на|летить\s+(?:у\s+напрямку\s+)?(?:на|до)|"
        r"направля[а-яёіїєґ]*\s+на|прямую[а-яёіїєґ]*\s+на|рухаються?\s+(?:у\s+напрямку\s+)?(?:на|до)|"
        r"прямують?\s+(?:на|до))\s+([А-ЯЁІЇЄҐ][а-яёіїєґ'ʼ'-]+(?:\s+[А-ЯЁІЇЄҐ][а-яёіїєґ'ʼ'-]+)?)", text)
    return m.group(1) if m else None


def detect_threat_type(text):
    if DRONE_RE.search(text):
        return "drone"
    if AIRCRAFT_RE.search(text):
        return "aircraft"
    if MISSILE_RE.search(text):
        if re.search(r"крылат|крилат", text, re.I):
            return "cruise_missile"
        if re.search(r"баллист|балістич", text, re.I):
            return "ballistic_missile"
        return "missile"
    return "drone"


def clean_location(s):
    s = re.sub(r"^(МО|ГО|г\.|г|пгт|с\.|д\.|город|село|деревня|пос\.?)\s+", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


BLOCKED = {"russia", "russian federation", "ukraine", "belarus", "border", "frontline", "unknown",
           "various", "multiple", "na", "n/a", "россия", "российская федерация", "украина",
           "беларусь", "граница", "неизвестно"}


def is_blocked_location(name):
    k = re.sub(r"[.,\"'»«]", "", (name or "").lower().replace("ё", "е")).strip()
    if not k or k in BLOCKED:
        return True
    return bool(re.search(r"(^|\s)(море|sea|ocean|океан|залив|gulf|bay)(\s|$)", k))


def is_interception_recap(text):
    if not text:
        return False
    t = text.lower()
    if not re.search(r"(уничтожен|сбит|перехвач|ликвидир|отражен|destroyed|intercepted|shot down)", t):
        return False
    m = re.search(r"(\d{1,4})\s*(?:бпла|дрон\w*|безпілотн\w*|шахед\w*|uav|drone)", t) or \
        re.search(r"(?:уничтожен\w*|сбит\w*|перехвач\w*|destroyed|intercepted)\D{0,14}(\d{1,4})", t)
    total = int(m.group(1)) if m else 0
    times = len(re.findall(r"\b\d{1,2}[:.]\d{2}\b", t))
    recap = bool(re.search(r"над\s+территор|over the territ|минобороны|ministry of def|"
                           r"за\s+(минувш|прошедш|истекш|сутки|ночь|вчера|день)|over the past (night|day|24)", t)) or times >= 2
    return total >= 10 and recap


def is_place_like(c):
    return bool(re.match(r"^[А-ЯЁІЇЄҐA-Z]", c)) and len(c) <= 40 and len(c.split()) <= 4


def analyze_post(text):
    out = {"isRelevant": False, "summary": "", "sightings": []}
    if not text or (not DRONE_RE.search(text) and not MISSILE_RE.search(text) and not AIRCRAFT_RE.search(text)):
        return out
    if is_interception_recap(text):
        return out
    out["isRelevant"] = True
    threat = detect_threat_type(text)
    status = detect_status(text)
    count = detect_count(text)
    dest = detect_destination(text)

    chunks = []
    for line in text.split("\n"):
        line = line.strip()
        if not line or re.match(r"^[❗️🌐•▪️◾️\-—]", line) or FOOTER_RE.search(line):
            continue
        line = re.sub(r"\s[-–—:]\s.*$", "", line)
        for piece in line.split(","):
            c = piece.strip()
            if c and not PHRASE_RE.search(c) and is_place_like(c):
                chunks.append(c)

    region = ""
    for c in reversed(chunks):
        if REGION_RE.search(c):
            region = c
            break

    seen = set()
    locations = []
    for c in chunks:
        if c == region or REGION_RE.search(c):
            continue
        cl = clean_location(c)
        if cl and not is_blocked_location(cl) and cl not in seen:
            seen.add(cl)
            locations.append(cl)
    if not locations and region and not is_blocked_location(region):
        locations = [clean_location(region)]
    if not locations:
        return out

    per_count = count if len(locations) == 1 else None
    for loc in locations:
        out["sightings"].append({
            "location": loc, "locationRu": loc, "region": region or "", "lat": None, "lon": None,
            "threatType": threat, "count": per_count, "heading": None, "destination": dest or None,
            "status": status, "confidence": 0.55})
    label = {"drone": "Drone", "aircraft": "Aircraft"}.get(threat, "Missile")
    out["summary"] = f"{label} activity ({status}) at {', '.join(locations)}"[:300]
    return out


# --------------------------------------------------------------------------- #
# Ollama client (schema-enforced structured output + verification pass)
# --------------------------------------------------------------------------- #
SYSTEM_PROMPT = """You are an OSINT analyst that reads short posts (in Russian OR Ukrainian) from Telegram channels that track aerial threats (UAVs/drones including "Shahed"/"шахед"/"шахід", cruise missiles, ballistic missiles) over the Russian Federation and Ukraine.
Sources: @radarrussiia (Russian, threats over Russia) and @kpszsu (Ukrainian Air Force, reporting Russian drone/missile strikes on Ukraine). Handle both Russian and Ukrainian wording, and extract Ukrainian place names (e.g. Київ->Kyiv, Харків->Kharkiv, Одеса->Odesa) the same way.

For the given post, extract EVERY distinct geographic sighting/threat mentioned. A single post can contain several locations, and sometimes several SEPARATE objects.

Return STRICT JSON only matching the given schema.

Rules:
- If the post is not about an aerial threat (ads, chat, unrelated news), set is_relevant=false and sightings=[].
- RECAP TOTALS: a Ministry-of-Defense-style summary of totals over a period (e.g. "over the past night air defense destroyed 216 UAVs over Belgorod, Bryansk, Kursk oblasts") is NOT a specific sighting -> is_relevant=false, sightings=[].
- THREAT TYPE — read carefully and classify EACH sighting by its OWN type: drones/Shaheds/FPV/БПЛА/БпЛА/шахед/герань/безпілотник -> "drone"; crewed aircraft (авиация/самолёт/літак/бомбардировщик/истребитель, helicopters вертолёт, and named jets МиГ/Су/Ту, MiG-31/Kinzhal carriers) -> "aircraft"; cruise missiles (крылатая/крилата ракета, Калибр/Х-101/Х-555) -> "cruise_missile"; ballistic (баллистическая/балістична, Искандер/Iskander/КАБ) -> "ballistic_missile"; other rockets/missiles -> "missile". A MISSILE OR ROCKET IS NEVER A DRONE and a drone is never a missile — never merge the two. If one post mentions both a drone and a missile, they are DIFFERENT objects with different threat_type.
- OBJECT GROUPING (object_id) — a single post often tracks ONE group of objects as it crosses several towns ("БПЛА через Курск, курсом на Орёл"). Give every sighting that belongs to the SAME physical object/group the SAME integer object_id (1, 2, 3…), in the order it travels. Give a DIFFERENT object_id to any separate object — a different drone group, or a missile mentioned alongside drones. Two sightings only share an object_id if the post says they are the same thing moving. When unsure, use a new object_id rather than merging.
- NEVER use a sea, body of water, or whole country as a location. Only real settlements, raions, oblasts, or airbases.
- Prefer the most specific place mentioned. If only a region is given, use the region as the location.
- MOVEMENT: "destination" = the PLACE NAME the threat is moving toward (English), from "курс на X", "в сторону X", "в напрямку X". Prefer the ultimate major target (a city or oblast) over small waypoint villages. "heading" = compass direction ONLY, exactly one of: north, north-east, east, south-east, south, south-west, west, north-west; else null. Never put place names in heading.
- Do NOT create a separate sighting for the destination a threat is heading TOWARD. Only output a sighting for a place where the threat currently is, was seen, or is passing through.
- COUNT: number of objects for a SINGLE place ("Фиксация от N БПЛА", "N дронов") -> count=N; a single total over MANY regions -> count=null everywhere.
- STATUS mapping: отбой/відбій->all_clear; опасность/угроза/тревога/тривога->alert; сбит/збито/знищено->shot_down; работа ПВО/ППО/відбиваємо->overhead; фиксация/летят/в сторону/курсом на/рухаються->approaching; прилёт/взрыв/приліт/вибух/влучання->impact; else unknown.
- Only fill lat/lon when genuinely confident; otherwise null.
- Never invent locations or directions not in the post. Output JSON only."""

TRANSLATE_PROMPT = ("You are a professional translator. Translate the user's message (written in "
                    "Russian or Ukrainian) into clear, natural English. Preserve place names as their "
                    "common English spellings. Output ONLY the English translation — no notes, no quotes, "
                    "no original text.")

VERIFY_PROMPT = """You are a strict OSINT fact-checker. You are given a Telegram post (Russian or Ukrainian) and a JSON extraction from it.
Re-read the POST carefully and output a CORRECTED extraction with the same schema:
- DELETE any sighting whose location is not actually in the post (hallucinations), or that is a sea/whole country, or that merely duplicates a DESTINATION a threat is heading toward.
- FIX any wrong field: count must appear in the post for that exact place; status must match the wording (отбой->all_clear, сбит/збито->shot_down, прилёт/вибух->impact, работа ПВО/ППО->overhead, опасность/тривога->alert, фиксация/курс/летять->approaching); destination is the place moved TOWARD or null.
- FIX threat_type: a missile/rocket must NEVER be labelled "drone" and vice-versa — classify each object by its own wording. FIX object_id: sightings of the SAME moving group share one object_id; a separate drone group or a missile mentioned alongside drones gets a DIFFERENT object_id.
- If a sighting is correct, keep it. If the post is not a specific aerial threat over identifiable places, set is_relevant=false and sightings=[].
- Lower confidence when unsure; raise it for clear sightings. Output JSON only."""

SCHEMA = {
    "type": "object",
    "properties": {
        "is_relevant": {"type": "boolean"},
        "summary": {"type": "string"},
        "sightings": {"type": "array", "items": {"type": "object", "properties": {
            "location": {"type": "string"}, "location_ru": {"type": "string"},
            "region": {"type": "string"}, "lat": {"type": ["number", "null"]},
            "lon": {"type": ["number", "null"]},
            "threat_type": {"type": "string", "enum": ["drone", "aircraft", "missile", "cruise_missile",
                            "ballistic_missile", "explosion", "air_defense", "unknown"]},
            "object_id": {"type": ["integer", "null"]},
            "count": {"type": ["integer", "null"]},
            "heading": {"type": ["string", "null"], "enum": ["north", "north-east", "east",
                        "south-east", "south", "south-west", "west", "north-west", None]},
            "destination": {"type": ["string", "null"]},
            "status": {"type": "string", "enum": ["approaching", "overhead", "shot_down", "impact",
                       "alert", "all_clear", "unknown"]},
            "confidence": {"type": "number"}},
            "required": ["location", "threat_type", "status", "confidence"]}},
    },
    "required": ["is_relevant", "summary", "sightings"],
}

THREAT_TYPES = {"drone", "aircraft", "missile", "cruise_missile", "ballistic_missile", "explosion", "air_defense", "unknown"}
STATUSES = {"approaching", "overhead", "shot_down", "impact", "alert", "all_clear", "unknown"}


def extract_json_object(text):
    if not text:
        return None
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*```$", "", s)
    start = s.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(s[start:i + 1])
                except Exception:
                    return None
    return None


def normalize_extraction(raw):
    out = {"isRelevant": False, "summary": "", "sightings": []}
    if not isinstance(raw, dict):
        return out
    out["isRelevant"] = bool(raw.get("is_relevant"))
    out["summary"] = str(raw.get("summary", ""))[:300]
    for s in (raw.get("sightings") or []):
        if not isinstance(s, dict):
            continue
        loc = str(s.get("location") or s.get("location_ru") or "").strip()
        if not loc:
            continue
        lat = s.get("lat") if isinstance(s.get("lat"), (int, float)) else None
        lon = s.get("lon") if isinstance(s.get("lon"), (int, float)) else None
        conf = s.get("confidence")
        out["sightings"].append({
            "location": loc, "locationRu": str(s.get("location_ru") or "").strip(),
            "region": str(s.get("region") or "").strip(),
            "lat": lat if (lat is not None and abs(lat) <= 90) else None,
            "lon": lon if (lon is not None and abs(lon) <= 180) else None,
            "threatType": s.get("threat_type") if s.get("threat_type") in THREAT_TYPES else "unknown",
            "objectId": s.get("object_id") if isinstance(s.get("object_id"), int) else None,
            "count": s.get("count") if isinstance(s.get("count"), int) else None,
            "heading": str(s["heading"]).strip() if s.get("heading") else None,
            "destination": str(s["destination"]).strip() if s.get("destination") else None,
            "status": s.get("status") if s.get("status") in STATUSES else "unknown",
            "confidence": max(0.0, min(1.0, conf)) if isinstance(conf, (int, float)) else 0.5})
    return out


def denormalize(ex):
    return {"is_relevant": ex["isRelevant"], "summary": ex["summary"],
            "sightings": [{"location": s["location"], "location_ru": s["locationRu"],
                           "region": s["region"], "lat": s["lat"], "lon": s["lon"],
                           "threat_type": s["threatType"], "object_id": s.get("objectId"),
                           "count": s["count"],
                           "heading": s["heading"], "destination": s["destination"],
                           "status": s["status"], "confidence": s["confidence"]}
                          for s in ex["sightings"]]}


class OllamaClient:
    def __init__(self):
        self.url = CONFIG["ollama_url"]
        self.model = CONFIG["ollama_model"]
        self.verify = CONFIG["verify"]

    def _chat(self, messages, timeout, fmt=SCHEMA, num_predict=None):
        opts = {"temperature": 0, "num_ctx": 4096}
        if num_predict:
            opts["num_predict"] = num_predict
        # keep_alive keeps the model resident between calls so we don't pay the
        # multi-second reload cost on every extraction / translation.
        payload = {"model": self.model, "messages": messages, "stream": False,
                   "keep_alive": "30m", "options": opts}
        if fmt is not None:
            payload["format"] = fmt
        body = json.dumps(payload).encode()
        req = urllib.request.Request(self.url + "/api/chat", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
        return (data.get("message") or {}).get("content", "")

    def _chat_json(self, messages, timeout):
        parsed = extract_json_object(self._chat(messages, timeout))
        if parsed is None:
            raise ValueError("ollama returned no parseable JSON")
        return parsed

    def translate(self, text, timeout=60):
        """Translate a Russian/Ukrainian post to English (free text)."""
        # Cap output so the model stops promptly (posts are short) — a big
        # latency win vs letting a 12B model ramble to its default limit.
        out = self._chat(
            [{"role": "system", "content": TRANSLATE_PROMPT},
             {"role": "user", "content": text}],
            timeout, fmt=None, num_predict=256)
        return (out or "").strip()

    def extract(self, post, verify=None):
        do_verify = self.verify if verify is None else verify
        user = (f"Post date: {post.get('date') or 'unknown'}\nPost link: {post.get('link') or 'unknown'}"
                f"\n\nPost text:\n\"\"\"\n{post.get('text') or ''}\n\"\"\"")
        first = normalize_extraction(self._chat_json(
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
            CONFIG["llm_timeout"]))
        if not do_verify or not first["isRelevant"] or not first["sightings"]:
            return first
        try:
            return normalize_extraction(self._chat_json(
                [{"role": "system", "content": VERIFY_PROMPT},
                 {"role": "user", "content": user + "\n\nFirst-pass extraction to check:\n"
                  + json.dumps(denormalize(first), ensure_ascii=False)}], CONFIG["llm_timeout"]))
        except Exception:
            return first

    def ping(self):
        try:
            req = urllib.request.Request(self.url + "/api/tags")
            with urllib.request.urlopen(req, timeout=4) as r:
                return r.status == 200
        except Exception:
            return False

    def has_model(self):
        try:
            req = urllib.request.Request(self.url + "/api/tags")
            with urllib.request.urlopen(req, timeout=6) as r:
                models = [m.get("name", "") for m in json.load(r).get("models", [])]
            base = self.model.split(":")[0]
            return any(m == self.model or m.split(":")[0] == base for m in models), models
        except Exception:
            return False, []


# --------------------------------------------------------------------------- #
# Enrichment + track correlation
# --------------------------------------------------------------------------- #
VALID_HEADINGS = {"north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"}


def normalize_direction(s):
    if not s.get("heading"):
        return s
    h = s["heading"].lower().strip()
    if h.replace(" ", "-") in VALID_HEADINGS:
        return s
    if not s.get("destination"):
        m = re.match(r"^towards?\s+(.+)", h)
        if m:
            idx = s["heading"].lower().find(m.group(1))
            s["destination"] = s["heading"][idx:].split(",")[0].strip()
    s["heading"] = None
    return s


def dest_from_heading(heading):
    if not heading:
        return ""
    m = re.match(r"^\s*towards?\s+(.+)", str(heading), re.I)
    return m.group(1).split(",")[0].strip() if m else ""


def strip_region_word(k):
    return re.sub(r"\s+(oblast|region|raion|district|krai|republic|область|области|округ|край)$", "", k).strip()


def drop_destination_echoes(sightings):
    by_post = {}
    for s in sightings:
        key = f"{s.get('channel', '')}/{s['postId']}" if s.get("postId") is not None else s["id"]
        by_post.setdefault(key, []).append(s)
    drop = set()
    for group in by_post.values():
        if len(group) < 2:
            continue
        for a in group:
            a_loc = normalize_key(a["location"])
            if not a_loc:
                continue
            a_bare = strip_region_word(a_loc)
            for b in group:
                if a is b:
                    continue
                b_dest = normalize_key(b.get("destination") or dest_from_heading(b.get("heading")))
                if b_dest and (b_dest == a_loc or b_dest == a_bare):
                    drop.add(a["id"])
                    break
    return [s for s in sightings if s["id"] not in drop]


def backfill_from_heuristic(sightings, heur):
    if not heur or not heur["isRelevant"] or not heur["sightings"]:
        return
    hc = heur["sightings"][0]["count"]
    hs = heur["sightings"][0]["status"]
    single = len(sightings) == 1
    for s in sightings:
        if single and s.get("count") is None and hc is not None:
            s["count"] = hc
        if (not s.get("status") or s["status"] == "unknown") and hs and hs != "unknown":
            s["status"] = hs


def strip_summary_counts(sightings):
    if len(sightings) < 3:
        return
    counts = [s["count"] for s in sightings if isinstance(s.get("count"), int)]
    if len(counts) >= 3 and len(set(counts)) == 1 and counts[0] >= 10:
        for s in sightings:
            s["count"] = None


def resolve_movement(sighting, geo, geocoder):
    destination = sighting.get("destination") or None
    d_lat = d_lon = bearing = None
    if destination:
        dg = geocoder.resolve({"location": destination, "region": ""})
        if dg and in_region_bbox(dg["lat"], dg["lon"]):
            d_lat, d_lon = dg["lat"], dg["lon"]
            bearing = bearing_between(geo["lat"], geo["lon"], dg["lat"], dg["lon"])
    if bearing is None:
        bearing = heading_to_bearing(sighting.get("heading"))
    return destination, d_lat, d_lon, bearing


# ---- track builder (port of tracks.js) ----
# Chain reports into ONE object's flight path. A track only links reports from
# the SAME source channel (so a Ukrainian sighting is never joined to a Russian
# one), that keep a consistent heading (no zig-zagging between different drones),
# at a plausible speed, and it needs 3+ waypoints to be drawn (no straight
# 2-point bars). The result is a per-drone path, not a merge of unrelated stuff.
TRACK_CFG = {"maxLegKm": 280, "maxGapMin": 55, "maxSpeedKmh": 300, "maxTurnDeg": 75,
             "minPointKm": 8, "minPoints": 3}
# Jets cover far more ground between reports than a Shahed; cruise missiles are
# in between. Per-class overrides for the distance/speed caps.
CLASS_CAPS = {
    "aircraft": {"maxLegKm": 700, "maxSpeedKmh": 1500},
    "missile": {"maxLegKm": 450, "maxSpeedKmh": 1100},
}
POSITION_STATUSES = {"approaching", "overhead", "unknown"}
TERMINAL_STATUSES = {"shot_down", "impact"}


def threat_class(t):
    if t == "drone":
        return "drone"
    if t == "aircraft":
        return "aircraft"
    if t in ("missile", "cruise_missile", "ballistic_missile"):
        return "missile"
    return "other"


def track_code(first_time, first_loc):
    """Stable 5-digit AO#<code> for a track (radar-style object id)."""
    h = 2166136261
    for ch in (str(first_time) + "|" + str(first_loc)):
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return "AO#" + str(10000 + (h % 90000))


def track_speed_kmh(points):
    """Estimated speed over the last few legs (km/h), or None if unreliable."""
    if len(points) < 2:
        return None
    recent = points[-4:]
    dist = sum(haversine_km(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"])
               for i in range(1, len(recent)))
    hrs = (recent[-1]["t"] - recent[0]["t"]) / 3600000
    if hrs < 1 / 60:   # under a minute apart → timing too coarse to trust
        return None
    v = dist / hrs
    return round(v) if 0 < v <= 3000 else None


def angle_diff(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def is_trackable(s):
    if not isinstance(s.get("lat"), (int, float)) or not isinstance(s.get("lon"), (int, float)):
        return False
    if not parse_iso(s.get("timestamp")):
        return False
    if s.get("geocodePrecision") == "region":
        return False
    st = s.get("status") or "unknown"
    return st in POSITION_STATUSES or st in TERMINAL_STATUSES


def build_tracks(sightings):
    pts = sorted(
        ({"lat": s["lat"], "lon": s["lon"], "t": parse_iso(s["timestamp"]), "time": s["timestamp"],
          "location": s.get("location", ""), "status": s.get("status", "unknown"),
          "count": s.get("count") if isinstance(s.get("count"), int) else None,
          "channel": s.get("channel", ""), "cls": threat_class(s.get("threatType")),
          # Which source post + which object the AI said this is, so two objects
          # the AI separated inside one post are never chained together.
          "post": s.get("postId"), "obj": s.get("objectId")}
         for s in sightings if is_trackable(s)),
        key=lambda p: p["t"])
    tracks = []
    nid = 1
    for p in pts:
        caps = CLASS_CAPS.get(p["cls"], TRACK_CFG)
        max_leg = caps.get("maxLegKm", TRACK_CFG["maxLegKm"])
        max_speed = caps.get("maxSpeedKmh", TRACK_CFG["maxSpeedKmh"])
        best, best_dist = None, float("inf")
        for trk in tracks:
            # One track = one object from one source: never join across channels
            # (e.g. a Ukrainian @kpszsu sighting to a Russian @radarrussiia one).
            if trk["ended"] or trk["cls"] != p["cls"] or trk["channel"] != p["channel"]:
                continue
            last = trk["points"][-1]
            # Same source post but a DIFFERENT object the AI separated → these are
            # two distinct objects, never one track (a missile ≠ the drones next
            # to it, drone group #1 ≠ drone group #2). Same object_id → the AI
            # read them as one thing's path, so trust it and skip the geometry
            # sanity checks below.
            same_post = last.get("post") is not None and last.get("post") == p.get("post")
            if same_post and last.get("obj") != p.get("obj"):
                continue
            same_obj = same_post and last.get("obj") is not None and last.get("obj") == p.get("obj")
            dt = (p["t"] - last["t"]) / 60000
            if dt < 0 or dt > TRACK_CFG["maxGapMin"]:
                continue
            d = haversine_km(last["lat"], last["lon"], p["lat"], p["lon"])
            if d > max_leg:
                continue
            if d >= TRACK_CFG["minPointKm"] and not same_obj:
                if dt > 2 and (d / (dt / 60)) > max_speed:
                    continue
                if len(trk["points"]) >= 2:
                    prev = trk["points"][-2]
                    lp = bearing_between(prev["lat"], prev["lon"], last["lat"], last["lon"])
                    ln = bearing_between(last["lat"], last["lon"], p["lat"], p["lon"])
                    if angle_diff(lp, ln) > TRACK_CFG["maxTurnDeg"]:
                        continue
            if d < best_dist:
                best_dist, best = d, trk
        if best is not None:
            last = best["points"][-1]
            if best_dist < TRACK_CFG["minPointKm"]:
                last["t"], last["time"], last["status"] = p["t"], p["time"], p["status"]
                if p["count"] is not None:
                    last["count"] = p["count"]
            else:
                best["points"].append(p)
            if p["status"] in TERMINAL_STATUSES:
                best["ended"] = True
        else:
            tracks.append({"id": f"trk-{nid}", "cls": p["cls"], "channel": p["channel"],
                           "points": [p], "ended": p["status"] in TERMINAL_STATUSES})
            nid += 1
    out = []
    for t in tracks:
        if len(t["points"]) < TRACK_CFG["minPoints"]:  # 3+ waypoints = a real path
            continue
        dist = sum(haversine_km(t["points"][i - 1]["lat"], t["points"][i - 1]["lon"],
                                t["points"][i]["lat"], t["points"][i]["lon"])
                   for i in range(1, len(t["points"])))
        out.append({"id": t["id"], "threatClass": t["cls"], "channel": t.get("channel", ""),
                    "code": track_code(t["points"][0]["time"], t["points"][0]["location"]),
                    "speedKmh": track_speed_kmh(t["points"]),
                    "points": [{"lat": round(p["lat"], 4), "lon": round(p["lon"], 4), "time": p["time"],
                                "location": p["location"], "status": p["status"], "count": p["count"]}
                               for p in t["points"]],
                    "firstSeen": t["points"][0]["time"], "lastSeen": t["points"][-1]["time"],
                    "ended": t["ended"], "distanceKm": round(dist)})
    return out


# --------------------------------------------------------------------------- #
# Store + pipeline
# --------------------------------------------------------------------------- #
# Set in main(); lets the HTTP handler reach the pipeline for /api/translate.
PIPELINE = None
_translate_cache = {}
_translate_lock = threading.Lock()


class Store:
    def __init__(self):
        self.by_id = {}
        self.last_post_id = {}
        self.lock = threading.Lock()

    def add(self, s):
        with self.lock:
            self.by_id[s["id"]] = s

    def all(self):
        with self.lock:
            return sorted(self.by_id.values(), key=lambda s: parse_iso(s.get("timestamp")))

    def count(self):
        with self.lock:
            return len(self.by_id)

    def set_last(self, channel, pid):
        with self.lock:
            if pid > self.last_post_id.get(channel, 0):
                self.last_post_id[channel] = pid

    def get_last(self, channel):
        return self.last_post_id.get(channel, 0)

    def prune(self, hours):
        cutoff = now_ms() - hours * 3600 * 1000
        with self.lock:
            for k in [k for k, s in self.by_id.items() if parse_iso(s.get("timestamp")) and parse_iso(s["timestamp"]) < cutoff]:
                del self.by_id[k]

    def load(self, sightings, last_post_id):
        with self.lock:
            for s in sightings or []:
                if s.get("id"):
                    self.by_id[s["id"]] = s
            self.last_post_id.update(last_post_id or {})


class Pipeline:
    def __init__(self, store, geocoder, llm):
        self.store = store
        self.geocoder = geocoder
        self.llm = llm
        self.use_llm = True
        self.updated_at = None

    def process_post(self, post, verify=None):
        text = post.get("text", "")
        # Fast path: a post with no aerial-threat keyword at all is never a
        # sighting — skip the (expensive) model call entirely.
        if CONFIG["llm_prefilter"] and not THREAT_ANY_RE.search(text):
            return []
        if is_interception_recap(text):
            return []
        heur = analyze_post(text)
        extraction = None
        if self.use_llm:
            try:
                extraction = self.llm.extract(post, verify=verify)
            except Exception as e:
                log(f"  llm extract failed for {post['postId']}: {e}")
        if (not extraction or not extraction["isRelevant"] or not extraction["sightings"]) and \
                heur["isRelevant"] and heur["sightings"]:
            extraction = heur
        if not extraction or not extraction["isRelevant"] or not extraction["sightings"]:
            return []

        backfill_from_heuristic(extraction["sightings"], heur)
        strip_summary_counts(extraction["sightings"])
        # Bulk-backfill of old posts skips the 1-req/sec Nominatim lookups
        # (gazetteer + LLM coords + region centroid only) so history loads fast;
        # recent posts and live polling still geocode precisely.
        age_h = (now_ms() - parse_iso(post.get("date"))) / 3600000 if post.get("date") else 0
        allow_nominatim = age_h <= CONFIG["nominatim_recent_hours"]
        created = []
        for i, s in enumerate(extraction["sightings"]):
            if is_blocked_location(s["location"]):
                continue
            s = normalize_direction(s)
            geo = self.geocoder.resolve(s, allow_nominatim=allow_nominatim)
            if not geo:
                continue
            # We no longer draw destination arrows, so don't spend a network
            # geocode on the destination — keep the name + a cheap heading only.
            destination = s.get("destination") or None
            bearing = heading_to_bearing(s.get("heading"))
            d_lat = d_lon = None
            sighting = {
                "id": f"{post['channel']}-{post['postId']}-{i}", "channel": post["channel"],
                "postId": post["postId"], "postLink": post["link"], "postDate": post.get("date"),
                "postText": (post.get("text") or "")[:400], "summary": extraction["summary"],
                "timestamp": post.get("date") or iso_now(),
                "location": geo["matchedName"], "locationRu": s.get("locationRu", ""),
                "region": geo["region"] or s.get("region", ""), "lat": geo["lat"], "lon": geo["lon"],
                "geocodeSource": geo["source"], "geocodePrecision": geo["precision"],
                "threatType": s["threatType"], "objectId": s.get("objectId"),
                "count": s.get("count"), "heading": s.get("heading"),
                "destination": destination, "destinationLat": d_lat, "destinationLon": d_lon,
                "bearing": bearing, "status": s["status"], "confidence": s["confidence"]}
            self.store.add(sighting)
            created.append(sighting)
        return created

    def fetch_history(self, channel, since_ms, max_pages, progress):
        posts = fetch_channel(channel)
        pages = 1
        while pages < max_pages and posts:
            with_date = [p for p in posts if p.get("date")]
            oldest = parse_iso(with_date[0]["date"]) if with_date else None
            if oldest is not None and oldest <= since_ms:
                break
            before = posts[0]["postId"]
            try:
                older = fetch_channel(channel, before_id=before)
            except Exception as e:
                log(f"  paginate @{channel} before={before} failed: {e}")
                break
            fresh = [p for p in older if p["postId"] < before]
            if not fresh:
                break
            posts = fresh + posts
            pages += 1
            progress("fetch", channel, pages, len(posts), 0, 0, 0)
        return [p for p in posts if parse_iso(p.get("date")) >= since_ms or not p.get("date")], pages

    def _verify_for(self, post):
        # During bulk backfill, only spend the extra verification call on recent
        # posts (current threats); let old history load single-pass and fast.
        if not CONFIG["verify"]:
            return False
        age_h = (now_ms() - parse_iso(post.get("date"))) / 3600000 if post.get("date") else 0
        return age_h <= CONFIG["verify_recent_hours"]

    def backfill(self, progress):
        hours = CONFIG["backfill_hours"]
        since = now_ms() - hours * 3600 * 1000
        channels = CONFIG["channels"]

        # Fetch every channel's history in parallel — 3 channels paginating at
        # once instead of one after another.
        tasks = []

        def gather(channel):
            posts, pages = self.fetch_history(channel, since, CONFIG["backfill_max_pages"], progress)
            last = self.store.get_last(channel)
            fresh = [p for p in posts if p["postId"] > last and (p.get("text") or "").strip()]
            progress("fetched", channel, pages, len(posts), 0, len(fresh), 0)
            return fresh

        with ThreadPoolExecutor(max_workers=max(1, len(channels))) as ex:
            futs = {ex.submit(gather, ch): ch for ch in channels}
            for fut in as_completed(futs):
                try:
                    tasks.extend(fut.result())
                except Exception as e:
                    log(f"backfill @{futs[fut]} failed: {e}")

        total = len(tasks)
        log(f"backfill: {total} post(s) to analyze (x{CONFIG['concurrency']})")
        if not total:
            progress("done", "", 0, 0, 0, 0, 0)
            return

        # Newest first, so the current threat picture appears within seconds
        # while older history keeps filling in behind it.
        tasks.sort(key=lambda p: parse_iso(p.get("date")), reverse=True)
        done = 0
        sightings = 0
        counter_lock = threading.Lock()

        def run(post):
            nonlocal done, sightings
            created = self.process_post(post, verify=self._verify_for(post))
            self.store.set_last(post["channel"], post["postId"])
            with counter_lock:
                done += 1
                sightings += len(created)
                d, s = done, sightings
            if d % 4 == 0 or d == total:
                progress("extract", "", 0, 0, d, total, s)
                self.write_outputs()

        with ThreadPoolExecutor(max_workers=CONFIG["concurrency"]) as ex:
            list(as_completed([ex.submit(run, p) for p in tasks]))

        self.store.prune(CONFIG["history_hours"])
        self.write_outputs()
        self.persist()
        progress("done", "", 0, 0, total, total, sightings)
        log(f"backfill complete: +{sightings} sighting(s), {len(build_tracks(self.store.all()))} track(s)")

    def poll(self):
        channels = CONFIG["channels"]
        new = 0

        def gather(channel):
            posts = fetch_channel(channel)
            last = self.store.get_last(channel)
            return channel, [p for p in posts if p["postId"] > last and (p.get("text") or "").strip()][-CONFIG["max_new_posts"]:]

        fresh_all = []
        with ThreadPoolExecutor(max_workers=max(1, len(channels))) as ex:
            for fut in as_completed([ex.submit(gather, ch) for ch in channels]):
                try:
                    _ch, fresh = fut.result()
                    fresh_all.extend(fresh)
                except Exception as e:
                    log(f"poll fetch failed: {e}")

        if fresh_all:
            # Newest first + write incrementally, so a fresh position shows on
            # the map as soon as it's extracted instead of after the whole batch.
            fresh_all.sort(key=lambda p: parse_iso(p.get("date")), reverse=True)
            done = 0
            with ThreadPoolExecutor(max_workers=CONFIG["concurrency"]) as ex:
                results = {ex.submit(self.process_post, p): p for p in fresh_all}
                for fut in as_completed(results):
                    post = results[fut]
                    try:
                        created = fut.result()
                        new += len(created)
                        if created:
                            self.write_outputs()  # push the update immediately
                    except Exception as e:
                        log(f"poll extract failed for {post.get('postId')}: {e}")
                    self.store.set_last(post["channel"], post["postId"])
                    done += 1

        self.store.prune(CONFIG["history_hours"])
        self.write_outputs()
        self.persist()
        if new:
            log(f"poll: +{new} sighting(s)")
        return new

    def write_outputs(self):
        self.updated_at = iso_now()
        sightings = self.store.all()
        tracks = build_tracks(sightings)
        # Write atomically (tmp + replace) so the browser never reads half a file.
        for name, payload in (("sightings.json", {"sightings": sightings, "updatedAt": self.updated_at,
                                                   "backend": ("ollama:" + CONFIG["ollama_model"]) if self.use_llm else "heuristic"}),
                              ("tracks.json", {"tracks": tracks, "updatedAt": self.updated_at})):
            path = os.path.join(DATA_OUT, name)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp, path)

    def persist(self):
        """Save sightings + cursors + geocode cache so the next launch is instant."""
        try:
            tmp = STATE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"sightings": self.store.all(), "lastPostId": self.store.last_post_id,
                           "geocache": self.geocoder.dump_cache(),
                           "geocacheNeg": self.geocoder.dump_negatives(), "savedAt": iso_now()},
                          f, ensure_ascii=False)
            os.replace(tmp, STATE_FILE)
        except Exception as e:
            log(f"persist failed: {e}")

    def translate(self, text):
        """English translation of a post (cached). Falls back to the original.

        Goes straight to Ollama even when extraction fell back to the heuristic
        parser — as long as the model can chat it can translate, so the button
        keeps working regardless of which parser we chose for extraction."""
        text = (text or "").strip()
        if not text:
            return ""
        with _translate_lock:
            if text in _translate_cache:
                return _translate_cache[text]
        try:
            out = self.llm.translate(text) or text
        except Exception as e:
            log(f"translate failed: {e}")
            out = text
        with _translate_lock:
            _translate_cache[text] = out
        return out

    def prewarm_translations(self, limit=14):
        """Background: translate the newest warning posts so their popups open
        instantly. Runs off-thread; never blocks the pipeline."""
        if not self.use_llm:
            return
        warn = {"alert", "impact", "approaching", "overhead"}
        seen, todo = set(), []
        for s in sorted(self.store.all(), key=lambda x: parse_iso(x.get("timestamp")), reverse=True):
            t = (s.get("postText") or "").strip()
            if not t or s.get("status") not in warn or t in seen:
                continue
            with _translate_lock:
                if t in _translate_cache:
                    continue
            seen.add(t)
            todo.append(t)
            if len(todo) >= limit:
                break

        def run():
            for t in todo:
                try:
                    self.translate(t)
                except Exception:
                    pass
        if todo:
            threading.Thread(target=run, daemon=True).start()

    def restore(self):
        """Load the persisted cache; returns the number of sightings restored."""
        try:
            if not os.path.exists(STATE_FILE):
                return 0
            with open(STATE_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            log(f"restore failed: {e}")
            return 0
        self.store.load(data.get("sightings"), data.get("lastPostId"))
        self.geocoder.load_cache(data.get("geocache"), data.get("geocacheNeg"))
        self.store.prune(CONFIG["history_hours"])
        return self.store.count()


# --------------------------------------------------------------------------- #
# Progress → status.json (surfaced in the web UI)
# --------------------------------------------------------------------------- #
_status_lock = threading.Lock()


def write_status(state, message, extra=None):
    payload = {"state": state, "message": message, "updatedAt": iso_now()}
    if extra:
        payload.update(extra)
    with _status_lock:
        with open(os.path.join(DATA_OUT, "status.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)


def make_progress():
    def progress(phase, channel, page, fetched, done, total, sightings):
        if phase == "fetch":
            write_status("backfill", f"Downloading @{channel} — page {page} ({fetched} posts)…",
                         {"phase": phase, "done": done, "total": total})
        elif phase == "fetched":
            write_status("backfill", f"@{channel}: {total} post(s) queued",
                         {"phase": phase, "done": done, "total": total})
        elif phase == "extract":
            write_status("backfill", f"Analyzing posts — {done}/{total} (+{sightings} sightings)",
                         {"phase": phase, "done": done, "total": total})
        elif phase == "done":
            write_status("idle", f"Backfill complete — {sightings} sighting(s) from {total} post(s).",
                         {"phase": phase, "done": done, "total": total})
    return progress


# --------------------------------------------------------------------------- #
# Worker thread
# --------------------------------------------------------------------------- #
def worker(pipeline):
    # Instant paint: restore the last session from disk and render it before we
    # touch the network, so the map is full the moment the window opens.
    restored = pipeline.restore()
    if restored:
        pipeline.write_outputs()
        log(f"restored {restored} sighting(s) from last session")
        write_status("idle", f"Loaded {restored} sighting(s) from cache — refreshing…")

    write_status("starting", "Checking AI backend…")
    ok = pipeline.llm.ping()
    if ok:
        has, models = pipeline.llm.has_model()
        if not has:
            msg = (f'Model "{CONFIG["ollama_model"]}" not installed. Run: '
                   f'ollama pull {CONFIG["ollama_model"]}. Installed: {", ".join(models) or "none"}.')
            log(msg)
            if not CONFIG["allow_heuristic_only"]:
                write_status("error", msg)
                return
            pipeline.use_llm = False
            write_status("warn", "Ollama model missing — using the offline heuristic parser.")
        else:
            log(f"Ollama ready: {CONFIG['ollama_model']}")
    else:
        log(f"Ollama not reachable at {CONFIG['ollama_url']}.")
        if not CONFIG["allow_heuristic_only"]:
            write_status("error", f"Ollama not reachable at {CONFIG['ollama_url']}. Start it with: ollama serve")
            return
        pipeline.use_llm = False
        write_status("warn", "Ollama unavailable — using the offline heuristic parser.")

    try:
        pipeline.backfill(make_progress())
        pipeline.prewarm_translations()  # warm the newest warnings for instant popups
    except Exception as e:
        log(f"backfill error: {e}")
        write_status("error", f"Backfill error: {e}")

    while True:
        time.sleep(CONFIG["poll_seconds"])
        try:
            write_status("polling", "Polling channels…")
            n = pipeline.poll()
            if n:
                pipeline.prewarm_translations()
            write_status("idle", f"Live — {pipeline.store.count()} sighting(s)." +
                         (f" +{n} new." if n else ""))
        except Exception as e:
            log(f"poll error: {e}")
            write_status("error", f"Poll error: {e}")


# --------------------------------------------------------------------------- #
# HTTP server
# --------------------------------------------------------------------------- #
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)

    def log_message(self, *a):
        pass  # quiet

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] == "/api/translate":
            try:
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                data = {}
            text = (data.get("text") or "")[:2000]
            try:
                out = PIPELINE.translate(text) if PIPELINE else text
                self._json({"translation": out})
            except Exception as e:
                self._json({"translation": text, "error": str(e)}, status=200)
            return
        self.send_error(404)


def serve():
    """Bind the requested port, or fall back to any free port if it's taken."""
    for port in (CONFIG["port"], 0):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            return httpd, httpd.server_address[1]
        except OSError:
            continue
    raise OSError("could not bind a local port")


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    # Seed empty data files so the page renders instantly before the first run.
    for name, payload in (("sightings.json", {"sightings": [], "updatedAt": None}),
                          ("tracks.json", {"tracks": [], "updatedAt": None}),
                          ("status.json", {"state": "starting", "message": "Starting…"})):
        path = os.path.join(DATA_OUT, name)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f)

    store = Store()
    geocoder = Geocoder()
    llm = OllamaClient()
    pipeline = Pipeline(store, geocoder, llm)
    global PIPELINE
    PIPELINE = pipeline  # expose to the /api/translate handler

    httpd, port = serve()
    url = f"http://127.0.0.1:{port}/"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=worker, args=(pipeline,), daemon=True).start()

    log("=" * 60)
    log("The Big Drone Detector — local app")
    log(f"  AI backend : Ollama {CONFIG['ollama_model']} @ {CONFIG['ollama_url']}")
    log(f"  Channels   : {', '.join(CONFIG['channels'])}")
    log(f"  Backfill   : last {CONFIG['backfill_hours']:.0f}h · poll every {CONFIG['poll_seconds']}s")
    log(f"  Cache      : {STATE_FILE}")
    log(f"  URL        : {url}")
    log("=" * 60)

    # Show it as a real desktop app window by default (pywebview). In "auto"
    # mode we only do that when pywebview and a display are actually present,
    # otherwise we fall back to the browser so it always opens *something*.
    if should_try_native():
        try:
            import webview  # type: ignore
            log("Opening the app window… (close it or press Ctrl+C to stop)")
            webview.create_window("The Big Drone Detector", url, width=1440, height=920,
                                  min_size=(960, 640), background_color="#0d1b2a")
            webview.start()
            log("window closed — shutting down.")
            return
        except ImportError:
            log("pywebview not installed — run 'pip install pywebview' for a desktop"
                " app window. Opening the browser instead.")
        except Exception as e:
            log(f"app window failed ({e}) — opening the browser instead.")

    log(f"Opening the map in your browser: {url}")
    log("(If it didn't open, paste that URL into your browser.) Ctrl+C to stop.")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("shutting down…")


def should_try_native():
    """Decide whether to open the standalone desktop window.

    auto (default): yes, when pywebview is importable AND a GUI is available
    (always on Windows/macOS; on Linux only with a DISPLAY/WAYLAND session).
    Force it with DDX_NATIVE=1/native/app, or force the browser with
    DDX_NATIVE=0/browser."""
    mode = CONFIG["native_mode"]
    if mode in ("0", "false", "no", "browser", "web"):
        return False
    if mode in ("1", "true", "yes", "native", "app", "desktop", "window"):
        return True
    # auto
    import importlib.util
    if importlib.util.find_spec("webview") is None:
        return False
    if sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return False
    return True


if __name__ == "__main__":
    main()
