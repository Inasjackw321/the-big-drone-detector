'use strict';

/**
 * Local Ollama client — runs extraction fully on-device, no API key, no rate
 * limits, no cloud. Talks to the Ollama REST API (default localhost:11434).
 *
 * Accuracy features:
 *  - Structured outputs: the JSON schema is passed as the `format` field, so
 *    Ollama constrains generation to schema-valid JSON (no parse failures).
 *  - temperature 0 for deterministic, repeatable extractions.
 *  - Optional second "verification" pass: the model re-reads the post next to
 *    the first-pass JSON and must confirm or correct every field — catching
 *    hallucinated places, wrong counts and mixed-up statuses before anything
 *    reaches the map.
 *
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

const { SYSTEM_PROMPT, extractJsonObject, normalizeExtraction } = require('./openrouter');

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'translategemma:12b';

// JSON schema mirroring the shape SYSTEM_PROMPT asks for. Passed to Ollama's
// `format` field so the model literally cannot emit anything else.
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    is_relevant: { type: 'boolean' },
    summary: { type: 'string' },
    sightings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          location_ru: { type: 'string' },
          region: { type: 'string' },
          lat: { type: ['number', 'null'] },
          lon: { type: ['number', 'null'] },
          threat_type: {
            type: 'string',
            enum: ['drone', 'missile', 'cruise_missile', 'ballistic_missile', 'explosion', 'air_defense', 'unknown'],
          },
          count: { type: ['integer', 'null'] },
          heading: {
            type: ['string', 'null'],
            enum: ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west', null],
          },
          destination: { type: ['string', 'null'] },
          status: {
            type: 'string',
            enum: ['approaching', 'overhead', 'shot_down', 'impact', 'alert', 'all_clear', 'unknown'],
          },
          confidence: { type: 'number' },
        },
        required: ['location', 'threat_type', 'status', 'confidence'],
      },
    },
  },
  required: ['is_relevant', 'summary', 'sightings'],
};

const VERIFY_PROMPT = `You are a strict OSINT fact-checker. You are given a Telegram post (Russian or Ukrainian) about aerial threats, and a JSON extraction produced from it by another analyst.

Re-read the POST carefully and output a CORRECTED version of the extraction with the exact same JSON schema:
- DELETE any sighting whose location is not actually mentioned in the post (hallucinations), or that is a sea / whole country, or that duplicates the DESTINATION a threat is merely heading toward.
- FIX any wrong field: count must appear in the post for that exact place; status must match the post's wording (отбой→all_clear, сбит/збито→shot_down, прилёт/вибух→impact, работа ПВО/ППО→overhead, опасность/тривога→alert, фиксация/курс/летять→approaching); destination must be the place the threat is moving TOWARD, or null.
- If a sighting is fully correct, copy it unchanged.
- If the post is not about a specific aerial threat over identifiable places (ads, recap totals over many oblasts, generic news), set is_relevant=false and sightings=[].
- Lower "confidence" for anything you were unsure about; raise it (max 1.0) for clear, unambiguous sightings.
Output JSON only.`;

class OllamaClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl] Ollama server (default http://127.0.0.1:11434)
   * @param {string} [opts.model]   model name, e.g. "translategemma:12b"
   * @param {string[]} [opts.models] fallback cascade (index advances per retry)
   * @param {boolean} [opts.verify] run the second verification pass (default true)
   * @param {typeof fetch} [opts.fetchImpl] inject for testing
   */
  constructor({ baseUrl, model, models, verify = true, fetchImpl } = {}) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.models = models || (model ? [model] : [DEFAULT_MODEL]);
    this.model = this.models[0];
    this.verify = verify;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  async _chat(messages, timeoutMs, modelIndex = 0) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('ollama: no fetch implementation available');
    }
    const model = this.models[modelIndex % this.models.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          format: EXTRACTION_SCHEMA, // structured output: schema-valid or nothing
          options: { temperature: 0, num_ctx: 4096 },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      throw new Error(`ollama: HTTP ${res.status} ${detail}`);
    }
    const data = await res.json();
    const content = data?.message?.content ?? '';
    const parsed = extractJsonObject(content);
    if (!parsed) throw new Error('ollama: model did not return parseable JSON');
    return parsed;
  }

  /**
   * Extract structured sightings from a single Telegram post. Same interface
   * as OpenRouterClient so pipelines can swap backends transparently.
   * @param {{text:string, link?:string, date?:string}} post
   * @param {number} [timeoutMs] generous default — local models can be slow to warm
   * @param {number} [modelIndex] cascade index (wraps)
   */
  async extractSightings(post, timeoutMs = 120000, modelIndex = 0) {
    const userContent = `Post date: ${post.date || 'unknown'}\nPost link: ${
      post.link || 'unknown'
    }\n\nPost text:\n"""\n${post.text || ''}\n"""`;

    const first = normalizeExtraction(
      await this._chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        timeoutMs,
        modelIndex
      )
    );

    // Nothing extracted → nothing to verify.
    if (!this.verify || !first.isRelevant || !first.sightings.length) return first;

    // Second pass: the model must confirm or correct its own extraction while
    // re-reading the source post. Any failure here keeps the first pass.
    try {
      const verified = normalizeExtraction(
        await this._chat(
          [
            { role: 'system', content: VERIFY_PROMPT },
            {
              role: 'user',
              content: `${userContent}\n\nFirst-pass extraction to check:\n${JSON.stringify(
                denormalize(first)
              )}`,
            },
          ],
          timeoutMs,
          modelIndex
        )
      );
      return verified;
    } catch {
      return first;
    }
  }

  /** Is the Ollama server reachable? */
  async ping(timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Names of locally available models (empty array if unreachable). */
  async listModels(timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || []).map((m) => m.name).filter(Boolean);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

// Convert our internal camelCase shape back to the schema's snake_case for the
// verification prompt, so the model sees the same field names it must output.
function denormalize(extraction) {
  return {
    is_relevant: extraction.isRelevant,
    summary: extraction.summary,
    sightings: extraction.sightings.map((s) => ({
      location: s.location,
      location_ru: s.locationRu,
      region: s.region,
      lat: s.lat,
      lon: s.lon,
      threat_type: s.threatType,
      count: s.count,
      heading: s.heading,
      destination: s.destination,
      status: s.status,
      confidence: s.confidence,
    })),
  };
}

module.exports = {
  OllamaClient,
  EXTRACTION_SCHEMA,
  VERIFY_PROMPT,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  denormalize,
};
