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
 *   TELEGRAM_CHANNELS     default: radarrussiia,kpszsu  (comma-separated)
 *   OPENROUTER_MODEL      default: openrouter/owl-alpha
 *   DDX_RETENTION_HOURS   default: 1   (older sightings are pruned out)
 *   DDX_MAX_NEW_POSTS     default: 30  (cap per run to stay within rate limits)
 */

const fs = require('fs');
const path = require('path');

const { fetchChannelPosts } = require('../src/services/telegram');
const { OpenRouterClient } = require('../src/services/openrouter');
const { Geocoder, normalizeKey } = require('../src/services/geocode');
const { analyzePost, isInterceptionRecap, isBlockedLocation } = require('../src/services/heuristic');

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
const MAX_NEW_POSTS = parseInt(process.env.DDX_MAX_NEW_POSTS || '30', 10);
// How many posts to extract from the LLM at once. Parallelism keeps a busy run
// well under the workflow timeout instead of processing posts one-by-one.
const CONCURRENCY = parseInt(process.env.DDX_CONCURRENCY || '6', 10);
const LLM_TIMEOUT_MS = parseInt(process.env.DDX_LLM_TIMEOUT_MS || '25000', 10);
const GEOCACHE = path.join(__dirname, '..', 'docs', 'data', 'geocode-cache.json');
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

function dedup(sightings) {
  const seen = new Map();
  for (const s of sightings) seen.set(s.id, s);
  return Array.from(seen.values()).sort(
    (a, b) =>
      (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0)
  );
}

// Map a free-text compass heading to a bearing in degrees (0=N, clockwise).
const COMPASS = {
  n: 0, north: 0, север: 0, северное: 0,
  ne: 45, 'north-east': 45, northeast: 45, 'северо-восток': 45,
  e: 90, east: 90, восток: 90, восточное: 90,
  se: 135, 'south-east': 135, southeast: 135, 'юго-восток': 135,
  s: 180, south: 180, юг: 180, южное: 180,
  sw: 225, 'south-west': 225, southwest: 225, 'юго-запад': 225,
  w: 270, west: 270, запад: 270, западное: 270,
  nw: 315, 'north-west': 315, northwest: 315, 'северо-запад': 315,
};

function headingToBearing(heading) {
  if (!heading) return null;
  const key = heading.toString().trim().toLowerCase().replace(/\s+/g, '-');
  if (key in COMPASS) return COMPASS[key];
  // Loose contains match (e.g. "heading north toward Moscow").
  for (const word of Object.keys(COMPASS)) {
    if (word.length > 2 && key.includes(word)) return COMPASS[word];
  }
  return null;
}

// Great-circle initial bearing from point 1 to point 2, in degrees (0=N).
function bearingBetween(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI; // -180..180; (deg+360)%360 to normalize
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

const VALID_HEADINGS = new Set([
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
]);

// If the LLM put a place name in "heading" (e.g. "towards Moscow"), extract it
// as the destination and clear the heading so it doesn't confuse bearing logic.
function normalizeSightingDirection(s) {
  if (!s.heading) return s;
  const h = s.heading.toLowerCase().trim();
  if (VALID_HEADINGS.has(h.replace(/\s+/g, '-'))) return s; // already valid compass
  // Extract place name from free-text like "towards Moscow" / "toward Kursk"
  if (!s.destination) {
    const m = h.match(/^towards?\s+(.+)/);
    if (m) {
      // Preserve original case for the extracted place name
      const idx = s.heading.toLowerCase().indexOf(m[1]);
      s.destination = s.heading.slice(idx).split(',')[0].trim();
    }
  }
  s.heading = null;
  return s;
}

// Rough bounding box: Russia + nearby conflict areas. Filters out geocoder results
// that landed on a different continent (e.g. Moscow, Idaho).
function isInRegion(lat, lon) {
  return lat >= 38 && lat <= 78 && lon >= 18 && lon <= 195;
}

// Pull a place name out of a free-text heading like "towards Moscow".
function destFromHeading(heading) {
  if (!heading) return '';
  const m = heading.toString().match(/^\s*towards?\s+(.+)/i);
  return m ? m[1].split(',')[0].trim() : '';
}

// Where a sighting is heading (explicit field or parsed from the heading text).
function sightingDestination(s) {
  return (s.destination && s.destination.toString().trim()) || destFromHeading(s.heading);
}

// Remove "destination echo" markers: when one sighting in a post is heading
// toward a place, a second sighting AT that place (from the same post) is the
// LLM duplicating the destination as its own location. Drop those so a single
// event shows one group with an arrow, not two groups.
function dropDestinationEchoes(sightings) {
  const byPost = new Map();
  for (const s of sightings) {
    // Key by channel + post so the same post number on two channels never merges.
    const key = s.postId != null ? `${s.channel || ''}/${s.postId}` : s.id;
    if (!byPost.has(key)) byPost.set(key, []);
    byPost.get(key).push(s);
  }
  const stripRegionWord = (k) =>
    k.replace(/\s+(oblast|region|raion|district|krai|republic|область|области|округ|край)$/, '').trim();
  const drop = new Set();
  for (const group of byPost.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      const aLoc = normalizeKey(a.location);
      if (!aLoc) continue;
      const aLocBare = stripRegionWord(aLoc);
      for (const b of group) {
        if (a === b) continue;
        const bDest = normalizeKey(sightingDestination(b));
        if (bDest && (bDest === aLoc || bDest === aLocBare)) {
          drop.add(a.id);
          break;
        }
      }
    }
  }
  return sightings.filter((s) => !drop.has(s.id));
}

