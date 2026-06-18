'use strict';

/**
 * In-memory store of sightings with disk persistence, de-duplication and
 * time-based retention. A "sighting" is one located threat extracted from one
 * Telegram post; a post can yield several.
 */

const fs = require('fs');
const path = require('path');

class SightingStore {
  /**
   * @param {object} opts
   * @param {string} [opts.filePath]  where to persist (JSON)
   * @param {number} [opts.retentionHours]
   * @param {number} [opts.max]  hard cap on retained sightings
   */
  constructor({ filePath, retentionHours = 24, max = 5000 } = {}) {
    this.filePath = filePath;
    this.retentionHours = retentionHours;
    this.max = max;
    /** @type {Map<string, object>} */
    this.byId = new Map();
    /** Highest Telegram post id we have processed per channel. */
    this.lastPostId = {};
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        for (const s of data.sightings || []) this.byId.set(s.id, s);
        this.lastPostId = data.lastPostId || {};
      }
    } catch (err) {
      console.warn('[store] failed to load:', err.message);
    }
  }

  _persist() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          { sightings: this.all(), lastPostId: this.lastPostId },
          null,
          2
        )
      );
    } catch (err) {
      console.warn('[store] failed to persist:', err.message);
    }
  }

  getLastPostId(channel) {
    return this.lastPostId[channel] || 0;
  }

  setLastPostId(channel, id) {
    const cur = this.lastPostId[channel] || 0;
    if (id > cur) this.lastPostId[channel] = id;
  }

  /**
   * Add or replace a sighting. Returns true if it was new.
   * @param {object} sighting must have a stable `id`
   */
  add(sighting) {
    const isNew = !this.byId.has(sighting.id);
    this.byId.set(sighting.id, sighting);
    return isNew;
  }

  /** Remove sightings older than retentionHours and enforce the cap. */
  prune(now = Date.now()) {
    const cutoff = now - this.retentionHours * 3600 * 1000;
    for (const [id, s] of this.byId) {
      const t = Date.parse(s.timestamp || s.postDate || '') || 0;
      if (t && t < cutoff) this.byId.delete(id);
    }
    if (this.byId.size > this.max) {
      const sorted = this.all(); // ascending by time
      const remove = sorted.slice(0, this.byId.size - this.max);
      for (const s of remove) this.byId.delete(s.id);
    }
  }

  /** All sightings, ascending by timestamp. */
  all() {
    return Array.from(this.byId.values()).sort(
      (a, b) =>
        (Date.parse(a.timestamp || a.postDate || '') || 0) -
        (Date.parse(b.timestamp || b.postDate || '') || 0)
    );
  }

  save() {
    this._persist();
  }

  clear() {
    this.byId.clear();
    this.lastPostId = {};
    this._persist();
  }
}

module.exports = { SightingStore };
