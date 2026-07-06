'use strict';

/**
 * GitHub Actions update script.
 *
 * Fetches new posts from the public Telegram channel preview, sends each to
 * OpenRouter for drone/threat extraction, geocodes the results, merges them
 * into docs/data/sightings.json, and prunes old entries.
 *
 * Usage (requires Node 18+):
 *   OPENROUTER_API_KEY=sk-or-... node scripts/update-map.js
 *
 * Optional env vars:
 *   TELEGRAM_CHANNELS     default: radarrussiia,kpszsu,lpr1_treugolnik
 *   OPENROUTER_MODELS     comma-separated cascade (default: qwen → nemotron → lfm)
 *   DDX_RETENTION_HOURS   default: 1   (live-map window; older entries pruned)
 *   DDX_HISTORY_HOURS     default: 12  (track-building history window)
 *   DDX_MAX_NEW_POSTS     default: 60  (cap per run to stay within rate limits)
 *   DDX_MAX_PAGES         default: 3   (extra preview pages fetched per channel)
 */

const fs = require('fs');
const path = require('path');

const { fetchChannelPosts } = require('../src/services/telegram');
const { OpenRouterClient } = require('../src/services/openrouter');
const { Geocoder } = require('../src/services/geocode');
const { analyzePost, isInterceptionRecap, isBlockedLocation } = require('../src/services/heuristic');
const { buildTracks } = require('../src/services/tracks');
const {
  headingToBearing,
  bearingBetween,
  isInRegion,
  normalizeSightingDirection,
  dropDestinationEchoes,
  backfillFromHeuristic,
  stripSummaryCounts,
  resolveMovement,
} = require('../src/services/enrich');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOCS_DATA = path.join(__dirname, '..', 'docs', 'data', 'sightings.json');
// One or more channels (comma-separated). radarrussiia & lpr1_treugolnik =
// threats over Russia; kpszsu = Ukrainian Air Force, reporting strikes on
// Ukraine. Reports are de-duplicated by location, so overlapping Russia
// sources merge into one marker instead of colliding.
const CHANNELS = (process.env.TELEGRAM_CHANNELS || process.env.TELEGRAM_CHANNEL || 'radarrussiia,kpszsu,lpr1_treugolnik')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Model cascade: each retry attempt uses the next model, so a rate-limit or
// provider failure on model 0 automatically falls back to model 1, then 2.
// OPENROUTER_MODELS env var (comma-separated) overrides the default cascade;
// OPENROUTER_MODEL (single) is also accepted for backward compatibility.
const DEFAULT_MODELS = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'liquid/lfm-2.5-1.2b-instruct:free',
];
const MODELS = process.env.OPENROUTER_MODELS
  ? process.env.OPENROUTER_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
  : process.env.OPENROUTER_MODEL
  ? [process.env.OPENROUTER_MODEL]
  : DEFAULT_MODELS;
// Keep only the last hour of data — the map only shows the last hour anyway, so
// older entries are pruned out of sightings.json instead of lingering forever.
const RETENTION_MS = (parseFloat(process.env.DDX_RETENTION_HOURS || '1')) * 3600 * 1000;
// A longer-lived compact history feeds the track builder: hours of waypoints
// are needed to draw a drone's route across the country, not just the last 60m.
const HISTORY_MS = (parseFloat(process.env.DDX_HISTORY_HOURS || '12')) * 3600 * 1000;
const MAX_NEW_POSTS = parseInt(process.env.DDX_MAX_NEW_POSTS || '60', 10);
// Extra preview pages to fetch per channel (t.me/s/<ch>?before=<id>) when the
// newest page doesn't reach all the way back to the last processed post.
const MAX_PAGES = parseInt(process.env.DDX_MAX_PAGES || '3', 10);
// How many posts to extract from the LLM at once. Parallelism keeps a busy run
// well under the workflow timeout instead of processing posts one-by-one.
const CONCURRENCY = parseInt(process.env.DDX_CONCURRENCY || '6', 10);
const LLM_TIMEOUT_MS = parseInt(process.env.DDX_LLM_TIMEOUT_MS || '25000', 10);
const GEOCACHE = path.join(__dirname, '..', 'docs', 'data', 'geocode-cache.json');
const HISTORY_FILE = path.join(__dirname, '..', 'docs', 'data', 'history.json');
const TRACKS_FILE = path.join(__dirname, '..', 'docs', 'data', 'tracks.json');
const API_KEY = process.env.OPENROUTER_API_KEY || '';

