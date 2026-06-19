'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Geocoder, normalizeKey } = require('../src/services/geocode');

function makeGeocoder() {
  // Disable Nominatim so tests never touch the network.
  return new Geocoder({ enableNominatim: false });
}

test('normalizeKey lowercases and normalizes yo/punctuation', () => {
  assert.equal(normalizeKey('Орёл'), 'орел');
  assert.equal(normalizeKey('  Saint-Petersburg, '), 'saint-petersburg');
});

test('resolves English city names from the gazetteer', async () => {
  const g = makeGeocoder();
  const r = await g.resolve({ location: 'Voronezh' });
  assert.equal(r.source, 'gazetteer');
  assert.ok(Math.abs(r.lat - 51.66) < 0.1);
  assert.ok(Math.abs(r.lon - 39.2) < 0.1);
});

test('resolves Cyrillic names and declensions via aliases', async () => {
  const g = makeGeocoder();
  const r1 = await g.resolve({ location: 'Белгороде' }); // prepositional case
  assert.equal(r1.matchedName, 'Belgorod');
  const r2 = await g.resolve({ location: 'Энгельс' });
  assert.equal(r2.matchedName, 'Engels');
});

test('uses LLM coordinates only as a fallback for unknown places', async () => {
  const g = makeGeocoder();
  const r = await g.resolve({ location: 'Nowhere', lat: 55.0, lon: 60.0 });
  assert.equal(r.source, 'llm');
  assert.equal(r.lat, 55.0);
  assert.equal(r.lon, 60.0);
  assert.equal(r.precision, 'point');
});

test('prefers the curated gazetteer over LLM-guessed coordinates', async () => {
  const g = makeGeocoder();
  const r = await g.resolve({ location: 'Voronezh', lat: 10, lon: 10 });
  assert.equal(r.source, 'gazetteer'); // not the model's bogus (10,10)
  assert.ok(Math.abs(r.lat - 51.66) < 0.1);
});

test('rejects LLM coordinates that fall outside the region', async () => {
  const g = makeGeocoder(); // Nominatim disabled
  const r = await g.resolve({ location: 'Nowhere', lat: 10, lon: 10 });
  assert.equal(r, null);
});

test('falls back to region centroid when only a region is known', async () => {
  const g = makeGeocoder();
  const r = await g.resolve({
    location: 'SomeVillage',
    region: 'Belgorod Oblast',
  });
  assert.ok(r, 'should resolve via region');
  assert.equal(r.source, 'gazetteer-region');
});

test('returns null when nothing matches and Nominatim is disabled', async () => {
  const g = makeGeocoder();
  const r = await g.resolve({ location: 'Zzxqplce', region: 'Atlantis' });
  assert.equal(r, null);
});

test('caches results for repeat lookups', async () => {
  const g = makeGeocoder();
  const a = await g.resolve({ location: 'Kazan' });
  const b = await g.resolve({ location: 'Kazan' });
  assert.deepEqual(a, b);
});
