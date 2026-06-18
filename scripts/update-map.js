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
const { Geocoder } = require('../src/services/geocode');

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

    let extraction;
    try {
      extraction = await llm.extractSightings(post);
    } catch (err) {
      console.warn(`  [skip] post ${post.postId} LLM error: ${err.message}`);
      continue;
    }

    if (!extraction.isRelevant || !extraction.sightings.length) {
      console.log(`  [irrelevant] post ${post.postId}`);
      continue;
    }

    for (const sighting of extraction.sightings) {
      const geo = await geocoder.resolve(sighting);
      if (!geo) {
        console.log(`  [no-geo] ${sighting.location} in post ${post.postId}`);
        continue;
      }

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
      console.log(
        `  📍 ${sighting.location} (${sighting.region}) [${sighting.threatType}] ${geo.lat.toFixed(3)},${geo.lon.toFixed(3)} via ${geo.source}`
      );
    }
  }

  const merged = dedup([...state.sightings, ...newSightingObjs]);
  const pruned = pruneOld(merged);

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

main().catch((err) => {
  console.error('[update-map] fatal:', err);
  process.exit(1);
});