// Run an async fn over items with a bounded number in flight at once.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[update-map] could not read ${path.basename(file)}: ${err.message}`);
  }
  return fallback;
}

function loadState() {
  try {
    if (fs.existsSync(DOCS_DATA)) {
      return JSON.parse(fs.readFileSync(DOCS_DATA, 'utf8'));
    }
  } catch (err) {
    console.warn('[update-map] could not load state:', err.message);
  }
  return { sightings: [], lastPostId: {}, updatedAt: null };
}

function pruneOld(sightings) {
  const cutoff = Date.now() - RETENTION_MS;
  return sightings.filter((s) => {
    const t = Date.parse(s.timestamp || s.postDate || '') || 0;
    return !t || t >= cutoff;
  });
}

// Compact record kept in history.json — enough for tracks + timeline, small
// enough that 12 hours of a busy night stays a few hundred KB.
function toHistoryRecord(s) {
  return {
    id: s.id,
    lat: s.lat,
    lon: s.lon,
    timestamp: s.timestamp,
    location: s.location,
    region: s.region || '',
    threatType: s.threatType,
    status: s.status,
    count: s.count,
    channel: s.channel,
    geocodePrecision: s.geocodePrecision || 'point',
    bearing: s.bearing != null ? s.bearing : null,
    destination: s.destination || null,
  };
}

// Append new sightings to the long-window history, dedupe by id, prune.
function updateHistory(newSightings) {
  const prev = loadJson(HISTORY_FILE, { sightings: [] });
  const byId = new Map();
  for (const s of prev.sightings || []) byId.set(s.id, s);
  for (const s of newSightings) byId.set(s.id, toHistoryRecord(s));
  const cutoff = Date.now() - HISTORY_MS;
  const kept = [...byId.values()]
    .filter((s) => (Date.parse(s.timestamp || '') || 0) >= cutoff)
    .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  return { sightings: kept, updatedAt: new Date().toISOString() };
}

// Fetch a channel's new posts, paginating back through the preview pages when
// one page doesn't reach the last processed post (e.g. after downtime or a
// very busy night), so no post is silently skipped.
async function fetchNewPosts(channel, last) {
  let posts = await fetchChannelPosts({ channel });
  let pages = 1;
  // Only backfill when we have a cursor — on a first run one page is plenty.
  while (
    last > 0 &&
    pages <= MAX_PAGES &&
    posts.length &&
    posts[0].postId > last + 1
  ) {
    const beforeId = posts[0].postId;
    let older;
    try {
      older = await fetchChannelPosts({ channel, beforeId });
    } catch (err) {
      console.warn(`  [paginate] @${channel} before=${beforeId} failed: ${err.message}`);
      break;
    }
    const fresh = older.filter((p) => p.postId < beforeId);
    if (!fresh.length) break;
    posts = fresh.concat(posts);
    pages++;
  }
  if (pages > 1) console.log(`  [paginate] @${channel}: fetched ${pages} pages`);
  return posts;
}

function dedup(sightings) {
  const seen = new Map();
  for (const s of sightings) seen.set(s.id, s);
  return Array.from(seen.values()).sort(
    (a, b) =>
      (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0)
  );
}

// Fill bearing from a compass heading where it's missing. No network.
function backfillBearings(sightings) {
  for (const s of sightings) {
    if ((s.bearing === null || s.bearing === undefined) && s.heading) {
      const b = headingToBearing(s.heading);
      if (b !== null) s.bearing = b;
    }
  }
  return sightings;
}

