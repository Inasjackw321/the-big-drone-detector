'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { Config } = require('../src/config');
const { SightingStore } = require('../src/services/store');
const { Pipeline } = require('../src/services/pipeline');
const { demoFetchPosts, DemoLlmClient } = require('../src/services/demo');

function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `ddx-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function demoConfig(dir) {
  const cfg = new Config({ rootDir: path.join(__dirname, '..'), userDataDir: dir });
  cfg.update({ demo: true, telegramChannels: 'radarrussiia' });
  return cfg;
}

test('demo pipeline runs end-to-end and geocodes sightings', async () => {
  const dir = tmpDir('e2e');
  const config = demoConfig(dir);
  const store = new SightingStore({ filePath: path.join(dir, 's.json') });
  const pipeline = new Pipeline({
    config,
    store,
    overrides: { fetchPosts: demoFetchPosts, llm: new DemoLlmClient() },
  });

  const emitted = [];
  pipeline.on('sighting', ({ sighting }) => emitted.push(sighting));

  const res = await pipeline.pollOnce();

  // 7 relevant posts (one is an ad) -> at least 8 located sightings.
  assert.ok(res.fetched >= 8, `fetched ${res.fetched}`);
  assert.ok(emitted.length >= 8, `emitted ${emitted.length}`);

  // Every stored sighting must have real coordinates and a source.
  for (const s of store.all()) {
    assert.equal(typeof s.lat, 'number');
    assert.equal(typeof s.lon, 'number');
    assert.ok(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180);
    assert.ok(s.geocodeSource);
    assert.ok(s.location);
  }

  // The advertisement post must NOT produce a sighting.
  assert.ok(!store.all().some((s) => /реклама/i.test(s.postText || '')));
});

test('does not reprocess the same posts on a second poll', async () => {
  const dir = tmpDir('dedupe');
  const config = demoConfig(dir);
  const store = new SightingStore({ filePath: path.join(dir, 's.json') });
  const pipeline = new Pipeline({
    config,
    store,
    overrides: { fetchPosts: demoFetchPosts, llm: new DemoLlmClient() },
  });

  const first = await pipeline.pollOnce();
  const countAfterFirst = store.all().length;
  const second = await pipeline.pollOnce();

  assert.ok(first.newSightings > 0);
  assert.equal(second.newSightings, 0, 'no new sightings on second poll');
  assert.equal(store.all().length, countAfterFirst);
});

test('pipeline emits an error event when extraction fails', async () => {
  const dir = tmpDir('err');
  const config = demoConfig(dir);
  const store = new SightingStore({ filePath: path.join(dir, 's.json') });
  const brokenLlm = {
    async extractSightings() {
      throw new Error('boom');
    },
  };
  const pipeline = new Pipeline({
    config,
    store,
    overrides: { fetchPosts: demoFetchPosts, llm: brokenLlm },
  });
  const errors = [];
  pipeline.on('error', (e) => errors.push(e));

  await pipeline.pollOnce();
  assert.ok(errors.length > 0);
  assert.match(errors[0].message, /boom/);
  assert.equal(store.all().length, 0);
});

test('backfill pages back through history and builds tracks', async () => {
  const dir = tmpDir('backfill');
  const config = new Config({ rootDir: path.join(__dirname, '..'), userDataDir: dir });
  config.update({ demo: false, telegramChannels: 'radarrussiia', backfillHours: 6, backfillMaxPages: 5, extractConcurrency: 3 });

  // Two "pages" of history: newest page (ids 200-203) then older (ids 100-103),
  // each a drone stepping east so they chain into a track.
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const mk = (id, minAgo, lon) => ({
    id: `radarrussiia/${id}`, postId: id, channel: 'radarrussiia',
    link: `https://t.me/radarrussiia/${id}`, date: iso(minAgo),
    text: `Точка ${id}. Тульская область. Фиксация БПЛА, курс на восток.`, lon,
  });
  // ~0.5° lon (~33 km) every ~25 min ≈ 80 km/h — a realistic Shahed cadence
  // that chains under the tight correlation limits.
  const page2 = [mk(200, 100, 38.0), mk(201, 75, 38.5), mk(202, 50, 39.0), mk(203, 25, 39.5)]; // newest
  const page1 = [mk(100, 200, 36.0), mk(101, 175, 36.5), mk(102, 150, 37.0), mk(103, 125, 37.5)]; // older
  const fetchPosts = async ({ beforeId }) => {
    if (!beforeId) return page2.slice();
    if (beforeId <= 200) return page1.slice(); // older page when paging before 200
    return [];
  };

  // Stub LLM: place each post at a stepped coordinate so tracks correlate.
  const llm = {
    async extractSightings(post) {
      return {
        isRelevant: true, summary: 's',
        sightings: [{ location: 'Tula', locationRu: 'Тула', region: 'Tula Oblast',
          lat: 54.19, lon: post.lon, threatType: 'drone', count: null,
          heading: 'east', destination: null, status: 'approaching', confidence: 0.9 }],
      };
    },
  };
  // Geocoder stub returns the coords the LLM already provided (offline).
  const geocoder = { resolve: async (s) => (typeof s.lat === 'number' ? { lat: s.lat, lon: s.lon, source: 'stub', precision: 'point', matchedName: s.location, region: s.region } : null), dumpCache: () => ({}) };

  const store = new SightingStore({ filePath: path.join(dir, 's.json') });
  const pipeline = new Pipeline({ config, store, dataDir: dir, overrides: { fetchPosts, llm, geocoder } });

  const progress = [];
  pipeline.on('backfill', (p) => progress.push(p.phase));

  const res = await pipeline.backfill();
  // All 8 posts across both pages should have been processed.
  assert.equal(res.posts, 8, `processed ${res.posts} posts`);
  assert.equal(store.all().length, 8);
  assert.ok(progress.includes('fetched'));
  assert.ok(progress.includes('done'));

  // The stepped points must correlate into at least one track.
  const tracks = pipeline.tracks();
  assert.ok(tracks.length >= 1, `expected a track, got ${tracks.length}`);
  assert.ok(tracks[0].points.length >= 3);
});

test('store persists and reloads sightings and lastPostId', async () => {
  const dir = tmpDir('persist');
  const file = path.join(dir, 's.json');
  const config = demoConfig(dir);

  const store1 = new SightingStore({ filePath: file });
  const p1 = new Pipeline({
    config,
    store: store1,
    overrides: { fetchPosts: demoFetchPosts, llm: new DemoLlmClient() },
  });
  await p1.pollOnce();
  const total = store1.all().length;
  assert.ok(total > 0);

  // New store instance loads from disk.
  const store2 = new SightingStore({ filePath: file });
  assert.equal(store2.all().length, total);
  assert.ok(store2.getLastPostId('radarrussiia') >= 90007);
});
