# The Big Drone Detector

A desktop app that tracks Russian/Ukrainian aerial threats (drones, Shaheds,
cruise & ballistic missiles) in near-real-time. It reads public Telegram
channels, extracts structured sightings with a **local Ollama model**, geocodes
them offline, correlates them into **flight tracks**, and plots everything on a
live dark map with a **history timeline**.

Everything runs on your machine — no API keys, no cloud, no rate limits.

## Features

- **Local AI extraction** via [Ollama](https://ollama.com) (default
  `translategemma:12b`) — reads Russian *and* Ukrainian posts. Structured
  outputs (JSON schema) guarantee valid results, and an optional second
  verification pass re-checks every extraction against the source post for
  accuracy.
- **Deep startup backfill** — on Start, it pages back through *all available
  history* (default 48h) across every channel and draws it immediately as
  flight tracks, so the map is never empty.
- **Flight tracks** — sequential sightings of the same group are correlated
  (distance / time / speed / turn-angle) into the actual route flown, with
  glowing polylines, waypoint dots and live-end arrowheads.
- **Timeline** — scrub or replay the whole history window; markers and tracks
  are trimmed to the moment in time you're viewing.
- **Accuracy hardening** — deterministic heuristic parser as a safety net,
  region-bounds sanity checks, destination-echo removal, recap-total stripping,
  all-clear supersession, multi-source corroboration and confidence gating.
- **Map** — toggleable layers (tracks / danger zones / vectors / labels /
  clock), status filters, live warnings panel, threat-level badge, distance
  measure tool, and clean **PNG area export**.

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) running locally with a model pulled:

  ```sh
  ollama pull translategemma:12b
  ollama serve            # usually already running after install
  ```

## Run

```sh
npm install
npm start                 # launches the desktop app
```

First launch: press **▶ Start**. The app checks Ollama is reachable and the
model is installed, then backfills history and begins live monitoring. Open
**⚙ Settings** to switch model/backend, change channels, or set the backfill
window.

No Ollama yet? Enable **Demo mode** in Settings (or `npm run demo`) to see it
working on bundled sample data with no AI or network.

### Headless / CLI

```sh
npm run cli -- --backfill     # download the full history window once
npm run cli -- --watch        # backfill, then keep polling
npm run cli -- --demo         # offline demo run
```

## Configuration

Configure from the in-app Settings panel, or via environment variables /
`.env` (see [`.env.example`](.env.example)). Key ones:

| Variable | Default | Purpose |
|---|---|---|
| `DDX_AI_BACKEND` | `ollama` | `ollama` (local) or `openrouter` (cloud) |
| `OLLAMA_MODEL` | `translategemma:12b` | local model name |
| `DDX_VERIFY` | `1` | second accuracy-checking model pass |
| `TELEGRAM_CHANNELS` | `radarrussiia,kpszsu,lpr1_treugolnik` | channels to monitor |
| `DDX_BACKFILL_HOURS` | `48` | history window drawn on startup / timeline length |

## Data sources

- **@radarrussiia**, **@lpr1_treugolnik** — threats over Russia
- **@kpszsu** (Ukrainian Air Force) — Russian strikes on Ukraine

Read from each channel's public web preview (`t.me/s/<channel>`) — no Telegram
account or bot token required.

## Building installers

```sh
npm run dist:win      # Windows (nsis + portable)
npm run dist:mac      # macOS (dmg)
npm run dist:linux    # Linux (AppImage)
```

## The hosted map

A lighter-weight version also runs as a GitHub Pages site, updated every 5
minutes by a GitHub Action (`scripts/update-map.js`, cloud LLM). The desktop
app is the full local-AI experience; the two share the same extraction,
geocoding and track-correlation code.

## Tests

```sh
npm test              # node --test, 84 unit tests
```
