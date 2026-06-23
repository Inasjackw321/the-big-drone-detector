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

// Plausible bounding box for the Russian Federation + nearby occupied areas.
// Used to reject obviously-wrong coordinates (e.g. a same-named city abroad).
function inRegionBbox(lat, lon) {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    lat >= 41 && lat <= 78 && lon >= 19 && lon <= 180
  );
}

// Great-circle distance in km, for region-bounds sanity checks.
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLa = toRad(lat2 - lat1), dLo = toRad(lon2 - lon1);
  const a = Math.sin(dLa / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

class Geocoder {
  constructor({ gazetteerPath, fetchImpl, userAgent, enableNominatim = true, initialCache } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.userAgent =
      userAgent || 'the-big-drone-detector/1.0 (https://github.com/Inasjackw321/the-big-drone-detector)';
    this.enableNominatim = enableNominatim;
    this.cache = new Map();
    this.index = new Map();
    this._lastNominatimAt = 0;
    this._nomChain = Promise.resolve(); // serialises Nominatim under parallelism
    // Warm-start the cache from a persisted geocode cache so repeat places
    // resolve instantly (and identically) instead of re-hitting Nominatim.
    if (initialCache && typeof initialCache === 'object') {
      for (const [k, v] of Object.entries(initialCache)) {
        if (v && typeof v.lat === 'number') this.cache.set(k, v);
      }
    }
    this._loadGazetteer(
      gazetteerPath || path.join(__dirname, '..', 'data', 'ru-gazetteer.json')
    );
  }

  /** Plain object of every resolved place, for persisting across runs. */
  dumpCache() {
    const out = {};
    for (const [k, v] of this.cache) {
      if (v && typeof v.lat === 'number') out[k] = v;
    }
    return out;
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

  /** Strict gazetteer lookup of a specific place (no region-centroid fallback). */
  lookupLocal(name, region) {
    if (!name) return null;
    const key = normalizeKey(name);
    if (this.index.has(key)) return this.index.get(key);

    // Try "name region" combined.
    if (region) {
      const combo = normalizeKey(`${name} ${region}`);
      if (this.index.has(combo)) return this.index.get(combo);
    }

    // Loose contains match against multi-word keys (e.g. "kursk airbase").
    for (const [k, entry] of this.index) {
      if (k.includes(key) && key.length >= 4) return entry;
    }
    return null;
  }

  /** Coarse region-centroid fallback — only used when nothing else resolves. */
  lookupRegion(region) {
    if (!region) return null;
    const rkey = normalizeKey(region);
    if (this.index.has(rkey)) {
      return { ...this.index.get(rkey), source: 'gazetteer-region' };
    }
    return null;
  }

  // Serialise Nominatim across (possibly parallel) callers so we never exceed
  // the 1 req/sec usage policy even when many posts are processed at once.
  async _nominatim(query, timeoutMs) {
    if (!this.enableNominatim || typeof this.fetchImpl !== 'function') return null;
    const task = () => this._nominatimRequest(query, timeoutMs);
    this._nomChain = this._nomChain.then(task, task);
    return this._nomChain;
  }

  async _nominatimRequest(query, timeoutMs) {
    // Respect Nominatim's 1 req/sec usage policy.
    const wait = 1100 - (Date.now() - this._lastNominatimAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastNominatimAt = Date.now();

    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en' +
      '&countrycodes=ru,ua&q=' +
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
    const cacheKey = normalizeKey(`${sighting.location}|${sighting.region || ''}`);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    // 1) Curated offline gazetteer — exact place matches only.
    let hit = this.lookupLocal(sighting.location, sighting.region);

    // 2) Nominatim (RU + UA) for the specific town BEFORE falling back to a
    //    region centroid — so a real place like "Okhtyrka, Sumy Oblast" lands
    //    on the town, not on the oblast capital. Country is left to
    //    countrycodes=ru,ua (don't append "Russia" — many places are Ukrainian).
    if (!hit) {
      const q = sighting.region
        ? `${sighting.location}, ${sighting.region}`
        : sighting.location;
      hit = await this._nominatim(q, timeoutMs);
    }

    // 3) Coarse region centroid only if the town couldn't be found.
    if (!hit) hit = this.lookupRegion(sighting.region);

    // 4) Fall back to the model's own coordinates only when nothing else
    //    resolves, and only if they land in the plausible region.
    if (
      !hit &&
      typeof sighting.lat === 'number' &&
      typeof sighting.lon === 'number' &&
      inRegionBbox(sighting.lat, sighting.lon)
    ) {
      hit = {
        lat: sighting.lat,
        lon: sighting.lon,
        source: 'llm',
        name: sighting.location,
        region: sighting.region || '',
      };
    }

    // Sanity-check looked-up / guessed coordinates against the stated oblast:
    // a town that resolves >450 km from its region's centroid is almost
    // certainly the wrong same-named place — use the centroid instead.
    if (hit && (hit.source === 'nominatim' || hit.source === 'llm') && sighting.region) {
      const rc = this.lookupRegion(sighting.region);
      if (rc && haversineKm(hit.lat, hit.lon, rc.lat, rc.lon) > 450) {
        hit = rc;
      }
    }

    const result = hit
      ? {
          lat: hit.lat,
          lon: hit.lon,
          source: hit.source,
          matchedName: hit.name || sighting.location,
          region: hit.region || sighting.region || '',
          // Region-centroid fallbacks are approximate; everything else is a point.
          precision: hit.source === 'gazetteer-region' ? 'region' : 'point',
        }
      : null;
    this.cache.set(cacheKey, result);
    return result;
  }
}

module.exports = { Geocoder, normalizeKey, inRegionBbox };
