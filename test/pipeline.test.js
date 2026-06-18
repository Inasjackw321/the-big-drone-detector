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
  cfg.update({ demo: true, telegramChannel: 'radarrussiia' });
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
