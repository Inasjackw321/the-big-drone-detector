# The Big Drone Detector — Python app

A Python app that tracks Russian/Ukrainian aerial threats (drones, Shaheds,
cruise & ballistic missiles) from public Telegram channels, extracts them with a
**local Ollama model** (default `translategemma:12b`), correlates them into
**flight tracks**, and shows everything on a live dark map with a **history
timeline** — **in your browser**.

## Requirements

- **Python 3.8+** (standard library only — no `pip install` needed)
- **[Ollama](https://ollama.com)** running locally with the model pulled:

  ```sh
  ollama pull translategemma:12b
  ollama serve            # usually already running after install
  ```

## Run

```sh
cd python
python drone_detector.py
```

On start it:

1. **repaints the last session instantly** from an on-disk cache — the map is
   full the moment it opens;
2. checks Ollama is up and the model is installed;
3. fetches all channels **in parallel** and extracts new posts **concurrently**,
   **newest first**, so current threats appear within seconds while older
   history fills in behind them;
4. **opens the map in your browser** and keeps polling for new posts (every
   ~45s) until you press Ctrl+C. If the browser doesn't open automatically, the
   terminal prints the URL to paste in.

> Prefer a standalone desktop window instead of a browser tab? Run
> `pip install pywebview` and start with `DDX_NATIVE=1 python drone_detector.py`.

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

If Ollama isn't reachable, it falls back to the built-in deterministic parser so
the map still works (less accurate — set `DDX_ALLOW_HEURISTIC_ONLY=0` to require
Ollama instead).

## In the map

- **Timeline** (bottom): drag to scrub through history, or press ▶ to replay.
  Markers and tracks are trimmed to the moment you're viewing; **● LIVE** snaps
  back to now.
- **Filters**: All / Danger / Inbound / Cleared / Drones / Missiles.
- **Layers**: Tracks / Zones / Vectors / Labels / Clock (remembered between
  sessions).
- **🌐 Translate**: click *Translate* in any post popup to render the
  Russian/Ukrainian text in English (translated on-device by the same Ollama
  model, cached). Toggle the **🌐 Translate** chip to auto-translate every
  popup you open. The newest warnings are pre-translated in the background, so
  those popups open instantly.
- **⬇ Export**: click Export, then drag a rectangle to save that area of the
  map as a clean PNG (with the clock, a region/time header and a legend).
- Click a warning to fly to it; hover a track for its object id, speed, route
  and time span; click a marker for the source post.

## Accuracy

- **Structured outputs** — the JSON schema is sent to Ollama as the `format`
  field, so the model can only return schema-valid JSON.
- **Verification pass** — a second model call re-reads each post next to the
  first extraction and corrects it (deletes hallucinated places, fixes counts /
  status / destinations). Disable with `DDX_VERIFY=0` for speed.
- Deterministic heuristic backfill, region-bounds sanity checks (a town >450 km
  from its oblast is rejected as the wrong namesake), destination-echo removal,
  recap-total stripping, all-clear supersession and confidence gating.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `translategemma:12b` | local model name |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server |
| `DDX_VERIFY` | `1` | second accuracy-checking pass |
| `DDX_VERIFY_RECENT_HOURS` | `6` | during backfill, verify only posts newer than this |
| `DDX_CONCURRENCY` | `3` | parallel extractions |
| `DDX_LLM_PREFILTER` | `1` | skip the model for posts with no threat keyword (faster) |
| `DDX_NOMINATIM_RECENT_HOURS` | `6` | during backfill, only use the slow OpenStreetMap geocoder for posts newer than this |
| `TELEGRAM_CHANNELS` | `radarrussiia,kpszsu,lpr1_treugolnik` | channels |
| `DDX_BACKFILL_HOURS` | `48` | history downloaded on startup / timeline length |
| `POLL_INTERVAL_SECONDS` | `45` | how often to check for new posts (lower = faster tracking) |
| `DDX_NATIVE` | `0` | `1` = standalone desktop window (needs pywebview); default opens the browser |
| `DDX_PORT` | `8700` | preferred local port (auto-picks a free one if taken) |
| `DDX_DATA_DIR` | OS app-data | where the persistent cache lives |
| `DDX_NOMINATIM` | `1` | allow OpenStreetMap geocoding for places not in the offline gazetteer |
| `DDX_ALLOW_HEURISTIC_ONLY` | `1` | keep running (heuristic parser) if Ollama is unavailable |

Example — a faster, drones-only run over the last 12 hours:

```sh
OLLAMA_MODEL=translategemma:12b DDX_BACKFILL_HOURS=12 DDX_VERIFY=0 python drone_detector.py
```

## Data sources

`@radarrussiia`, `@lpr1_treugolnik` (threats over Russia) and `@kpszsu`
(Ukrainian Air Force — Russian strikes on Ukraine), read from each channel's
public web preview. No Telegram account or bot token required.
