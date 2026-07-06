# The Big Drone Detector — Python app

A Python app that tracks Russian/Ukrainian aerial threats (drones, Shaheds,
cruise & ballistic missiles) from public Telegram channels, extracts them with a
**local Ollama model** (default `translategemma:12b`), correlates them into
**flight tracks**, and shows everything on a live dark map with a **history
timeline** — in a **native desktop window**.

## Requirements

- **Python 3.8+**
- **[Ollama](https://ollama.com)** running locally with the model pulled:

  ```sh
  ollama pull translategemma:12b
  ollama serve            # usually already running after install
  ```
- For the native window (recommended): **`pip install pywebview`**
  (without it, the app falls back to opening your browser).

## Run

```sh
cd python
pip install -r requirements.txt      # pywebview, for the native window
python drone_detector.py
```

On start it:

1. **repaints the last session instantly** from an on-disk cache — the map is
   full the moment the window opens;
2. checks Ollama is up and the model is installed;
3. fetches all channels **in parallel** and extracts new posts **concurrently**,
   **newest first**, so current threats appear within seconds while older
   history fills in behind them;
4. opens a **native desktop window** (via pywebview), and keeps polling for new
   posts until you close the window / press Ctrl+C.

### Fast loads

- **Persistent cache** (`state.json` in your OS app-data folder): sightings,
  per-channel cursors and resolved coordinates are saved, so repeat launches
  paint instantly and **only new posts are extracted** — no re-doing history.
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
- Click a warning to fly to it; hover a track for its route, distance and time
  span; click a marker for the source post.

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
| `TELEGRAM_CHANNELS` | `radarrussiia,kpszsu,lpr1_treugolnik` | channels |
| `DDX_BACKFILL_HOURS` | `48` | history downloaded on startup / timeline length |
| `POLL_INTERVAL_SECONDS` | `120` | how often to check for new posts |
| `DDX_NATIVE` | `1` | native window (`0` = force browser) |
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
