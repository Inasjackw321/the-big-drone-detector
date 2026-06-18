'use strict';

/**
 * Orchestrates the monitoring loop:
 *   fetch new Telegram posts -> LLM extraction -> geocode -> store -> emit.
 *
 * Emits events (EventEmitter):
 *   'status'   {state, message}
 *   'post'     {post, extraction}     (after a post is processed)
 *   'sighting' {sighting}             (each new located sighting)
 *   'error'    Error
 *   'tick'     {processed, newSightings, fetched}
 */

const EventEmitter = require('events');
const { fetchChannelPosts } = require('./telegram');
const { OpenRouterClient } = require('./openrouter');
const { Geocoder } = require('./geocode');

function makeSightingId(postId, channel, index) {
  return `${channel}-${postId}-${index}`;
}

class Pipeline extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config').Config} deps.config
   * @param {import('./store').SightingStore} deps.store
   * @param {object} [deps.overrides]  inject telegram/llm/geocoder for tests
   */
  constructor({ config, store, overrides = {} }) {
    super();
    this.config = config;
    this.store = store;
    this.timer = null;
    this.running = false;
    this.busy = false;

    this.fetchPosts = overrides.fetchPosts || fetchChannelPosts;
    this.geocoder =
      overrides.geocoder ||
      new Geocoder({ enableNominatim: !config.get('demo') });
    this._overrideLlm = overrides.llm || null;
  }

  _llm() {
    if (this._overrideLlm) return this._overrideLlm;
    return new OpenRouterClient({
      apiKey: this.config.get('openrouterApiKey'),
      model: this.config.get('openrouterModel'),
      baseUrl: this.config.get('openrouterBaseUrl'),
    });
  }

  _emitStatus(state, message) {
    this.emit('status', { state, message });
  }

  /** Process a single already-fetched post into stored sightings. */
  async processPost(post, llm) {
    let extraction;
    try {
      extraction = await llm.extractSightings(post);
    } catch (err) {
      this.emit('error', new Error(`extract @${post.id}: ${err.message}`));
      return [];
    }

    this.emit('post', { post, extraction });
    if (!extraction.isRelevant || !extraction.sightings.length) return [];

    const created = [];
    for (let i = 0; i < extraction.sightings.length; i++) {
      const s = extraction.sightings[i];
      let geo = null;
      try {
        geo = await this.geocoder.resolve(s);
      } catch (err) {
        this.emit('error', new Error(`geocode "${s.location}": ${err.message}`));
      }
      if (!geo) continue; // can't place it on the map -> skip

      const sighting = {
        id: makeSightingId(post.postId, post.channel, i),
        channel: post.channel,
        postId: post.postId,
        postLink: post.link,
        postDate: post.date,
        postText: post.text,
        summary: extraction.summary,
        timestamp: post.date || new Date().toISOString(),
        location: geo.matchedName || s.location,
        locationRu: s.locationRu || '',
        region: geo.region || s.region || '',
        lat: geo.lat,
        lon: geo.lon,
        geocodeSource: geo.source,
        threatType: s.threatType,
        count: s.count,
        heading: s.heading,
        status: s.status,
        confidence: s.confidence,
      };
      const isNew = this.store.add(sighting);
      created.push(sighting);
      if (isNew) this.emit('sighting', { sighting });
    }
    return created;
  }

  /** Run one polling cycle. */
  async pollOnce() {
    if (this.busy) return { skipped: true };
    this.busy = true;
    const channel = this.config.get('telegramChannel');
    let fetched = 0;
    let processed = 0;
    let newSightings = 0;
    try {
      this._emitStatus('polling', `Fetching @${channel}…`);
      const posts = await this.fetchPosts({ channel });
      fetched = posts.length;

      const lastSeen = this.store.getLastPostId(channel);
      const maxPosts = this.config.get('maxPostsPerPoll');
      let fresh = posts.filter((p) => p.postId > lastSeen && (p.text || '').trim());
      // On the very first run, only look at the most recent batch.
      if (lastSeen === 0) fresh = fresh.slice(-maxPosts);
      else fresh = fresh.slice(-maxPosts);

      if (!fresh.length) {
        this._emitStatus('idle', `No new posts (latest #${posts.at(-1)?.postId ?? '?'}).`);
      } else {
        this._emitStatus('processing', `Analyzing ${fresh.length} new post(s)…`);
        const llm = this._llm();
        for (const post of fresh) {
          const created = await this.processPost(post, llm);
          processed++;
          newSightings += created.length;
          this.store.setLastPostId(channel, post.postId);
        }
        this.store.prune();
        this.store.save();
        this._emitStatus(
          'idle',
          `Processed ${processed} post(s), +${newSightings} sighting(s).`
        );
      }
    } catch (err) {
      this.emit('error', err);
      this._emitStatus('error', err.message);
    } finally {
      this.busy = false;
      this.emit('tick', { processed, newSightings, fetched });
    }
    return { processed, newSightings, fetched };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const intervalMs = Math.max(20, this.config.get('pollIntervalSeconds')) * 1000;
    this._emitStatus('starting', 'Monitor started.');
    // Kick off immediately, then on an interval.
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._emitStatus('stopped', 'Monitor stopped.');
  }
}

module.exports = { Pipeline, makeSightingId };