// Fill in count/status the model left blank using the deterministic parser, so
// "Фиксация от 5 БПЛА" reliably becomes count=5 and "Отбой" becomes all_clear.
function backfillFromHeuristic(sightings, heur) {
  if (!heur || !heur.isRelevant || !heur.sightings.length) return;
  const heurCount = heur.sightings[0].count;
  const heurStatus = heur.sightings[0].status;
  // Only attribute a count to a LONE sighting — a number alongside several
  // places is ambiguous (often a total), so don't stamp it on each.
  const single = sightings.length === 1;
  for (const s of sightings) {
    if (single && (s.count === null || s.count === undefined) && heurCount != null) {
      s.count = heurCount;
    }
    if ((!s.status || s.status === 'unknown') && heurStatus && heurStatus !== 'unknown') {
      s.status = heurStatus;
    }
  }
}

// A single post that lists one big number across MANY areas is a TOTAL, not a
// per-location count (e.g. "133 UAVs over Belgorod, Bryansk, Kaluga … oblasts").
// Don't stamp that number on every marker.
function stripSummaryCounts(sightings) {
  if (sightings.length < 3) return sightings;
  const counts = sightings.map((s) => s.count).filter((c) => typeof c === 'number');
  if (counts.length >= 3 && new Set(counts).size === 1 && counts[0] >= 10) {
    for (const s of sightings) s.count = null;
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

    // Resolve where it's going: geocode the destination if the post named
    // one, then derive a travel bearing (great-circle to the destination,
    // falling back to the compass heading).
    let destination = sighting.destination || null;
    let destinationLat = null;
    let destinationLon = null;
    let bearing = null;

    if (destination) {
      const destGeo = await geocoder.resolve({
        location: destination,
        region: '', // don't bias by sighting region — destination may be a different region
      });
      // Only trust the geocoded destination if it lands in the expected region.
      if (destGeo && isInRegion(destGeo.lat, destGeo.lon)) {
        destinationLat = destGeo.lat;
        destinationLon = destGeo.lon;
        const b = bearingBetween(geo.lat, geo.lon, destGeo.lat, destGeo.lon);
        bearing = ((b % 360) + 360) % 360;
      } else if (destGeo) {
        console.log(`  [bad-dest-geo] ${destination} resolved outside region (${destGeo.lat},${destGeo.lon})`);
      }
    }
    if (bearing === null) bearing = headingToBearing(sighting.heading);

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
      posts = await fetchChannelPosts({ channel });
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
  backfillFromHeuristic,
  stripSummaryCounts,
  extractWithRetry,
  dropDestinationEchoes,
  normalizeSightingDirection,
  headingToBearing,
  bearingBetween,
  isInRegion,
};
