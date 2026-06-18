'use strict';

/* global L */

const api = window.ddx;

const TYPE_LABELS = {
  drone: 'Drone / UAV',
  missile: 'Missile',
  cruise_missile: 'Cruise missile',
  ballistic_missile: 'Ballistic missile',
  air_defense: 'Air defense',
  explosion: 'Explosion',
  unknown: 'Unknown',
};
const TYPE_COLORS = {
  drone: '#ff5c5c',
  missile: '#ff8a3d',
  cruise_missile: '#ff8a3d',
  ballistic_missile: '#ff6a00',
  air_defense: '#4fb6ff',
  explosion: '#ffd23d',
  unknown: '#9fb3c8',
};
const STATUS_LABELS = {
  approaching: 'approaching',
  overhead: 'overhead',
  shot_down: 'shot down',
  impact: 'impact',
  alert: 'alert',
  all_clear: 'all clear',
  unknown: '',
};

// ---- State ----
const state = {
  sightings: new Map(), // id -> sighting
  markers: new Map(), // id -> L.circleMarker
  config: {},
  monitorRunning: false,
  filterText: '',
  filterType: '',
  activeId: null,
};

// ---- Map ----
const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView(
  [53.5, 41.0],
  5
);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap contributors',
}).addTo(map);

// ---- Helpers ----
function el(id) {
  return document.getElementById(id);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.round(diffMin / 60)}h ago`;
  return d.toLocaleString();
}

function recencyFactor(iso) {
  const d = Date.parse(iso || '');
  if (!d) return 0.4;
  const ageHr = (Date.now() - d) / 3600000;
  return Math.max(0.35, Math.min(1, 1 - ageHr / 24));
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function popupHtml(s) {
  const parts = [];
  parts.push(`<div class="popup"><h3>${escapeHtml(s.location)}</h3>`);
  const bits = [];
  bits.push(TYPE_LABELS[s.threatType] || s.threatType);
  if (s.count) bits.push(`×${s.count}`);
  if (STATUS_LABELS[s.status]) bits.push(STATUS_LABELS[s.status]);
  if (s.region) bits.push(s.region);
  parts.push(`<div class="popup-meta">${escapeHtml(bits.filter(Boolean).join(' · '))}</div>`);
  if (s.heading) parts.push(`<div class="popup-meta">Heading: ${escapeHtml(s.heading)}</div>`);
  parts.push(
    `<div class="popup-meta">${fmtTime(s.timestamp)} · via ${escapeHtml(
      s.geocodeSource
    )}</div>`
  );
  if (s.postText) parts.push(`<div class="popup-text">${escapeHtml(s.postText)}</div>`);
  if (s.postLink)
    parts.push(
      `<div style="margin-top:6px"><a href="${escapeHtml(
        s.postLink
      )}" class="tg-link" data-url="${escapeHtml(s.postLink)}">Open Telegram post ↗</a></div>`
    );
  parts.push('</div>');
  return parts.join('');
}

// ---- Markers ----
function upsertMarker(s) {
  const color = TYPE_COLORS[s.threatType] || TYPE_COLORS.unknown;
  const factor = recencyFactor(s.timestamp);
  const radius = 6 + 8 * factor;
  const existing = state.markers.get(s.id);
  if (existing) {
    existing.setLatLng([s.lat, s.lon]);
    existing.setStyle({ color, fillColor: color, fillOpacity: 0.25 + 0.5 * factor });
    existing.setRadius(radius);
    existing.bindPopup(popupHtml(s));
    return existing;
  }
  const marker = L.circleMarker([s.lat, s.lon], {
    radius,
    color,
    weight: 2,
    fillColor: color,
    fillOpacity: 0.25 + 0.5 * factor,
  }).addTo(map);
  marker.bindPopup(popupHtml(s));
  marker.on('popupopen', wirePopupLinks);
  marker.on('click', () => setActive(s.id, false));
  state.markers.set(s.id, marker);
  return marker;
}

function wirePopupLinks() {
  document.querySelectorAll('.tg-link').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      api.openExternal(a.dataset.url);
    };
  });
}

// ---- Sidebar ----
function matchesFilter(s) {
  if (state.filterType && s.threatType !== state.filterType) return false;
  if (state.filterText) {
    const hay = `${s.location} ${s.region} ${s.locationRu} ${s.summary}`.toLowerCase();
    if (!hay.includes(state.filterText)) return false;
  }
  return true;
}

function renderList() {
  const list = el('sightingList');
  const items = Array.from(state.sightings.values())
    .filter(matchesFilter)
    .sort(
      (a, b) =>
        (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)
    );

  el('countBadge').textContent = String(state.sightings.size);
  el('emptyState').classList.toggle('hidden', state.sightings.size > 0);

  list.innerHTML = '';
  for (const s of items) {
    const li = document.createElement('li');
    li.className = 'sighting' + (s.id === state.activeId ? ' active' : '');
    li.style.borderLeftColor = TYPE_COLORS[s.threatType] || TYPE_COLORS.unknown;
    li.dataset.id = s.id;

    const metaChips = [];
    metaChips.push(
      `<span class="chip type-${s.threatType}">${TYPE_LABELS[s.threatType] || s.threatType}${
        s.count ? ' ×' + s.count : ''
      }</span>`
    );
    if (STATUS_LABELS[s.status])
      metaChips.push(`<span class="chip">${STATUS_LABELS[s.status]}</span>`);
    if (s.region) metaChips.push(`<span class="chip">${escapeHtml(s.region)}</span>`);

    li.innerHTML = `
      <div class="row1">
        <span class="place">${escapeHtml(s.location)}</span>
        <span class="time">${fmtTime(s.timestamp)}</span>
      </div>
      <div class="meta">${metaChips.join('')}</div>
      ${s.summary ? `<div class="summary">${escapeHtml(s.summary)}</div>` : ''}
    `;
    li.onclick = () => setActive(s.id, true);
    list.appendChild(li);
  }
}

