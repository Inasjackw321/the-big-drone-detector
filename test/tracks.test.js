'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildTracks, isTrackable, threatClass } = require('../src/services/tracks');

// Helper: sighting at (lat, lon) N minutes after a fixed epoch.
const T0 = Date.parse('2026-07-04T00:00:00Z');
function sig(lat, lon, min, extra = {}) {
  return {
    lat,
    lon,
    timestamp: new Date(T0 + min * 60000).toISOString(),
    location: extra.location || `p${min}`,
    threatType: 'drone',
    status: 'approaching',
    geocodePrecision: 'point',
    channel: 'radarrussiia',
    ...extra,
  };
}

test('chains sequential nearby sightings into one track', () => {
  // Tula → Ryazan → Kasimov: a consistent ENE course with realistic ~130 km
  // drone legs, ~35 min apart.
  const tracks = buildTracks([
    sig(54.19, 37.62, 0, { location: 'Tula' }),
    sig(54.63, 39.69, 35, { location: 'Ryazan' }),
    sig(55.30, 41.30, 70, { location: 'Kasimov' }),
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].points.length, 3);
  assert.equal(tracks[0].points[0].location, 'Tula');
  assert.equal(tracks[0].points[2].location, 'Kasimov');
  assert.ok(tracks[0].distanceKm > 100);
});

test('single sightings do not become tracks', () => {
  const tracks = buildTracks([sig(54.19, 37.62, 0)]);
  assert.equal(tracks.length, 0);
});

test('far-apart sightings stay separate', () => {
  // Tula and Vladivostok-ish — nowhere near one flight.
  const tracks = buildTracks([
    sig(54.19, 37.62, 0),
    sig(43.11, 131.87, 30),
  ]);
  assert.equal(tracks.length, 0);
});

test('a long time gap breaks the chain', () => {
  const tracks = buildTracks([
    sig(54.19, 37.62, 0),
    sig(54.63, 39.69, 300), // 5 hours later — not the same flight
  ]);
  assert.equal(tracks.length, 0);
});

test('drones and missiles never chain together', () => {
  const tracks = buildTracks([
    sig(54.19, 37.62, 0, { threatType: 'drone' }),
    sig(54.63, 39.69, 30, { threatType: 'cruise_missile' }),
  ]);
  assert.equal(tracks.length, 0);
});

test('shot_down ends a track — later points start a new one', () => {
  const tracks = buildTracks([
    sig(54.19, 37.62, 0),
    sig(54.63, 39.69, 30, { status: 'shot_down' }),
    sig(54.90, 40.50, 55), // after the kill → different object
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].points.length, 2);
  assert.equal(tracks[0].ended, true);
});

test('repeat reports of the same place merge instead of zero-legs', () => {
  const tracks = buildTracks([
    sig(54.19, 37.62, 0, { location: 'Tula' }),
    sig(54.20, 37.63, 10, { location: 'Tula', count: 5 }), // same spot again
    sig(54.63, 39.69, 45, { location: 'Ryazan' }),
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].points.length, 2); // Tula (merged) + Ryazan
  assert.equal(tracks[0].points[0].count, 5); // count refreshed by the repeat
});

test('sharp reversals do not chain (turn-angle limit)', () => {
  const tracks = buildTracks([
    sig(54.0, 37.0, 0),
    sig(54.0, 38.5, 30),  // heading east
    sig(54.0, 37.05, 60), // straight back west — not one flight
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].points.length, 2);
});

test('region-centroid and alert/all_clear records are not track points', () => {
  assert.equal(isTrackable(sig(54, 37, 0, { geocodePrecision: 'region' })), false);
  assert.equal(isTrackable(sig(54, 37, 0, { status: 'alert' })), false);
  assert.equal(isTrackable(sig(54, 37, 0, { status: 'all_clear' })), false);
  assert.equal(isTrackable(sig(54, 37, 0)), true);
  assert.equal(isTrackable(sig(54, 37, 0, { status: 'impact' })), true);
});

test('threatClass groups missile variants together', () => {
  assert.equal(threatClass('drone'), 'drone');
  assert.equal(threatClass('aircraft'), 'aircraft');
  assert.equal(threatClass('missile'), 'missile');
  assert.equal(threatClass('cruise_missile'), 'missile');
  assert.equal(threatClass('ballistic_missile'), 'missile');
  assert.equal(threatClass('explosion'), 'other');
});

test('drones and aircraft do not chain together', () => {
  const tracks = buildTracks([
    sig(45.0, 33.0, 0, { threatType: 'drone' }),
    sig(45.3, 34.0, 20, { threatType: 'aircraft' }),
  ]);
  assert.equal(tracks.length, 0);
});

test('same post, different object_id never chain (AI separated them)', () => {
  // Geometrically these would chain (close, consistent course, 20 min apart),
  // but the AI tagged them as two different objects in the same post — so they
  // must stay apart (e.g. a missile and the drones mentioned beside it).
  const tracks = buildTracks([
    sig(54.0, 37.0, 0, { postId: 5, objectId: 1, location: 'X' }),
    sig(54.3, 37.8, 20, { postId: 5, objectId: 2, location: 'Y' }),
  ]);
  assert.equal(tracks.length, 0);
});

test('same post + same object_id chains even through a sharp turn', () => {
  // The turn-angle limit would normally reject the reversal (see the sharp-
  // reversal test), but when the AI reads all three as ONE object's path we
  // trust its grouping and keep the chain.
  const tracks = buildTracks([
    sig(54.0, 37.0, 0, { postId: 9, objectId: 1 }),
    sig(54.0, 38.5, 30, { postId: 9, objectId: 1 }),
    sig(54.0, 37.05, 60, { postId: 9, objectId: 1 }),
  ]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].points.length, 3);
});

test('two parallel groups produce two tracks', () => {
  const tracks = buildTracks([
    // Group A moving NE
    sig(54.0, 37.0, 0, { location: 'A1' }),
    sig(54.5, 38.0, 30, { location: 'A2' }),
    // Group B far to the south, also moving
    sig(48.0, 40.0, 5, { location: 'B1' }),
    sig(48.5, 41.0, 35, { location: 'B2' }),
  ]);
  assert.equal(tracks.length, 2);
  const locs = tracks.map((t) => t.points.map((p) => p.location).join('>')).sort();
  assert.deepEqual(locs, ['A1>A2', 'B1>B2']);
});
