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
 *   TELEGRAM_CHANNEL      default: radarrussiia
 *   OPENROUTER_MODEL      default: openrouter/owl-alpha
 *   DDX_RETENTION_HOURS   default: 48
 *   DDX_MAX_NEW_POSTS     default: 30  (cap per run to stay within rate limits)
 */

const fs = require('fs');
const path = require('path');

const { fetchChannelPosts } = require('../src/services/telegram');
const { OpenRouterClient } = require('../src/services/openrouter');
const { Geocoder, normalizeKey } = require('../src/services/geocode');
const { analyzePost } = require('../src/services/heuristic');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOCS_DATA = path.join(__dirname, '..', 'docs', 'data', 'sightings.json');
const CHANNEL = process.env.TELEGRAM_CHANNEL || 'radarrussiia';
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/owl-alpha';
const RETENTION_MS = (parseInt(process.env.DDX_RETENTION_HOURS || '48', 10)) * 3600 * 1000;
const MAX_NEW_POSTS = parseInt(process.env.DDX_MAX_NEW_POSTS || '30', 10);
const API_KEY = process.env.OPENROUTER_API_KEY || '';

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
    const key = s.postId != null ? s.postId : s.id;
    if (!byPost.has(key)) byPost.set(key, []);
    byPost.get(key).push(s);
  }
  const drop = new Set();
  for (const group of byPost.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      const aLoc = normalizeKey(a.location);
      if (!aLoc) continue;
      for (const b of group) {
        if (a === b) continue;
        if (normalizeKey(sightingDestination(b)) === aLoc) {
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
  for (const s of sightings) {
    if ((s.count === null || s.count === undefined) && heurCount != null) s.count = heurCount;
    if ((!s.status || s.status === 'unknown') && heurStatus && heurStatus !== 'unknown') {
      s.status = heurStatus;
    }
  }
}

// Ask the model, retrying transient failures so a flaky call doesn't drop a
// post. Returns null if every attempt failed.
async function extractWithRetry(llm, post, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await llm.extractSightings(post);
    } catch (err) {
      console.warn(`  [llm-retry ${i}/${attempts}] post ${post.postId}: ${err.message}`);
      if (i < attempts) await sleep(i * 1500);
    }
  }
  return null;
}

async function main() {
  if (!API_KEY) {
    console.error('[update-map] OPENROUTER_API_KEY is required');
    process.exit(1);
  }

  const state = loadState();
  const lastPostId = (state.lastPostId || {})[CHANNEL] || 0;
  console.log(`[update-map] channel=@${CHANNEL}  lastPostId=${lastPostId}`);

  let posts;
  try {
    posts = await fetchChannelPosts({ channel: CHANNEL });
  } catch (err) {
    console.error('[update-map] failed to fetch Telegram posts:', err.message);
    process.exit(1);
  }

  const newPosts = posts
    .filter((p) => p.postId > lastPostId && p.text)
    .slice(-MAX_NEW_POSTS);
  console.log(`[update-map] ${posts.length} posts fetched, ${newPosts.length} new to process`);

  if (newPosts.length === 0) {
    console.log('[update-map] nothing new — exiting without writing');
    return;
  }

  const llm = new OpenRouterClient({ apiKey: API_KEY, model: MODEL });
  const geocoder = new Geocoder();

  let maxSeenId = lastPostId;
  const newSightingObjs = [];

  for (const post of newPosts) {
    maxSeenId = Math.max(maxSeenId, post.postId);

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
      continue;
    }

    backfillFromHeuristic(extraction.sightings, heur);

    for (let sighting of extraction.sightings) {
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

      const id = `${post.id}:${sighting.location}`;
      newSightingObjs.push({
        id,
        location: sighting.location,
        locationRu: sighting.locationRu || '',
        region: sighting.region || '',
        lat: geo.lat,
        lon: geo.lon,
        geocodeSource: geo.source,
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
        channel: CHANNEL,
      });
      const arrow = bearing !== null ? `→${Math.round(bearing)}°` : 'no-dir';
      console.log(
        `  📍 ${sighting.location} (${sighting.region}) [${sighting.threatType}] ${arrow}${destination ? ' → ' + destination : ''}`
      );
    }
  }

  const merged = backfillBearings(dedup([...state.sightings, ...newSightingObjs]));
  const pruned = dropDestinationEchoes(pruneOld(merged));

  const updatedLastPostId = { ...(state.lastPostId || {}), [CHANNEL]: maxSeenId };
  const output = {
    sightings: pruned,
    lastPostId: updatedLastPostId,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(DOCS_DATA), { recursive: true });
  fs.writeFileSync(DOCS_DATA, JSON.stringify(output, null, 2));
  console.log(
    `[update-map] done. +${newSightingObjs.length} new sightings, ${pruned.length} total. lastPostId=${maxSeenId}`
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
  backfillFromHeuristic,
  extractWithRetry,
  dropDestinationEchoes,
  normalizeSightingDirection,
  headingToBearing,
  bearingBetween,
  isInRegion,
};
