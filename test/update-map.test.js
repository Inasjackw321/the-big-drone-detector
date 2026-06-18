'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Importing must NOT kick off the update run (guarded by require.main).
const {
  backfillFromHeuristic,
  extractWithRetry,
  dropDestinationEchoes,
} = require('../scripts/update-map');

test('backfillFromHeuristic fills missing count and status only', () => {
  const heur = { isRelevant: true, sightings: [{ count: 5, status: 'approaching' }] };
  const sightings = [
    { count: null, status: 'unknown' }, // both filled
    { count: 12, status: 'shot_down' }, // model values kept
    { count: null, status: 'overhead' }, // only count filled
  ];
  backfillFromHeuristic(sightings, heur);
  assert.deepEqual(sightings[0], { count: 5, status: 'approaching' });
  assert.deepEqual(sightings[1], { count: 12, status: 'shot_down' });
  assert.deepEqual(sightings[2], { count: 5, status: 'overhead' });
});

test('backfillFromHeuristic is a no-op when the heuristic found nothing', () => {
  const sightings = [{ count: null, status: 'unknown' }];
  backfillFromHeuristic(sightings, { isRelevant: false, sightings: [] });
  assert.deepEqual(sightings[0], { count: null, status: 'unknown' });
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
    { id: 'p/1:Tula', postId: 1, location: 'Tula', destination: 'Moscow' },
    { id: 'p/1:Moscow', postId: 1, location: 'Moscow', destination: null, heading: 'towards Moscow' },
    { id: 'p/2:Kursk', postId: 2, location: 'Kursk', destination: null },
  ];
  const kept = dropDestinationEchoes(sightings).map((s) => s.id);
  assert.deepEqual(kept, ['p/1:Tula', 'p/2:Kursk']);
});