// Ask the model cascade, advancing to the next model on each failure so that
// a rate-limit or provider outage automatically tries a different engine.
// Returns null only if every attempt across all models failed.
async function extractWithRetry(llm, post, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const modelIndex = i - 1; // attempt 1 → model 0, attempt 2 → model 1, …
    try {
      return await llm.extractSightings(post, LLM_TIMEOUT_MS, modelIndex);
    } catch (err) {
      const modelName = (llm.models || [])[modelIndex % ((llm.models || []).length || 1)] || '?';
      console.warn(`  [llm-retry ${i}/${attempts}] ${modelName} post ${post.postId}: ${err.message}`);
      if (i < attempts) await sleep(i * 800);
    }
  }
  return null;
}

// Turn one post into geocoded sighting objects (LLM with heuristic fallback).
async function processPost(post, channel, llm, geocoder) {
  const out = [];
  // Skip MoD-style "destroyed N UAVs over [oblasts]" recap totals entirely.
  if (isInterceptionRecap(post.text)) {
    console.log(`  [recap-skip] post ${post.postId}`);
    return out;
  }
  const heur = analyzePost(post.text);
  let extraction = await extractWithRetry(llm, post);

  // Deterministic safety net: if the model gave nothing usable but the post
  // clearly describes a threat we can locate, use the parsed result.
  if (
    (!extraction || !extraction.isRelevant || !extraction.sightings.length) &&
    heur.isRelevant &&
    heur.sightings.length
  ) {
    console.log(`  [heuristic] post ${post.postId} → ${heur.sightings.length} sighting(s)`);
    extraction = heur;
  }

  if (!extraction || !extraction.isRelevant || !extraction.sightings.length) {
    console.log(`  [irrelevant] post ${post.postId}`);
    return out;
  }

  backfillFromHeuristic(extraction.sightings, heur);
  stripSummaryCounts(extraction.sightings);

  for (let sighting of extraction.sightings) {
    // Skip junk "locations" (seas, whole countries, vague terms).
    if (isBlockedLocation(sighting.location)) {
      console.log(`  [blocked-loc] "${sighting.location}" in post ${post.postId}`);
      continue;
    }
    // Fix headings that contain place names instead of compass directions.
    sighting = normalizeSightingDirection(sighting);

    const geo = await geocoder.resolve(sighting);
    if (!geo) {
      console.log(`  [no-geo] ${sighting.location} in post ${post.postId}`);
      continue;
    }

    // Resolve where it's going (destination geocode + travel bearing).
    const { destination, destinationLat, destinationLon, bearing } =
      await resolveMovement(sighting, geo, geocoder, (msg) => console.log(`  [${msg}]`));

    out.push({
      id: `${post.id}:${sighting.location}`,
      location: sighting.location,
      locationRu: sighting.locationRu || '',
      region: sighting.region || '',
      lat: geo.lat,
      lon: geo.lon,
      geocodeSource: geo.source,
      geocodePrecision: geo.precision || 'point',
      matchedName: geo.matchedName,
      threatType: sighting.threatType,
      count: sighting.count,
      heading: sighting.heading,
      destination,
      destinationLat,
      destinationLon,
      bearing,
      status: sighting.status,
      confidence: sighting.confidence,
      postId: post.postId,
      postLink: post.link,
      postText: (post.text || '').slice(0, 400),
      postDate: post.date,
      summary: extraction.summary,
      timestamp: post.date || new Date().toISOString(),
      channel,
    });
    const arrow = bearing !== null ? `→${Math.round(bearing)}°` : 'no-dir';
    console.log(
      `  📍 [@${channel}] ${sighting.location} (${sighting.region}) [${sighting.threatType}] ${arrow}${destination ? ' → ' + destination : ''}`
    );
  }
  return out;
}

