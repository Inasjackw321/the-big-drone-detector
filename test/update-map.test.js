'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Importing must NOT kick off the update run (guarded by require.main).
const {
  backfillFromHeuristic,
  stripSummaryCounts,
  extractWithRetry,
  dropDestinationEchoes,
  processPost,
} = require('../scripts/update-map');

test('backfillFromHeuristic fills status for all but count only for a lone sighting', () => {
  const heur = { isRelevant: true, sightings: [{ count: 5, status: 'approaching' }] };
  const many = [
    { count: null, status: 'unknown' },
    { count: 12, status: 'shot_down' },
    { count: null, status: 'overhead' },
  ];
  backfillFromHeuristic(many, heur);
  // Count is ambiguous across several places, so only status is filled.
  assert.deepEqual(many[0], { count: null, status: 'approaching' });
  assert.deepEqual(many[1], { count: 12, status: 'shot_down' });
  assert.deepEqual(many[2], { count: null, status: 'overhead' });

  const one = [{ count: null, status: 'unknown' }];
  backfillFromHeuristic(one, heur);
  assert.deepEqual(one[0], { count: 5, status: 'approaching' }); // lone sighting gets the count
});

test('backfillFromHeuristic is a no-op when the heuristic found nothing', () => {
  const sightings = [{ count: null, status: 'unknown' }];
  backfillFromHeuristic(sightings, { isRelevant: false, sightings: [] });
  assert.deepEqual(sightings[0], { count: null, status: 'unknown' });
});

test('stripSummaryCounts nulls one number spread across many areas', () => {
  const s = [
    { location: 'A', count: 133 }, { location: 'B', count: 133 },
    { location: 'C', count: 133 }, { location: 'D', count: 133 },
  ];
  stripSummaryCounts(s);
  assert.ok(s.every((x) => x.count === null));
});

test('stripSummaryCounts keeps genuine per-location counts', () => {
  const single = [{ count: 5 }];
  stripSummaryCounts(single);
  assert.equal(single[0].count, 5);

  const small = [{ count: 2 }, { count: 2 }, { count: 2 }]; // small numbers stay
  stripSummaryCounts(small);
  assert.deepEqual(small.map((x) => x.count), [2, 2, 2]);

  const varied = [{ count: 10 }, { count: 20 }, { count: 30 }]; // differing stays
  stripSummaryCounts(varied);
  assert.deepEqual(varied.map((x) => x.count), [10, 20, 30]);
});

test('extractWithRetry returns the first successful extraction', async () => {
  let calls = 0;
  const llm = {
    async extractSightings() {
      calls++;
      return { isRelevant: true, sightings: [{ location: 'X' }] };
    },
  };
  const res = await extractWithRetry(llm, { postId: 1 }, 3);
  assert.equal(calls, 1);
  assert.equal(res.sightings.length, 1);
});

test('extractWithRetry returns null after exhausting attempts', async () => {
  let calls = 0;
  const llm = {
    async extractSightings() {
      calls++;
      throw new Error('boom');
    },
  };
  const res = await extractWithRetry(llm, { postId: 2 }, 1); // attempts=1 → no backoff sleep
  assert.equal(calls, 1);
  assert.equal(res, null);
});

test('dropDestinationEchoes removes a sighting sitting at another’s destination', () => {
  const sightings = [
    { id: 'p/1:Tula', channel: 'radarrussiia', postId: 1, location: 'Tula', destination: 'Moscow' },
    { id: 'p/1:Moscow', channel: 'radarrussiia', postId: 1, location: 'Moscow', destination: null, heading: 'towards Moscow' },
    { id: 'p/2:Kursk', channel: 'radarrussiia', postId: 2, location: 'Kursk', destination: null },
  ];
  const kept = dropDestinationEchoes(sightings).map((s) => s.id);
  assert.deepEqual(kept, ['p/1:Tula', 'p/2:Kursk']);
});

test('dropDestinationEchoes matches "X" destination against "X Oblast" location', () => {
  const sightings = [
    { id: 'r/9:Ogorodnikovo', channel: 'radarrussiia', postId: 9, location: 'Ogorodnikovo', destination: 'Nizhny Novgorod' },
    { id: 'r/9:NN Oblast', channel: 'radarrussiia', postId: 9, location: 'Nizhny Novgorod Oblast', destination: null },
  ];
  const kept = dropDestinationEchoes(sightings).map((s) => s.id);
  assert.deepEqual(kept, ['r/9:Ogorodnikovo']); // the destination-oblast echo is dropped
});

test('dropDestinationEchoes does not merge same post number across channels', () => {
  // Two different channels happen to share post number 5 — they must not be
  // grouped together (Kyiv on kpszsu is a real sighting, not a Moscow echo).
  const sightings = [
    { id: 'radarrussiia/5:Tula', channel: 'radarrussiia', postId: 5, location: 'Tula', destination: 'Moscow' },
    { id: 'radarrussiia/5:Moscow', channel: 'radarrussiia', postId: 5, location: 'Moscow', heading: 'towards Moscow' },
    { id: 'kpszsu/5:Kyiv', channel: 'kpszsu', postId: 5, location: 'Kyiv', destination: null },
  ];
  const kept = dropDestinationEchoes(sightings).map((s) => s.id);
  assert.deepEqual(kept, ['radarrussiia/5:Tula', 'kpszsu/5:Kyiv']);
});

test('processPost tags sightings with their source channel', async () => {
  const llm = {
    async extractSightings() {
      return {
        isRelevant: true,
        summary: 'Shaheds toward Kyiv',
        sightings: [{
          location: 'Kyiv', locationRu: 'Київ', region: 'Kyiv Oblast',
          threatType: 'drone', count: 5, heading: null, destination: null,
          status: 'approaching', confidence: 0.8,
        }],
      };
    },
  };
  const geocoder = {
    async resolve() {
      return { lat: 50.45, lon: 30.52, source: 'gazetteer', precision: 'point', matchedName: 'Kyiv', region: 'Kyiv Oblast' };
    },
  };
  const post = { id: 'kpszsu/5', postId: 5, text: 'Шахеди курсом на Київ', link: 'https://t.me/kpszsu/5', date: '2026-06-19T10:00:00+00:00' };
  const objs = await processPost(post, 'kpszsu', llm, geocoder);
  assert.equal(objs.length, 1);
  assert.equal(objs[0].channel, 'kpszsu');
  assert.equal(objs[0].location, 'Kyiv');
  assert.equal(objs[0].id, 'kpszsu/5:Kyiv');
  assert.equal(objs[0].lat, 50.45);
  assert.equal(objs[0].count, 5);
});
