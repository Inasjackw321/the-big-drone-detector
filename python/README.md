# The Big Drone Detector — Python app

A Python app that tracks Russian/Ukrainian aerial threats (drones, Shaheds,
cruise & ballistic missiles) from public Telegram channels, reads them with a
**local Ollama model** (default `gemma3:12b`), correlates them into
**flight tracks**, and shows everything on a live dark map with a **history
timeline** — **in your browser**.

The model does the reading: it classifies each object's type, separates
distinct objects mentioned in the same post (so a missile is never chained to
the drones beside it), and geocodes place names — which is what keeps each
track to a single object.

## Requirements

- **Python 3.8+** (standard library only for the core)
- **[Ollama](https://ollama.com)** running locally with the model pulled:

  ```sh
  ollama pull gemma3:12b   # or gemma3:4b for a ~3x faster, slightly less precise run
  ollama serve            # usually already running after install
  ```
- **Optional, recommended:** `pip install pywebview` to run it as a **standalone
  desktop app** window instead of a browser tab (see below).

## Run

```sh
cd python
pip install pywebview        # optional — makes it a desktop app window
python drone_detector.py
```

On start it:

1. grabs the **last hour** of messages from every channel and plots them;
2. checks Ollama is up and the model is installed;
3. **opens as a standalone app** and **updates every minute** — new messages
   are extracted, geocoded and their tracks redrawn as they arrive, and moving
   drones creep toward their destination live. Press Ctrl+C to stop.

**How it opens** (`DDX_NATIVE`, default `auto`):

- `auto` — its own **desktop app window** when `pywebview` and a display are
  available, otherwise the browser (so it always opens something).
- `1` / `app` — force the desktop window · `0` / `browser` — force the browser.

### Fast loads

- **Persistent cache** (`state.json` in your OS app-data folder): sightings,
  per-channel cursors and resolved coordinates are saved, so repeat launches
  paint instantly and **only new posts are extracted** — no re-doing history.
- **Relevance pre-filter** (`DDX_LLM_PREFILTER`, on by default): posts with no
  aerial-threat keyword are never sightings, so the model is skipped for them —
  on a busy channel full of unrelated chatter this is the single biggest
  speedup.
- **Parallel** channel fetch + extraction (`DDX_CONCURRENCY`, default 3).
- **Newest-first** ordering with incremental map writes.
- The slower verification pass runs only on **recent** posts during bulk
  backfill (`DDX_VERIFY_RECENT_HOURS`); live polling always verifies.

If the model in `OLLAMA_MODEL` isn't pulled, the app automatically uses another
**installed** chat model instead (so the AI — and translation, and the
direction it needs to move drones — keep working). Only if Ollama is
unreachable or has no usable model does it fall back to the built-in
deterministic parser (less accurate; set `DDX_ALLOW_HEURISTIC_ONLY=0` to require
Ollama instead).

## In the map

- **Timeline** (bottom): drag to scrub through history, or press ▶ to replay.
  Markers and tracks are trimmed to the moment you're viewing; **● LIVE** snaps
  back to now.
- **Markers**: a report of *N* drones is drawn as an actual formation of up to
  three **long-range strike-drone** (Shahed-style) glyphs with an exact ×N
  badge, each **facing its heading**; missiles are drawn as rockets and jets as
  swept-wing aircraft. When a heading/destination is known, a drone slowly
  **advances that way from its last known spot** (live dead-reckoning).
- **Warnings are a region, not pins.** An area threat (an alert/overhead
  warning, or a cluster of them) is drawn as one **filled green region** with a
  bright border — the monitor-map look — rather than a pulsing pin in every
  town. Every in-flight drone/jet/missile is drawn on top as a **moving blip**
  that flies toward its target (its stated destination, its course, or the
  nearest city) with a **wake** and a dashed **projected track**, its icon
  pointing the way it's going. Impacts and all-clears keep their own marker.
- **Tracks** trail the object's **last known location** as a fading comet tail
  (labelled `AO#id · km/h · age`); separate markers are never wired together.
- **Filters**: All / Danger / Inbound / Cleared / Drones / Missiles.
- **Layers**: Tracks / Zones / **Bases** (known airbases) / Labels / Clock
  (remembered between sessions).
- **🌐 Translate**: click *Translate* in any post popup to render the
  Russian/Ukrainian text in English (translated on-device by Ollama, cached).
  It goes straight to Ollama even if extraction fell back to the heuristic
  parser, and if no chat model is available it says so plainly instead of
  silently showing the original. Toggle the **🌐 Translate** chip to
  auto-translate every popup; the newest warnings are pre-translated so they
  open instantly.
- **⬇ Export**: click Export, then drag a rectangle to save that area of the
  map as a clean PNG (with the clock, a region/time header and a legend).
- **🎬 Video**: records a smooth **timelapse of everything since the app
  started** — it eases through the accumulated history at 24 fps with a
  burned-in title, time span and progress bar, and saves a WebM you can share.
- Click a warning to fly to it; hover a track for its object id, speed, route
  and time span; click a marker for the source post.

## Accuracy

- **The AI reads each post** — a general instruction model (`gemma3`) classifies
  every object by its own type (a missile/rocket is never mislabelled a drone)
  and assigns an **object id** so that several objects mentioned in one post are
  kept apart. The track builder trusts that grouping: two objects the AI
  separated are never chained into one track, and a group the AI reads as one
  moving thing keeps its path even through a sharp turn.
- **Structured outputs** — the JSON schema is sent to Ollama as the `format`
  field, so the model can only return schema-valid JSON.
- **Verification pass** — a second model call re-reads each post next to the
  first extraction and corrects it (deletes hallucinated places, fixes counts /
  status / destinations). Disable with `DDX_VERIFY=0` for speed.
- Deterministic heuristic backfill, region-bounds sanity checks (a town >450 km
  from its oblast is rejected as the wrong namesake), destination-echo removal,
  recap-total stripping, all-clear supersession and confidence gating.
- **Honest precision** — a district/raion/oblast name is treated as an *area*
  (drawn as a hatched zone), not a false pinpoint, and a built-in set of
  Kuban/Crimea places and airbase towns geocodes offline for speed + accuracy.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `gemma3:12b` | local reading/geocoding model (try `gemma3:4b` for speed) |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server |
| `DDX_VERIFY` | `1` | second accuracy-checking pass |
| `DDX_VERIFY_RECENT_HOURS` | `6` | during backfill, verify only posts newer than this |
| `DDX_CONCURRENCY` | `3` | parallel extractions |
| `DDX_LLM_PREFILTER` | `1` | skip the model for posts with no threat keyword (faster) |
| `DDX_NOMINATIM_RECENT_HOURS` | `6` | during backfill, only use the slow OpenStreetMap geocoder for posts newer than this |
| `TELEGRAM_CHANNELS` | `radarrussiia,kpszsu,lpr1_treugolnik,locatorru` | channels |
| `DDX_BACKFILL_HOURS` | `1` | how much history to grab at startup |
| `DDX_HISTORY_HOURS` | `24` | how long data is retained (timeline + session video) |
| `POLL_INTERVAL_SECONDS` | `60` | how often the map updates with new messages |
| `DDX_NATIVE` | `0` | `1` = standalone desktop window (needs pywebview); default opens the browser |
| `DDX_PORT` | `8700` | preferred local port (auto-picks a free one if taken) |
| `DDX_DATA_DIR` | OS app-data | where the persistent cache lives |
| `DDX_NOMINATIM` | `1` | allow OpenStreetMap geocoding for places not in the offline gazetteer |
| `DDX_ALLOW_HEURISTIC_ONLY` | `1` | keep running (heuristic parser) if Ollama is unavailable |

Example — a faster run over the last 12 hours (smaller model, no verify pass):

```sh
OLLAMA_MODEL=gemma3:4b DDX_BACKFILL_HOURS=12 DDX_VERIFY=0 python drone_detector.py
```

## Data sources

`@radarrussiia`, `@lpr1_treugolnik`, `@locatorru` (threats over Russia) and
`@kpszsu` (Ukrainian Air Force — Russian strikes on Ukraine), read from each
channel's public web preview. No Telegram account or bot token required.

Each flight track is built from a **single channel's** reports **and a single
object** — the AI separates distinct objects (a missile vs. the drones beside
it, one drone group vs. another) and the builder never chains across channels,
across threat types, or across objects the AI marked as different. One track
follows one object.
