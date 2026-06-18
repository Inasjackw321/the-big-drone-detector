'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  OpenRouterClient,
  extractJsonObject,
  normalizeExtraction,
} = require('../src/services/openrouter');

test('extractJsonObject handles code fences and surrounding prose', () => {
  const raw = 'Sure!\n```json\n{"is_relevant": true, "sightings": []}\n```\nDone.';
  const obj = extractJsonObject(raw);
  assert.equal(obj.is_relevant, true);
});

test('extractJsonObject handles nested braces and strings with braces', () => {
  const raw = '{"summary":"a {weird} value","sightings":[{"location":"X"}]}';
  const obj = extractJsonObject(raw);
  assert.equal(obj.summary, 'a {weird} value');
  assert.equal(obj.sightings[0].location, 'X');
});

test('extractJsonObject returns null on non-JSON', () => {
  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(extractJsonObject(''), null);
});

test('normalizeExtraction validates and clamps fields', () => {
  const out = normalizeExtraction({
    is_relevant: true,
    summary: 'x'.repeat(500),
    sightings: [
      {
        location: 'Voronezh',
        region: 'Voronezh Oblast',
        threat_type: 'drone',
        count: 3,
        status: 'approaching',
        confidence: 5, // should clamp to 1
        lat: 51.6,
        lon: 39.2,
      },
      {
        location: '', // dropped (no location)
        threat_type: 'drone',
      },
      {
        location: 'Bad',
        threat_type: 'laser', // invalid -> unknown
        status: 'dancing', // invalid -> unknown
        confidence: 'high', // invalid -> 0.5
        lat: 999, // invalid -> null
        lon: 39,
      },
    ],
  });
  assert.equal(out.isRelevant, true);
  assert.equal(out.summary.length, 300);
  assert.equal(out.sightings.length, 2);

  const a = out.sightings[0];
  assert.equal(a.threatType, 'drone');
  assert.equal(a.count, 3);
  assert.equal(a.confidence, 1);
  assert.equal(a.lat, 51.6);

  const b = out.sightings[1];
  assert.equal(b.location, 'Bad');
  assert.equal(b.threatType, 'unknown');
  assert.equal(b.status, 'unknown');
  assert.equal(b.confidence, 0.5);
  assert.equal(b.lat, null); // out-of-range latitude rejected
});

test('extractSightings posts to the right endpoint and parses content', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"is_relevant":true,"summary":"UAV near Kursk","sightings":[{"location":"Kursk","threat_type":"drone","status":"approaching","confidence":0.9}]}',
            },
          },
        ],
      }),
    };
  };
  const client = new OpenRouterClient({
    apiKey: 'test-key',
    model: 'openrouter/owl-alpha',
    fetchImpl: fakeFetch,
  });
  const res = await client.extractSightings({
    text: 'БпЛА на Курск',
    link: 'https://t.me/x/1',
    date: '2026-06-18T10:00:00Z',
  });

  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.opts.method, 'POST');
  assert.match(captured.opts.headers.Authorization, /Bearer test-key/);
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, 'openrouter/owl-alpha');

  assert.equal(res.isRelevant, true);
  assert.equal(res.sightings[0].location, 'Kursk');
  assert.equal(res.sightings[0].threatType, 'drone');
});

test('extractSightings throws without an API key', async () => {
  const client = new OpenRouterClient({ apiKey: '' });
  await assert.rejects(() => client.extractSightings({ text: 'x' }), /API key/);
});

test('extractSightings surfaces HTTP errors', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
  });
  const client = new OpenRouterClient({ apiKey: 'k', fetchImpl: fakeFetch });
  await assert.rejects(() => client.extractSightings({ text: 'x' }), /HTTP 429/);
});
