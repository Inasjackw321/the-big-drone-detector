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

test('resolves major Ukrainian cities from the gazetteer', async () => {
  const g = makeGeocoder();
  const kyiv = await g.resolve({ location: 'Kyiv' });
  assert.equal(kyiv.source, 'gazetteer');
  assert.ok(Math.abs(kyiv.lat - 50.45) < 0.1 && Math.abs(kyiv.lon - 30.52) < 0.1);
  const kharkiv = await g.resolve({ location: 'Харків' });
  assert.equal(kharkiv.matchedName, 'Kharkiv');
});

test('resolves Ukrainian towns and colloquial oblast forms', async () => {
  const g = makeGeocoder();
  const okhtyrka = await g.resolve({ location: 'Okhtyrka', region: 'Sumy Oblast' });
  assert.equal(okhtyrka.source, 'gazetteer'); // the town itself, not the Sumy centroid
  assert.ok(Math.abs(okhtyrka.lat - 50.31) < 0.1);
  const sumshchyna = await g.resolve({ location: 'Сумщина' });
  assert.equal(sumshchyna.matchedName, 'Sumy');
});

test('geocodes a specific town via Nominatim before the region centroid', async () => {
  let url = '';
  const fetchImpl = async (u) => {
    url = u;
    return { ok: true, json: async () => [{ display_name: 'Velyka Pysarivka', lat: '50.42', lon: '35.48' }] };
  };
  const g = new Geocoder({ fetchImpl });
  const r = await g.resolve({ location: 'Velyka Pysarivka', region: 'Sumy Oblast' });
  assert.equal(r.source, 'nominatim'); // not the Sumy oblast centroid
  assert.ok(Math.abs(r.lat - 50.42) < 0.001);
  assert.ok(!/Russia/i.test(decodeURIComponent(url))); // country left to countrycodes
  assert.match(url, /countrycodes=ru,ua/);
});

test('rejects a geocode that lands far from the stated oblast', async () => {
  // Nominatim returns a same-named place thousands of km away.
  const fetchImpl = async () => ({ ok: true, json: async () => [{ display_name: 'Faketown', lat: '60.0', lon: '100.0' }] });
  const g = new Geocoder({ fetchImpl });
  const r = await g.resolve({ location: 'Faketown', region: 'Sumy Oblast' });
  assert.equal(r.source, 'gazetteer-region'); // far hit replaced by the Sumy centroid
  assert.ok(Math.abs(r.lat - 50.9) < 0.3);
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

test('warm-starts from a persisted cache and dumps it back', async () => {
  const initialCache = {
    'fakeville|sumy oblast': { lat: 50.4, lon: 35.5, source: 'nominatim', matchedName: 'Fakeville', region: 'Sumy Oblast', precision: 'point' },
  };
  const g = new Geocoder({ enableNominatim: false, initialCache });
  const r = await g.resolve({ location: 'Fakeville', region: 'Sumy Oblast' });
  assert.equal(r.source, 'nominatim'); // came from the warm cache, no network
  assert.ok(Math.abs(r.lat - 50.4) < 0.001);
  const dumped = g.dumpCache();
  assert.ok(dumped['fakeville|sumy oblast']);
});
