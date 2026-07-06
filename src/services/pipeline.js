'use strict';

/**
 * Orchestrates the monitoring loop:
 *   fetch new Telegram posts -> LLM extraction -> geocode -> store -> emit.
 *
 * On start() it first runs a deep BACKFILL: pages back through each channel's
 * public preview until `backfillHours` of history is covered, so the map opens
 * with full flight tracks instead of an empty canvas. Then it polls for new
 * posts on an interval.
 *
 * Extraction runs locally through Ollama by default (config.aiBackend), with
 * a deterministic heuristic parser as safety net and an optional second
 * model-verification pass for accuracy.
 *
 * Emits events (EventEmitter):
 *   'status'   {state, message}
 *   'post'     {post, extraction}          (after a post is processed)
 *   'sighting' {sighting}                  (each new located sighting)
 *   'backfill' {phase, channel, page, fetched, done, total, sightings}
 *   'tracks'   {tracks}                    (rebuilt after data changes)
 *   'error'    Error
 *   'tick'     {processed, newSightings, fetched}
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const { fetchChannelPosts } = require('./telegram');
const { OpenRouterClient } = require('./openrouter');
const { OllamaClient } = require('./ollama');
const { Geocoder } = require('./geocode');
const { analyzePost, isInterceptionRecap, isBlockedLocation } = require('./heuristic');
const { buildTracks } = require('./tracks');
const {
  normalizeSightingDirection,
  backfillFromHeuristic,
  stripSummaryCounts,
  resolveMovement,
} = require('./enrich');

function makeSightingId(postId, channel, index) {
  return `${channel}-${postId}-${index}`;
}

// Run an async fn over items with a bounded number in flight at once.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

class Pipeline extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config').Config} deps.config
   * @param {import('./store').SightingStore} deps.store
   * @param {string} [deps.dataDir]  writable dir for the geocode cache
   * @param {object} [deps.overrides]  inject telegram/llm/geocoder for tests
   */
  constructor({ config, store, dataDir, overrides = {} }) {
    super();
    this.config = config;
    this.store = store;
    this.dataDir = dataDir || null;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.backfilled = false;

    this.fetchPosts = overrides.fetchPosts || fetchChannelPosts;
    this.geocoder = overrides.geocoder || this._makeGeocoder();
    this._overrideLlm = overrides.llm || null;
  }

  _geocacheFile() {
    return this.dataDir ? path.join(this.dataDir, 'geocode-cache.json') : null;
  }

  _makeGeocoder() {
    // Warm-start from the persisted cache so known places resolve instantly.
    let initialCache;
    const file = this._geocacheFile();
    try {
      if (file && fs.existsSync(file)) initialCache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* corrupt cache → start fresh */ }
    return new Geocoder({ enableNominatim: !this.config.get('demo'), initialCache });
  }

  _saveGeocache() {
    const file = this._geocacheFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.geocoder.dumpCache(), null, 0));
    } catch { /* cache is best-effort */ }
  }

  _llm() {
    if (this._overrideLlm) return this._overrideLlm;
    if (this.config.get('aiBackend') === 'openrouter') {
      return new OpenRouterClient({
        apiKey: this.config.get('openrouterApiKey'),
        model: this.config.get('openrouterModel'),
        baseUrl: this.config.get('openrouterBaseUrl'),
      });
    }
    return new OllamaClient({
      baseUrl: this.config.get('ollamaBaseUrl'),
      model: this.config.get('ollamaModel'),
      verify: this.config.get('verifyPass') !== false,
    });
  }

  /** Human-readable check that the configured AI backend is usable. */
  async checkBackend() {
    if (this.config.get('demo')) return { ok: true, backend: 'demo' };
    const llm = this._llm();
    if (llm instanceof OllamaClient) {
      const up = await llm.ping();
      if (!up) {
        return {
          ok: false,
          backend: 'ollama',
          error: `Ollama is not reachable at ${this.config.get('ollamaBaseUrl')}. Start it with \`ollama serve\`.`,
        };
      }
      const models = await llm.listModels();
      const want = this.config.get('ollamaModel');
      const have = models.some((m) => m === want || m.split(':')[0] === want.split(':')[0]);
      if (!have) {
        return {
          ok: false,
          backend: 'ollama',
          error: `Model "${want}" is not installed. Run \`ollama pull ${want}\`. Installed: ${models.join(', ') || 'none'}.`,
        };
      }
      return { ok: true, backend: 'ollama', models };
    }
    if (!this.config.get('openrouterApiKey')) {
      return { ok: false, backend: 'openrouter', error: 'No OpenRouter API key set.' };
    }
    return { ok: true, backend: 'openrouter' };
  }

  _emitStatus(state, message) {
    this.emit('status', { state, message });
  }

  /** Extract with one retry (local model hiccups are usually transient). */
  async _extract(llm, post) {
    try {
      return await llm.extractSightings(post);
    } catch (err) {
      this.emit('error', new Error(`extract @${post.id}: ${err.message} (retrying)`));
      try {
        return await llm.extractSightings(post, undefined, 1);
      } catch (err2) {
        this.emit('error', new Error(`extract @${post.id}: ${err2.message}`));
        return null;
      }
    }
  }

  /** Process a single already-fetched post into stored sightings. */
  async processPost(post, llm) {
    // MoD-style "destroyed N UAVs over [oblasts]" recap totals aren't sightings.
    if (isInterceptionRecap(post.text)) return [];

    const heur = analyzePost(post.text);
    let extraction = await this._extract(llm, post);

    // Deterministic safety net: if the model gave nothing usable but the post
    // clearly describes a locatable threat, use the parsed result.
    if (
      (!extraction || !extraction.isRelevant || !extraction.sightings.length) &&
      heur.isRelevant &&
      heur.sightings.length
    ) {
      extraction = heur;
    }
    if (!extraction) return [];

    this.emit('post', { post, extraction });
    if (!extraction.isRelevant || !extraction.sightings.length) return [];

    backfillFromHeuristic(extraction.sightings, heur);
    stripSummaryCounts(extraction.sightings);

    const created = [];
    for (let i = 0; i < extraction.sightings.length; i++) {
      let s = extraction.sightings[i];
      // Junk "locations" (seas, whole countries, vague terms) never map.
      if (isBlockedLocation(s.location)) continue;
      s = normalizeSightingDirection(s);

      let geo = null;
      try {
        geo = await this.geocoder.resolve(s);
      } catch (err) {
        this.emit('error', new Error(`geocode "${s.location}": ${err.message}`));
      }
      if (!geo) continue; // can't place it on the map -> skip

      const { destination, destinationLat, destinationLon, bearing } =
        await resolveMovement(s, geo, this.geocoder);

      const sighting = {
        id: makeSightingId(post.postId, post.channel, i),
        channel: post.channel,
        postId: post.postId,
        postLink: post.link,
        postDate: post.date,
        postText: (post.text || '').slice(0, 400),
        summary: extraction.summary,
        timestamp: post.date || new Date().toISOString(),
        location: geo.matchedName || s.location,
        locationRu: s.locationRu || '',
        region: geo.region || s.region || '',
        lat: geo.lat,
        lon: geo.lon,
        geocodeSource: geo.source,
        geocodePrecision: geo.precision || 'point',
        threatType: s.threatType,
        count: s.count,
        heading: s.heading,
        destination,
        destinationLat,
        destinationLon,
        bearing,
        status: s.status,
        confidence: s.confidence,
      };
      const isNew = this.store.add(sighting);
      created.push(sighting);
      if (isNew) this.emit('sighting', { sighting });
    }
    return created;
  }

  /** Correlated flight tracks over everything currently in the store. */
  tracks() {
    return buildTracks(this.store.all());
  }

  _emitTracks() {
    try {
      this.emit('tracks', { tracks: this.tracks() });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Fetch a channel's history back to `sinceMs`, paging with ?before=.
   * Returns posts ascending by id. Stops when a page brings nothing older,
   * the age horizon is passed, or maxPages is hit.
   */
  async fetchHistory(channel, sinceMs, maxPages) {
    let posts = await this.fetchPosts({ channel });
    let pages = 1;
    const oldest = () => {
      const withDate = posts.filter((p) => p.date);
      return withDate.length ? Date.parse(withDate[0].date) : null;
    };
    while (pages < maxPages && posts.length) {
      const oldestMs = oldest();
      if (oldestMs !== null && oldestMs <= sinceMs) break; // horizon reached
      const beforeId = posts[0].postId;
      let older;
      try {
        older = await this.fetchPosts({ channel, beforeId });
      } catch (err) {
        this.emit('error', new Error(`backfill @${channel} before=${beforeId}: ${err.message}`));
        break;
      }
      const fresh = (older || []).filter((p) => p.postId < beforeId);
      if (!fresh.length) break; // start of channel (or preview won't page further)
      posts = fresh.concat(posts);
      pages++;
      this.emit('backfill', {
        phase: 'fetch', channel, page: pages, fetched: posts.length, done: 0, total: 0, sightings: 0,
      });
    }
    return { posts: posts.filter((p) => (Date.parse(p.date || '') || Infinity) >= sinceMs), pages };
  }

  /**
   * Deep startup backfill: download all available history inside the
   * backfillHours window across every channel, extract everything, and build
   * tracks. Emits 'backfill' progress events throughout.
   */
  async backfill() {
    if (this.busy) return { skipped: true };
    this.busy = true;
    const hours = this.config.get('backfillHours');
    const sinceMs = Date.now() - hours * 3600 * 1000;
    const maxPages = this.config.get('backfillMaxPages');
    const channels = this.config.channels();
    let totalSightings = 0;
    const tasks = [];

    try {
      this._emitStatus('backfill', `Downloading last ${hours}h from ${channels.length} channel(s)…`);
      for (const channel of channels) {
        this.emit('backfill', { phase: 'fetch', channel, page: 1, fetched: 0, done: 0, total: 0, sightings: 0 });
        let posts, pages;
        try {
          ({ posts, pages } = await this.fetchHistory(channel, sinceMs, maxPages));
        } catch (err) {
          this.emit('error', new Error(`backfill @${channel}: ${err.message}`));
          continue;
        }
        // Only posts we haven't already processed (repeat launches are cheap).
        const lastSeen = this.store.getLastPostId(channel);
        const fresh = posts.filter((p) => p.postId > lastSeen && (p.text || '').trim());
        this.emit('backfill', {
          phase: 'fetched', channel, page: pages, fetched: posts.length,
          done: 0, total: fresh.length, sightings: 0,
        });
        for (const post of fresh) tasks.push({ post, channel });
      }

      if (tasks.length) {
        const llm = this._llm();
        const conc = this.config.get('extractConcurrency') || 2;
        let done = 0;
        this._emitStatus('backfill', `Analyzing ${tasks.length} post(s) with ${this._backendLabel()}…`);
        await mapPool(tasks, conc, async ({ post, channel }) => {
          const created = await this.processPost(post, llm);
          this.store.setLastPostId(channel, post.postId);
          totalSightings += created.length;
          done++;
          if (done % 5 === 0 || done === tasks.length) {
            this.emit('backfill', {
              phase: 'extract', channel: '', page: 0, fetched: 0,
              done, total: tasks.length, sightings: totalSightings,
            });
            this.store.save(); // survive an app close mid-backfill
          }
        });
        this.store.prune();
        this.store.save();
        this._saveGeocache();
      }
      this.backfilled = true;
      this.emit('backfill', {
        phase: 'done', channel: '', page: 0, fetched: 0,
        done: tasks.length, total: tasks.length, sightings: totalSightings,
      });
      this._emitStatus('idle', `Backfill complete: ${tasks.length} post(s), +${totalSightings} sighting(s).`);
      this._emitTracks();
    } catch (err) {
      this.emit('error', err);
      this._emitStatus('error', err.message);
    } finally {
      this.busy = false;
    }
    return { posts: tasks.length, sightings: totalSightings };
  }

  _backendLabel() {
    if (this.config.get('demo')) return 'demo data';
    return this.config.get('aiBackend') === 'openrouter'
      ? this.config.get('openrouterModel')
      : `${this.config.get('ollamaModel')} (local)`;
  }

  /** Run one polling cycle across all channels. */
  async pollOnce() {
    if (this.busy) return { skipped: true };
    this.busy = true;
    let fetched = 0;
    let processed = 0;
    let newSightings = 0;
    try {
      const llm = this._llm();
      for (const channel of this.config.channels()) {
        this._emitStatus('polling', `Fetching @${channel}…`);
        let posts;
        try {
          posts = await this.fetchPosts({ channel });
        } catch (err) {
          this.emit('error', new Error(`poll @${channel}: ${err.message}`));
          continue;
        }
        fetched += posts.length;

        const lastSeen = this.store.getLastPostId(channel);
        const maxPosts = this.config.get('maxPostsPerPoll');
        let fresh = posts.filter((p) => p.postId > lastSeen && (p.text || '').trim());
        fresh = fresh.slice(-maxPosts);
        if (!fresh.length) continue;

        this._emitStatus('processing', `Analyzing ${fresh.length} new post(s) from @${channel}…`);
        for (const post of fresh) {
          const created = await this.processPost(post, llm);
          processed++;
          newSightings += created.length;
          this.store.setLastPostId(channel, post.postId);
        }
      }
      this.store.prune();
      this.store.save();
      this._saveGeocache();
      if (newSightings > 0) this._emitTracks();
      this._emitStatus(
        'idle',
        processed
          ? `Processed ${processed} post(s), +${newSightings} sighting(s).`
          : 'No new posts.'
      );
    } catch (err) {
      this.emit('error', err);
      this._emitStatus('error', err.message);
    } finally {
      this.busy = false;
      this.emit('tick', { processed, newSightings, fetched });
    }
    return { processed, newSightings, fetched };
  }

  /** Backfill (once) then poll on an interval. */
  start() {
    if (this.running) return;
    this.running = true;
    const intervalMs = Math.max(20, this.config.get('pollIntervalSeconds')) * 1000;
    this._emitStatus('starting', 'Monitor started.');
    if (this.backfilled) this.pollOnce();
    else this.backfill();
    this.timer = setInterval(() => this.pollOnce(), intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._emitStatus('stopped', 'Monitor stopped.');
  }
}

module.exports = { Pipeline, makeSightingId, mapPool };
