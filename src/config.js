'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Configuration & lightweight settings persistence.
 *
 * Resolution order for any value: persisted settings file > environment
 * variable (incl. .env) > built-in default. The settings file lets the user
 * change things from the app's Settings panel without editing the environment.
 */

const DEFAULTS = {
  openrouterApiKey: '',
  openrouterModel: 'openrouter/owl-alpha',
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  telegramChannel: 'radarrussiia',
  pollIntervalSeconds: 120,
  maxPostsPerPoll: 25,
  demo: false,
  // Discard sightings older than this many hours from the live map.
  retentionHours: 24,
};

// Minimal .env loader (no dependency on dotenv).
function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[config] failed to read .env:', err.message);
  }
}

function asBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function asInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

class Config {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir   project root (for .env)
   * @param {string} opts.userDataDir  writable dir for the settings file
   */
  constructor({ rootDir, userDataDir }) {
    this.rootDir = rootDir;
    this.userDataDir = userDataDir;
    this.settingsPath = path.join(userDataDir, 'settings.json');

    loadDotEnv(rootDir);

    const fromEnv = {
      openrouterApiKey: process.env.OPENROUTER_API_KEY || DEFAULTS.openrouterApiKey,
      openrouterModel: process.env.OPENROUTER_MODEL || DEFAULTS.openrouterModel,
      openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || DEFAULTS.openrouterBaseUrl,
      telegramChannel: process.env.TELEGRAM_CHANNEL || DEFAULTS.telegramChannel,
      pollIntervalSeconds: asInt(process.env.POLL_INTERVAL_SECONDS, DEFAULTS.pollIntervalSeconds),
      maxPostsPerPoll: asInt(process.env.DDX_MAX_POSTS, DEFAULTS.maxPostsPerPoll),
      demo: asBool(process.env.DDX_DEMO, DEFAULTS.demo),
      retentionHours: asInt(process.env.DDX_RETENTION_HOURS, DEFAULTS.retentionHours),
    };

    this.values = { ...DEFAULTS, ...fromEnv, ...this._readSettingsFile() };
  }

  _readSettingsFile() {
    try {
      if (fs.existsSync(this.settingsPath)) {
        return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) || {};
      }
    } catch (err) {
      console.warn('[config] failed to read settings.json:', err.message);
    }
    return {};
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  /** Public view safe to send to the renderer (no secrets leaked verbatim). */
  publicView() {
    const v = this.all();
    return {
      ...v,
      openrouterApiKey: undefined,
      hasApiKey: Boolean(v.openrouterApiKey),
    };
  }

  update(patch) {
    // Only persist known keys.
    const next = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    this.values = { ...this.values, ...next };
    this._persist();
    return this.publicView();
  }

  _persist() {
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      // Persist everything except transient defaults we don't want to freeze.
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.values, null, 2));
    } catch (err) {
      console.warn('[config] failed to persist settings.json:', err.message);
    }
  }
}

module.exports = { Config, DEFAULTS };
