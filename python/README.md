# The Big Drone Detector — Python app

A single Python script that tracks Russian/Ukrainian aerial threats (drones,
Shaheds, cruise & ballistic missiles) from public Telegram channels, extracts
them with a **local Ollama model** (default `translategemma:12b`), correlates
them into **flight tracks**, and shows everything on a live dark map with a
**history timeline** in your browser.

No Electron, no build step, no pip install — it uses only the Python standard
library, launches a local web server, and opens your browser. It keeps running
until you press **Ctrl+C**, so the window never "closes immediately".

## Requirements

- **Python 3.8+**
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

1. checks Ollama is up and the model is installed,
2. **downloads all available history** (last 48h by default) from every
   channel and draws it immediately as flight tracks — so the map opens full,
3. starts a local server at `http://127.0.0.1:8700/` and opens your browser,
4. keeps polling for new posts every 2 minutes until you Ctrl+C.

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
| `TELEGRAM_CHANNELS` | `radarrussiia,kpszsu,lpr1_treugolnik` | channels |
| `DDX_BACKFILL_HOURS` | `48` | history downloaded on startup / timeline length |
| `POLL_INTERVAL_SECONDS` | `120` | how often to check for new posts |
| `DDX_PORT` | `8700` | local web server port |
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