async function main() {
  if (!API_KEY) {
    console.error('[update-map] OPENROUTER_API_KEY is required');
    process.exit(1);
  }

  const state = loadState();
  const lastPostId = { ...(state.lastPostId || {}) };
  const llm = new OpenRouterClient({ apiKey: API_KEY, models: MODELS });
  console.log(`[update-map] model cascade: ${MODELS.join(' → ')}`);
  // Warm-start geocoding from the persisted cache so known places resolve
  // instantly — keeps runs fast and pins consistent.
  const geocoder = new Geocoder({ initialCache: loadJson(GEOCACHE, {}) });

  const newSightingObjs = [];
  let anyNewPosts = false;

  // Gather every new post across channels first (fetches are quick), then
  // extract them in parallel so a busy backlog doesn't time the run out.
  const tasks = [];
  for (const channel of CHANNELS) {
    const last = lastPostId[channel] || 0;
    let posts;
    try {
      posts = await fetchNewPosts(channel, last);
    } catch (err) {
      // One channel failing (geo-block, rate limit) shouldn't kill the others.
      console.error(`[update-map] @${channel} fetch failed: ${err.message}`);
      continue;
    }
    const newPosts = posts.filter((p) => p.postId > last && p.text).slice(-MAX_NEW_POSTS);
    console.log(`[update-map] @${channel}: ${posts.length} posts, ${newPosts.length} new`);
    if (newPosts.length === 0) continue;
    anyNewPosts = true;
    for (const post of newPosts) tasks.push({ post, channel });
    // We attempt every new post, so advance the cursor past all of them.
    lastPostId[channel] = Math.max(last, ...newPosts.map((p) => p.postId));
  }

  const t0 = Date.now();
  const objArrays = await mapPool(tasks, CONCURRENCY, ({ post, channel }) =>
    processPost(post, channel, llm, geocoder)
  );
  for (const arr of objArrays) newSightingObjs.push(...arr);
  if (tasks.length) {
    console.log(`[update-map] extracted ${tasks.length} posts in ${((Date.now() - t0) / 1000).toFixed(1)}s (x${CONCURRENCY})`);
  }

  // Always merge + prune, even on a quiet run, so sightings older than the
  // retention window are removed promptly (the channel can go quiet for a
  // while and we still want stale markers gone).
  const merged = backfillBearings(dedup([...state.sightings, ...newSightingObjs]));
  const pruned = dropDestinationEchoes(pruneOld(merged));

  const lastPostIdChanged = JSON.stringify(lastPostId) !== JSON.stringify(state.lastPostId || {});
  const removed = (state.sightings || []).length + newSightingObjs.length - pruned.length;
  const changed = newSightingObjs.length > 0 || removed > 0 || lastPostIdChanged;

  if (!changed) {
    console.log('[update-map] no new posts and nothing to prune — leaving sightings.json unchanged');
    return;
  }

  const output = {
    sightings: pruned,
    lastPostId,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(DOCS_DATA), { recursive: true });
  fs.writeFileSync(DOCS_DATA, JSON.stringify(output, null, 2));

  // Long-window history + correlated flight tracks for the map's track layer.
  // Feed the whole cleaned live window (not just this run's new sightings) so
  // the history bootstraps from existing data on the first run after upgrade.
  try {
    const history = updateHistory(pruned);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 0));
    const tracks = buildTracks(history.sightings);
    fs.writeFileSync(
      TRACKS_FILE,
      JSON.stringify({ tracks, updatedAt: new Date().toISOString() }, null, 0)
    );
    console.log(
      `[update-map] history: ${history.sightings.length} pts (${(HISTORY_MS / 3600000).toFixed(0)}h) → ${tracks.length} track(s)`
    );
  } catch (err) {
    console.warn('[update-map] could not write history/tracks:', err.message);
  }

  // Persist the geocode cache so future runs skip re-resolving known places.
  try {
    const cache = geocoder.dumpCache();
    fs.writeFileSync(GEOCACHE, JSON.stringify(cache, null, 0));
    console.log(`[update-map] geocode cache: ${Object.keys(cache).length} places`);
  } catch (err) {
    console.warn('[update-map] could not write geocode cache:', err.message);
  }

  console.log(
    `[update-map] done. +${newSightingObjs.length} new, -${Math.max(0, removed)} pruned, ${pruned.length} total. lastPostId=${JSON.stringify(lastPostId)}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[update-map] fatal:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
  processPost,
  mapPool,
  pruneOld,
  updateHistory,
  toHistoryRecord,
  fetchNewPosts,
  backfillFromHeuristic,
  stripSummaryCounts,
  extractWithRetry,
  dropDestinationEchoes,
  normalizeSightingDirection,
  headingToBearing,
  bearingBetween,
  isInRegion,
};
