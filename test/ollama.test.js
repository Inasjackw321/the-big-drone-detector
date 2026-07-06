'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { OllamaClient, EXTRACTION_SCHEMA, denormalize, DEFAULT_MODEL } = require('../src/services/ollama');

// A fake fetch that records requests and replies with canned Ollama responses.
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, method: opts && opts.method });
    return handler(url, body, calls.length);
  };
  impl.calls = calls;
  return impl;
}
function chatReply(obj) {
  return { ok: true, json: async () => ({ message: { content: JSON.stringify(obj) } }) };
}

const POST = { text: 'Тула, Тульская область. Фиксация от 5 БПЛА, курс на Москву.', date: '2026-07-04T00:00:00Z', link: 'https://t.me/radarrussiia/1' };

test('default model is translategemma:12b', () => {
  const c = new OllamaClient();
  assert.equal(c.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'translategemma:12b');
});

test('sends schema in the format field and hits /api/chat', async () => {
  const fetchImpl = fakeFetch(() => chatReply({ is_relevant: true, summary: 'x', sightings: [] }));
  const c = new OllamaClient({ model: 'translategemma:12b', verify: false, fetchImpl });
  await c.extractSightings(POST);
  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/api\/chat$/);
  assert.equal(call.body.model, 'translategemma:12b');
  assert.deepEqual(call.body.format, EXTRACTION_SCHEMA);
  assert.equal(call.body.options.temperature, 0);
  assert.equal(call.body.stream, false);
});

test('normalizes an extraction into internal shape', async () => {
  const fetchImpl = fakeFetch(() => chatReply({
    is_relevant: true,
    summary: 'Drone over Tula heading to Moscow',
    sightings: [{
      location: 'Tula', location_ru: 'Тула', region: 'Tula Oblast',
      lat: null, lon: null, threat_type: 'drone', count: 5,
      heading: 'north', destination: 'Moscow', status: 'approaching', confidence: 0.9,
    }],
  }));
  const c = new OllamaClient({ verify: false, fetchImpl });
  const out = await c.extractSightings(POST);
  assert.equal(out.isRelevant, true);
  assert.equal(out.sightings.length, 1);
  assert.equal(out.sightings[0].location, 'Tula');
  assert.equal(out.sightings[0].count, 5);
  assert.equal(out.sightings[0].destination, 'Moscow');
  assert.equal(out.sightings[0].threatType, 'drone');
});

test('verification pass runs a second call and its result wins', async () => {
  let n = 0;
  const fetchImpl = fakeFetch(() => {
    n++;
    if (n === 1) {
      // First pass: two sightings, one is a hallucinated destination echo.
      return chatReply({ is_relevant: true, summary: 's', sightings: [
        { location: 'Tula', threat_type: 'drone', status: 'approaching', confidence: 0.8, destination: 'Moscow' },
        { location: 'Moscow', threat_type: 'drone', status: 'approaching', confidence: 0.5 },
      ] });
    }
    // Verify pass: corrects to a single real sighting.
    return chatReply({ is_relevant: true, summary: 's', sightings: [
      { location: 'Tula', threat_type: 'drone', status: 'approaching', confidence: 0.95, destination: 'Moscow' },
    ] });
  });
  const c = new OllamaClient({ verify: true, fetchImpl });
  const out = await c.extractSightings(POST);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(out.sightings.length, 1);
  assert.equal(out.sightings[0].location, 'Tula');
  assert.equal(out.sightings[0].confidence, 0.95);
  // The verify prompt must include the first-pass JSON to check.
  assert.match(fetchImpl.calls[1].body.messages[1].content, /First-pass extraction/);
});

test('verification is skipped when the first pass found nothing', async () => {
  const fetchImpl = fakeFetch(() => chatReply({ is_relevant: false, summary: '', sightings: [] }));
  const c = new OllamaClient({ verify: true, fetchImpl });
  const out = await c.extractSightings(POST);
  assert.equal(fetchImpl.calls.length, 1); // no second call
  assert.equal(out.isRelevant, false);
});

test('a failing verify pass falls back to the first pass', async () => {
  let n = 0;
  const fetchImpl = fakeFetch(() => {
    n++;
    if (n === 1) return chatReply({ is_relevant: true, summary: 's', sightings: [
      { location: 'Kursk', threat_type: 'drone', status: 'alert', confidence: 0.7 },
    ] });
    return { ok: false, status: 500, text: async () => 'boom' };
  });
  const c = new OllamaClient({ verify: true, fetchImpl });
  const out = await c.extractSightings(POST);
  assert.equal(out.sightings.length, 1);
  assert.equal(out.sightings[0].location, 'Kursk');
});

test('modelIndex selects a model from the cascade', async () => {
  const fetchImpl = fakeFetch(() => chatReply({ is_relevant: false, summary: '', sightings: [] }));
  const c = new OllamaClient({ models: ['a:1', 'b:2', 'c:3'], verify: false, fetchImpl });
  await c.extractSightings(POST, 1000, 1);
  assert.equal(fetchImpl.calls[0].body.model, 'b:2');
});

test('ping returns true when /api/tags is reachable', async () => {
  const fetchImpl = fakeFetch((url) => {
    assert.match(url, /\/api\/tags$/);
    return { ok: true, json: async () => ({ models: [] }) };
  });
  const c = new OllamaClient({ fetchImpl });
  assert.equal(await c.ping(), true);
});

test('listModels returns installed model names', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({ models: [{ name: 'translategemma:12b' }, { name: 'llama3:8b' }] }) }));
  const c = new OllamaClient({ fetchImpl });
  const models = await c.listModels();
  assert.deepEqual(models, ['translategemma:12b', 'llama3:8b']);
});

test('denormalize round-trips field names for the verify prompt', () => {
  const internal = { isRelevant: true, summary: 'x', sightings: [
    { location: 'Tula', locationRu: 'Тула', region: 'r', lat: 1, lon: 2, threatType: 'drone', count: 3, heading: 'north', destination: 'Moscow', status: 'approaching', confidence: 0.9 },
  ] };
  const snake = denormalize(internal);
  assert.equal(snake.is_relevant, true);
  assert.equal(snake.sightings[0].threat_type, 'drone');
  assert.equal(snake.sightings[0].location_ru, 'Тула');
  assert.equal(snake.sightings[0].destination, 'Moscow');
});