function setActive(id, fly) {
  state.activeId = id;
  const s = state.sightings.get(id);
  if (s) {
    if (fly) map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 7), { duration: 0.6 });
    const m = state.markers.get(id);
    if (m) m.openPopup();
  }
  renderList();
}

// ---- Ingest ----
function addSighting(s, { focus = false } = {}) {
  state.sightings.set(s.id, s);
  upsertMarker(s);
  renderList();
  if (focus) setActive(s.id, true);
}

// ---- Status ----
function setStatus(state_, message) {
  const dot = el('statusDot');
  dot.className = 'dot dot-' + (state_ || 'idle');
  el('statusText').textContent = message || '';
}

function setMonitorRunning(running) {
  state.monitorRunning = running;
  const btn = el('btnToggle');
  btn.textContent = running ? '⏸ Stop monitor' : '▶ Start monitor';
  btn.classList.toggle('btn-primary', !running);
  btn.classList.toggle('btn-danger', running);
}

// ---- Settings modal ----
function openSettings() {
  const c = state.config;
  el('setApiKey').value = '';
  el('setApiKey').placeholder = c.hasApiKey
    ? '•••••• (saved — leave blank to keep)'
    : 'sk-or-… (stored locally)';
  el('setModel').value = c.openrouterModel || '';
  el('setChannel').value = c.telegramChannel || '';
  el('setInterval').value = c.pollIntervalSeconds || 120;
  el('setRetention').value = c.retentionHours || 24;
  el('setDemo').checked = Boolean(c.demo);
  el('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  el('settingsModal').classList.add('hidden');
}

async function saveSettings() {
  const patch = {
    openrouterModel: el('setModel').value.trim() || 'openrouter/owl-alpha',
    telegramChannel: el('setChannel').value.trim().replace(/^@/, '') || 'radarrussiia',
    pollIntervalSeconds: Math.max(20, parseInt(el('setInterval').value, 10) || 120),
    retentionHours: Math.max(1, parseInt(el('setRetention').value, 10) || 24),
    demo: el('setDemo').checked,
  };
  const key = el('setApiKey').value.trim();
  if (key) patch.openrouterApiKey = key;
  state.config = await api.updateSettings(patch);
  applyConfigToUi();
  closeSettings();
  setStatus('idle', 'Settings saved.');
}

function applyConfigToUi() {
  const c = state.config;
  el('modelLabel').textContent = c.openrouterModel || 'openrouter/owl-alpha';
  el('channelLink').textContent = '@' + (c.telegramChannel || 'radarrussiia');
  el('channelLink').dataset.url = 'https://t.me/s/' + (c.telegramChannel || 'radarrussiia');
  el('demoBadge').classList.toggle('hidden', !c.demo);
}

// ---- Wire up ----
function bindUi() {
  el('btnToggle').onclick = async () => {
    if (state.monitorRunning) {
      await api.stopMonitor();
      setMonitorRunning(false);
      setStatus('stopped', 'Monitor stopped.');
    } else {
      const res = await api.startMonitor();
      if (!res.ok) {
        setStatus('error', res.error);
        openSettings();
        return;
      }
      setMonitorRunning(true);
    }
  };

  el('btnPoll').onclick = async () => {
    setStatus('polling', 'Polling once…');
    const res = await api.pollOnce();
    if (res && res.ok === false) setStatus('error', res.error || 'Poll failed');
  };

  el('btnSettings').onclick = openSettings;
  el('btnCloseSettings').onclick = closeSettings;
  el('btnSaveSettings').onclick = saveSettings;
  el('settingsModal').onclick = (e) => {
    if (e.target === el('settingsModal')) closeSettings();
  };

  el('btnClearData').onclick = async () => {
    await api.clearSightings();
    state.sightings.clear();
    state.markers.forEach((m) => map.removeLayer(m));
    state.markers.clear();
    renderList();
    setStatus('idle', 'Cleared all sightings.');
  };

  el('search').oninput = (e) => {
    state.filterText = e.target.value.trim().toLowerCase();
    renderList();
  };
  el('typeFilter').onchange = (e) => {
    state.filterType = e.target.value;
    renderList();
  };

  el('channelLink').onclick = (e) => {
    e.preventDefault();
    const url = el('channelLink').dataset.url;
    if (url) api.openExternal(url);
  };
}

function bindEvents() {
  api.on('pipeline:status', (s) => setStatus(s.state, s.message));
  api.on('pipeline:sighting', (s) => addSighting(s, { focus: false }));
  api.on('pipeline:error', (e) => setStatus('error', e.message));
  api.on('pipeline:tick', (t) => {
    el('tickInfo').textContent = `fetched ${t.fetched} · processed ${t.processed} · +${t.newSightings} new`;
  });
}

// ---- Boot ----
async function boot() {
  bindUi();
  bindEvents();
  const data = await api.bootstrap();
  state.config = data.config || {};
  applyConfigToUi();
  for (const s of data.sightings || []) state.sightings.set(s.id, s);
  state.sightings.forEach((s) => upsertMarker(s));
  renderList();

  // Fit to existing markers if any.
  if (state.markers.size) {
    const group = L.featureGroup(Array.from(state.markers.values()));
    map.fitBounds(group.getBounds().pad(0.3));
  }

  if (!state.config.hasApiKey && !state.config.demo) {
    setStatus('idle', 'Add your OpenRouter key in ⚙ Settings, or enable Demo mode.');
  } else {
    setStatus('idle', 'Ready. Press Start monitor.');
  }
}

window.addEventListener('DOMContentLoaded', boot);
