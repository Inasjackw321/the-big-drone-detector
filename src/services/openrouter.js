'use strict';

/**
 * OpenRouter client that turns a raw Telegram post into structured drone /
 * air-threat sightings. Uses the free "owl-alpha" stealth model by default.
 *
 * Docs: https://openrouter.ai/docs
 */

const SYSTEM_PROMPT = `You are an OSINT analyst that reads short posts (usually Russian) from a Telegram channel that tracks aerial threats (UAVs/drones, cruise missiles, ballistic missiles) over the Russian Federation and nearby occupied areas.

For the given post, extract EVERY distinct geographic sighting/threat mentioned. A single post can contain several locations.

Return STRICT JSON only (no markdown, no commentary) matching this schema:
{
  "is_relevant": boolean,            // true if the post reports an aerial threat / drone activity
  "summary": string,                 // one short English sentence summarizing the post
  "sightings": [
    {
      "location": string,            // place name in English transliteration (city/town/raion/airbase)
      "location_ru": string,         // place name as written in the post (or "")
      "region": string,              // oblast/krai/republic in English, or ""
      "lat": number|null,            // your best-known latitude if you are confident, else null
      "lon": number|null,            // your best-known longitude if you are confident, else null
      "threat_type": string,         // one of: "drone", "missile", "cruise_missile", "ballistic_missile", "explosion", "air_defense", "unknown"
      "count": number|null,          // number of objects if stated, else null
      "heading": string|null,        // compass direction of travel, normalized to one of: "north","north-east","east","south-east","south","south-west","west","north-west"; else null
      "destination": string|null,    // place/city the threat is moving TOWARD if stated (e.g. "Moscow" from "курс на Москву" / "в сторону Москвы" / "движется на"), else null
      "status": string,              // one of: "approaching", "overhead", "shot_down", "impact", "alert", "all_clear", "unknown"
      "confidence": number           // 0..1 how confident this is a real, locatable sighting
    }
  ]
}

Rules:
- If the post is not about an aerial threat (ads, chat, unrelated news), set is_relevant=false and sightings=[].
- Prefer the most specific place mentioned. If only a region is given, use the region as the location.
- Pay close attention to MOVEMENT:
  * "destination" = the PLACE NAME the threat is moving toward (English name). Extract from phrases like "курс на X", "в сторону X", "движется/летит/направляется на X", "в направлении X", "в направлении Москвы" → "Moscow". Leave null only when no destination place is mentioned.
  * "heading" = the compass direction ONLY. Must be EXACTLY one of: "north","north-east","east","south-east","south","south-west","west","north-west". Derive it from explicit direction words ("north", "север", "восток", etc.) or from knowing which direction the destination city is from the sighting. NEVER put place names in heading. If you cannot determine a compass direction with confidence, set heading to null.
  * Examples: "в направлении Москвы" from Тула → destination="Moscow", heading="north". "курс на восток" → heading="east". "в сторону Курска" from Белгород → destination="Kursk", heading="north".
- Only fill lat/lon when you are genuinely confident of the coordinates; otherwise null and the app will geocode.
- Never invent locations or directions that are not in the post.
- Output JSON only.`;

/** Pull the first balanced JSON object out of a model response. */
function extractJsonObject(text) {
  if (!text) return null;
  let s = text.trim();
  // Strip code fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const THREAT_TYPES = new Set([
  'drone',
  'missile',
  'cruise_missile',
  'ballistic_missile',
  'explosion',
  'air_defense',
  'unknown',
]);
const STATUSES = new Set([
  'approaching',
  'overhead',
  'shot_down',
  'impact',
  'alert',
  'all_clear',
  'unknown',
]);

/** Validate & normalize the raw model JSON into our internal shape. */
function normalizeExtraction(raw) {
  const out = { isRelevant: false, summary: '', sightings: [] };
  if (!raw || typeof raw !== 'object') return out;
  out.isRelevant = Boolean(raw.is_relevant);
  out.summary = typeof raw.summary === 'string' ? raw.summary.slice(0, 300) : '';
  const list = Array.isArray(raw.sightings) ? raw.sightings : [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const location = (s.location || s.location_ru || '').toString().trim();
    if (!location) continue;
    const lat = typeof s.lat === 'number' && isFinite(s.lat) ? s.lat : null;
    const lon = typeof s.lon === 'number' && isFinite(s.lon) ? s.lon : null;
    out.sightings.push({
      location,
      locationRu: (s.location_ru || '').toString().trim(),
      region: (s.region || '').toString().trim(),
      lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
      lon: lon !== null && Math.abs(lon) <= 180 ? lon : null,
      threatType: THREAT_TYPES.has(s.threat_type) ? s.threat_type : 'unknown',
      count: typeof s.count === 'number' && isFinite(s.count) ? s.count : null,
      heading: s.heading ? s.heading.toString().trim() : null,
      destination: s.destination ? s.destination.toString().trim() : null,
      status: STATUSES.has(s.status) ? s.status : 'unknown',
      confidence:
        typeof s.confidence === 'number' && isFinite(s.confidence)
          ? Math.max(0, Math.min(1, s.confidence))
          : 0.5,
    });
  }
  return out;
}

class OpenRouterClient {
  constructor({ apiKey, model, baseUrl, fetchImpl } = {}) {
    this.apiKey = apiKey;
    this.model = model || 'openrouter/owl-alpha';
    this.baseUrl = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  /**
   * Extract structured sightings from a single Telegram post.
   * @param {{text:string, link?:string, date?:string}} post
   * @param {number} [timeoutMs]
   * @returns {Promise<{isRelevant:boolean, summary:string, sightings:Array}>}
   */
  async extractSightings(post, timeoutMs = 45000) {
    if (!this.apiKey) throw new Error('openrouter: missing API key');
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('openrouter: no fetch implementation available');
    }
    const userContent = `Post date: ${post.date || 'unknown'}\nPost link: ${
      post.link || 'unknown'
    }\n\nPost text:\n"""\n${post.text || ''}\n"""`;

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 1200,
      // Best-effort JSON nudge; harmlessly ignored by models that don't support it.
      response_format: { type: 'json_object' },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          // Optional attribution headers recommended by OpenRouter.
          'HTTP-Referer': 'https://github.com/Inasjackw321/the-big-drone-detector',
          'X-Title': 'The Big Drone Detector',
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      throw new Error(`openrouter: HTTP ${res.status} ${detail}`);
    }

    const data = await res.json();
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      '';
    const parsed = extractJsonObject(content);
    if (!parsed) {
      throw new Error('openrouter: model did not return parseable JSON');
    }
    return normalizeExtraction(parsed);
  }

  /** Quick connectivity / auth check. */
  async ping(timeoutMs = 15000) {
    if (!this.apiKey) throw new Error('openrouter: missing API key');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  OpenRouterClient,
  SYSTEM_PROMPT,
  extractJsonObject,
  normalizeExtraction,
};
