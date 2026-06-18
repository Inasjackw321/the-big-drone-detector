'use strict';

/**
 * Turns a place name into coordinates. Resolution order:
 *   1. LLM-provided coordinates (only when confident) — instant, no network.
 *   2. Offline gazetteer of common Russian places — instant, no network.
 *   3. Nominatim (OpenStreetMap) lookup — network, rate-limited & cached.
 *
 * The gazetteer covers the places that dominate this channel, so most posts
 * resolve with zero network calls. Results are cached in-memory.
 */

const fs = require('fs');
const path = require('path');

function normalizeKey(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`.,()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class Geocoder {
  constructor({ gazetteerPath, fetchImpl, userAgent, enableNominatim = true } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.userAgent =
      userAgent || 'the-big-drone-detector/1.0 (https://github.com/Inasjackw321/the-big-drone-detector)';
    this.enableNominatim = enableNominatim;
    this.cache = new Map();
    this.index = new Map();
    this._lastNominatimAt = 0;
    this._loadGazetteer(
      gazetteerPath || path.join(__dirname, '..', 'data', 'ru-gazetteer.json')
    );
  }

  _loadGazetteer(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const place of data.places || []) {
        const entry = {
          name: place.name,
          region: place.region || '',
          lat: place.lat,
          lon: place.lon,
          source: 'gazetteer',
        };
        const keys = new Set([
          normalizeKey(place.name),
          normalizeKey(place.ru),
          ...(place.aliases || []).map(normalizeKey),
        ]);
        for (const k of keys) {
          if (k) this.index.set(k, entry);
        }
      }
    } catch (err) {
      console.warn('[geocode] failed to load gazetteer:', err.message);
    }
  }

  /** Synchronous gazetteer-only lookup. Returns entry or null. */
  lookupLocal(name, region) {
    if (!name) return null;
    const key = normalizeKey(name);
    if (this.index.has(key)) return this.index.get(key);

    // Try "name region" combined and region alone as a coarse fallback.
    if (region) {
      const combo = normalizeKey(`${name} ${region}`);
      if (this.index.has(combo)) return this.index.get(combo);
      const rkey = normalizeKey(region);
      if (this.index.has(rkey)) {
        return { ...this.index.get(rkey), source: 'gazetteer-region' };
      }
    }

    // Loose contains match against multi-word keys (e.g. "kursk airbase").
    for (const [k, entry] of this.index) {
      if (k.includes(key) && key.length >= 4) return entry;
    }
    return null;
  }

  async _nominatim(query, timeoutMs) {
    if (!this.enableNominatim || typeof this.fetchImpl !== 'function') return null;
    // Respect Nominatim's 1 req/sec usage policy.
    const wait = 1100 - (Date.now() - this._lastNominatimAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastNominatimAt = Date.now();

    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en&q=' +
      encodeURIComponent(query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        return {
          name: arr[0].display_name?.split(',')[0] || query,
          region: '',
          lat: parseFloat(arr[0].lat),
          lon: parseFloat(arr[0].lon),
          source: 'nominatim',
        };
      }
    } catch {
      /* network/timeout — fall through */
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  /**
   * Resolve a sighting's coordinates.
   * @param {{location:string, region?:string, lat?:number|null, lon?:number|null}} sighting
   * @returns {Promise<{lat:number, lon:number, source:string, matchedName:string, region:string}|null>}
   */
  async resolve(sighting, timeoutMs = 12000) {
    // 1) Trust confident LLM coordinates.
    if (
      typeof sighting.lat === 'number' &&
      typeof sighting.lon === 'number' &&
      Math.abs(sighting.lat) <= 90 &&
      Math.abs(sighting.lon) <= 180
    ) {
      return {
        lat: sighting.lat,
        lon: sighting.lon,
        source: 'llm',
        matchedName: sighting.location,
        region: sighting.region || '',
      };
    }

    const cacheKey = normalizeKey(`${sighting.location}|${sighting.region || ''}`);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    // 2) Offline gazetteer.
    let hit = this.lookupLocal(sighting.location, sighting.region);

    // 3) Nominatim, biased to Russia.
    if (!hit) {
      const q = sighting.region
        ? `${sighting.location}, ${sighting.region}, Russia`
        : `${sighting.location}, Russia`;
      hit = await this._nominatim(q, timeoutMs);
    }

    const result = hit
      ? {
          lat: hit.lat,
          lon: hit.lon,
          source: hit.source,
          matchedName: hit.name || sighting.location,
          region: hit.region || sighting.region || '',
        }
      : null;
    this.cache.set(cacheKey, result);
    return result;
  }
}

module.exports = { Geocoder, normalizeKey };
