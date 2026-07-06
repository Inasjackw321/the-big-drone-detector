'use strict';

/* global L, html2canvas */

// Desktop renderer: live threat map with flight tracks, layer toggles, a
// history timeline scrubber, PNG export and a settings panel. Talks to the
// Electron main process through the `window.ddx` bridge (see preload.js).

const api = window.ddx;

// ---------- constants ----------
const THREAT = {
  drone:             { label: 'Drone / UAV',      sym: '✈' },
  missile:           { label: 'Missile',           sym: '▲' },
  cruise_missile:    { label: 'Cruise missile',    sym: '▲' },
  ballistic_missile: { label: 'Ballistic missile', sym: '▲' },
  air_defense:       { label: 'Air defense',       sym: '◆' },
  explosion:         { label: 'Explosion',         sym: '✸' },
  unknown:           { label: 'Unknown',           sym: '●' },
};
const STATUS_INFO = {
  alert:       { level: 3, color: '#ff3b3b', label: 'Danger',      warn: true  },
  impact:      { level: 3, color: '#ff2d2d', label: 'Impact',      warn: true  },
  approaching: { level: 2, color: '#ff7a3d', label: 'Inbound',     warn: true  },
  overhead:    { level: 2, color: '#ffb03d', label: 'Overhead',    warn: true  },
  shot_down:   { level: 1, color: '#4fb6ff', label: 'Intercepted', warn: false },
  all_clear:   { level: 0, color: '#3fd87f', label: 'All clear',   warn: false },
  unknown:     { level: 1, color: '#9ab4d0', label: 'Reported',    warn: false },
};
function statusInfo(s) { return STATUS_INFO[s && s.status] || STATUS_INFO.unknown; }

const CHANNEL_COLORS = { radarrussiia: '#ff5c5c', kpszsu: '#4fb6ff', lpr1_treugolnik: '#ff9f3d' };
const TRACK_COLORS = { drone: '#ff4fd8', missile: '#ffb03d', other: '#8aa8c8' };

// How much history is visible in the map window that ends at the timeline
// cursor. Scrubbing moves this window through the retained history.
const DISPLAY_WINDOW_MS = 90 * 60 * 1000;
const TRACK_KEEP_MS = 4 * 3600 * 1000; // keep a track visible this long past its last point

// ---------- state ----------
const state = {
  sightings: [],   // raw from store (48h)
  tracks: [],      // raw from pipeline
  config: {},
  running: false,
  filter: 'all',
  layers: loadLayers(),
  timeline: { live: true, asOf: Date.now(), playing: false, speed: 300 },
  hasAutoZoomed: false,
};

function loadLayers() {
  const def = { tracks: true, zones: true, lines: true, labels: false, clock: true };
  try { return Object.assign(def, JSON.parse(localStorage.getItem('ddx-layers') || '{}')); }
  catch { return def; }
}

// ---------- geo helpers ----------
function normPlace(str) {
  return (str || '').toString().toLowerCase().replace(/ё/g, 'е')
    .replace(/[«»"'`.,()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}
const COMPASS = {
  n:0,north:0,север:0, ne:45,'north-east':45,northeast:45,'северо-восток':45,
  e:90,east:90,восток:90, se:135,'south-east':135,southeast:135,'юго-восток':135,
  s:180,south:180,юг:180, sw:225,'south-west':225,southwest:225,'юго-запад':225,
  w:270,west:270,запад:270, nw:315,'north-west':315,northwest:315,'северо-запад':315,
};
function headingToBearing(h) {
  if (!h) return null;
  const k = h.toString().trim().toLowerCase().replace(/\s+/g, '-');
  if (k in COMPASS) return COMPASS[k];
  for (const w of Object.keys(COMPASS)) if (w.length > 2 && k.includes(w)) return COMPASS[w];
  return null;
}
function extractDestFromHeading(heading) {
  if (!heading) return null;
  const m = heading.toString().match(/^\s*towards?\s+(.+)/i);
  return m ? m[1].split(',')[0].trim() : null;
}
function bearingTo(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dla = toRad(lat2 - lat1), dlo = toRad(lon2 - lon1);
  const a = Math.sin(dla / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}
function projectPoint(lat, lon, bearingDeg, distKm) {
  const R = 6371, d = distKm / R, b = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180, λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI) + 540) % 360 - 180];
}

// Curated well-known destinations, so arrows point the right way even when the
// backend didn't geocode the destination.
const DEST_RAW = [
  [55.7558,37.6173,['Moscow','Москва','Москву','Москвы','Moscow Oblast']],
  [59.9343,30.3351,['Saint Petersburg','St Petersburg','Петербург','Санкт-Петербург']],
  [50.4501,30.5234,['Kyiv','Kiev','Киев','Київ']],[49.9935,36.2304,['Kharkiv','Kharkov','Харків','Харьков']],
  [46.4825,30.7233,['Odesa','Odessa','Одеса','Одесса']],[48.4647,35.0462,['Dnipro','Дніпро','Днепр']],
  [49.8397,24.0297,['Lviv','Львів','Львов']],[47.8388,35.1396,['Zaporizhzhia','Запоріжжя','Запорожье']],
  [46.9750,31.9946,['Mykolaiv','Миколаїв','Николаев']],[46.6354,32.6169,['Kherson','Херсон']],
  [49.5883,34.5514,['Poltava','Полтава']],[50.9077,34.7981,['Sumy','Суми','Сумы']],
  [51.4982,31.2893,['Chernihiv','Чернігів','Чернигов']],[50.5997,36.5983,['Belgorod','Белгород']],
  [51.7373,36.1874,['Kursk','Курск']],[51.6608,39.2003,['Voronezh','Воронеж']],
  [53.2436,34.3634,['Bryansk','Брянск']],[47.2357,39.7015,['Rostov-on-Don','Rostov','Ростов']],
  [45.0355,38.9753,['Krasnodar','Краснодар']],[54.1931,37.6173,['Tula','Тула']],
  [54.5293,36.2754,['Kaluga','Калуга']],[52.9651,36.0785,['Oryol','Orel','Орёл','Орел']],
  [52.6031,39.5708,['Lipetsk','Липецк']],[52.7212,41.4523,['Tambov','Тамбов']],
  [54.6269,39.6916,['Ryazan','Рязань']],[54.7818,32.0401,['Smolensk','Смоленск']],
  [56.8587,35.9176,['Tver','Тверь']],[56.2965,43.9361,['Nizhny Novgorod','Нижний Новгород']],
  [51.5331,46.0342,['Saratov','Саратов']],[51.4847,46.1207,['Engels','Энгельс']],
  [48.7080,44.5133,['Volgograd','Волгоград']],[44.6166,33.5254,['Sevastopol','Севастополь']],
  [44.9521,34.1024,['Simferopol','Симферополь']],[44.7239,37.7708,['Novorossiysk','Новороссийск']],
  [55.8304,49.0661,['Kazan','Казань']],[53.1959,50.1002,['Samara','Самара']],
];
const DEST_COORDS = {};
for (const [lat, lon, names] of DEST_RAW) for (const nm of names) DEST_COORDS[normPlace(nm)] = [lat, lon];
function lookupDest(name) {
  const k = normPlace(name);
  if (!k) return null;
  if (DEST_COORDS[k]) return DEST_COORDS[k];
  const stripped = k.replace(/\b(oblast|region|raion|district|city|krai|republic)\b/g, '').replace(/\s+/g, ' ').trim();
  return stripped && DEST_COORDS[stripped] ? DEST_COORDS[stripped] : null;
}
function resolveDestLatLon(s) {
  const name = s.destination || extractDestFromHeading(s.heading);
  if (name) { const g = lookupDest(name); if (g) return { lat: g[0], lon: g[1], name }; }
  return null;
}
function destIsElsewhere(s, dest) {
  return dest && typeof s.lat === 'number' && (Math.abs(dest.lat - s.lat) > 0.05 || Math.abs(dest.lon - s.lon) > 0.05);
}
function resolveBearing(s) {
  if (typeof s.bearing === 'number' && isFinite(s.bearing)) return s.bearing;
  const dest = resolveDestLatLon(s);
  if (destIsElsewhere(s, dest)) return bearingTo(s.lat, s.lon, dest.lat, dest.lon);
  return headingToBearing(s.heading);
}
const MAX_ARROW_KM = 1500;
function confidentDest(s) {
  const dest = resolveDestLatLon(s);
  if (!destIsElsewhere(s, dest)) return null;
  if (haversineKm(s.lat, s.lon, dest.lat, dest.lon) > MAX_ARROW_KM) return null;
  return dest;
}
function confidentBearing(s) {
  const dest = confidentDest(s);
  return dest ? bearingTo(s.lat, s.lon, dest.lat, dest.lon) : null;
}

// ---------- text helpers ----------
function esc(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = Math.round((Date.now() - d) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return diff + 'm ago';
  return Math.round(diff / 60) + 'h ago';
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtUTC(d) {
  d = d instanceof Date ? d : new Date(d);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
function bearingWord(b) { return ['N','NE','E','SE','S','SW','W','NW'][Math.round(b / 45) % 8]; }
function channelTag(name) {
  if (!name) return '';
  const c = CHANNEL_COLORS[name] || '#8ab0d0';
  return `<span style="background:${c};color:#0d1b2a;border-radius:3px;padding:0 5px;font-size:10px;font-weight:700;vertical-align:middle">@${esc(name)}</span>`;
}

// ---------- data cleaning (mirrors the pipeline, defensive on the client) ----------
function isRegionLevelClear(s) {
  if (s.status !== 'all_clear') return false;
  const loc = normPlace(s.location), reg = normPlace(s.region);
  return (reg && loc === reg) || /област|oblast|region|край|республик/.test(loc);
}
function supersedeWithAllClears(list, asOf) {
  const clearedAt = new Map();
  for (const s of list) {
    if (!isRegionLevelClear(s)) continue;
    const rk = normPlace(s.region || s.location);
    const t = Date.parse(s.timestamp || '') || 0;
    if (!clearedAt.has(rk) || t > clearedAt.get(rk)) clearedAt.set(rk, t);
  }
  if (!clearedAt.size) return list;
  return list.filter((s) => {
    if (!statusInfo(s).warn) return true;
    const ct = clearedAt.get(normPlace(s.region || ''));
    const st = Date.parse(s.timestamp || '') || 0;
    return !(ct && st <= ct);
  });
}
function consolidateByLocation(list) {
  const groups = new Map();
  for (const s of list) {
    const key = normPlace(s.location) + '|' + normPlace(s.region);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));
    const rep = Object.assign({}, arr[0]);
    rep.reports = arr.length;
    rep.sources = [...new Set(arr.map((s) => s.channel).filter(Boolean))];
    if (rep.count == null) {
      const counts = arr.map((s) => s.count).filter((n) => typeof n === 'number');
      rep.count = counts.length ? Math.max.apply(null, counts) : null;
    }
    out.push(rep);
  }
  return out;
}

// Sightings visible at the timeline cursor: within DISPLAY_WINDOW_MS ending at asOf.
function sightingsAsOf(asOf) {
  const lo = asOf - DISPLAY_WINDOW_MS;
  const inWin = state.sightings.filter((s) => {
    if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false;
    const t = Date.parse(s.timestamp || '') || 0;
    return t > 0 && t <= asOf && t >= lo;
  }).filter((s) => typeof s.confidence !== 'number' || s.confidence >= 0.3);
  return consolidateByLocation(supersedeWithAllClears(inWin, asOf));
}

// Tracks trimmed to the timeline cursor: points up to asOf, dropped if the last
// visible point is older than TRACK_KEEP_MS before asOf.
function tracksAsOf(asOf) {
  const out = [];
  for (const t of state.tracks) {
    const pts = (t.points || []).filter((p) => (Date.parse(p.time) || 0) <= asOf);
    if (pts.length < 2) continue;
    const last = Date.parse(pts[pts.length - 1].time) || 0;
    if (asOf - last > TRACK_KEEP_MS) continue;
    out.push(Object.assign({}, t, {
      points: pts, lastSeen: pts[pts.length - 1].time,
      ended: t.ended && pts.length === t.points.length,
    }));
  }
  return out;
}

// ---------- filter ----------
function matchesFilter(s) {
  switch (state.filter) {
    case 'danger':  return statusInfo(s).level >= 3;
    case 'inbound': return s.status === 'approaching' || s.status === 'overhead';
    case 'cleared': return s.status === 'all_clear' || s.status === 'shot_down';
    case 'drone':   return s.threatType === 'drone';
    case 'missile': return ['missile','cruise_missile','ballistic_missile'].includes(s.threatType);
    default: return true;
  }
}
function trackMatchesFilter(t) {
  if (state.filter === 'drone') return t.threatClass === 'drone';
  if (state.filter === 'missile') return t.threatClass === 'missile';
  return true;
}

// ---------- glyphs ----------
function droneGlyph(cx, cy, color, s) {
  const a = 4.8 * s, rr = 3.0 * s, sw = 1.6 * s;
  const corners = [[-a,-a],[a,-a],[-a,a],[a,a]];
  let arms = '', rotors = '';
  for (const [dx, dy] of corners) {
    arms += `<line x1="${cx}" y1="${cy}" x2="${cx+dx}" y2="${cy+dy}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    rotors += `<circle class="rotor" cx="${cx+dx}" cy="${cy+dy}" r="${rr}" fill="#0d1b2a" stroke="${color}" stroke-width="${1.3*s}"/>`;
    rotors += `<line class="rotor" x1="${cx+dx-rr*0.7}" y1="${cy+dy}" x2="${cx+dx+rr*0.7}" y2="${cy+dy}" stroke="${color}" stroke-width="${0.9*s}" opacity="0.7"/>`;
  }
  return arms + rotors + `<circle cx="${cx}" cy="${cy}" r="${2.6*s}" fill="${color}"/>`;
}
function missileGlyph(cx, cy, color, s) {
  const h = 7.5 * s;
  return `<polygon points="${cx},${cy-h} ${cx-h*0.55},${cy+h*0.7} ${cx+h*0.55},${cy+h*0.7}" fill="#0d1b2a" stroke="${color}" stroke-width="${1.7*s}" stroke-linejoin="round"/>` +
    `<polygon points="${cx},${cy-h} ${cx-h*0.28},${cy} ${cx+h*0.28},${cy}" fill="${color}"/>`;
}
function genericGlyph(cx, cy, color, sym, s) {
  const r = 7.5 * s;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0d1b2a" stroke="${color}" stroke-width="${2*s}"/>` +
    `<text x="${cx}" y="${cy+3.6*s}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${10.5*s}" font-weight="bold" fill="${color}">${sym}</text>`;
}
function clearGlyph(cx, cy, color, s) {
  const r = 7.5 * s;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0d1b2a" stroke="${color}" stroke-width="${2*s}"/>` +
    `<path d="M${cx-3.6*s},${cy+0.3*s} L${cx-1*s},${cy+3*s} L${cx+3.8*s},${cy-3*s}" fill="none" stroke="${color}" stroke-width="${2*s}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function threatGlyph(type, cx, cy, color, s) {
  if (type === 'drone') return droneGlyph(cx, cy, color, s);
  if (type === 'missile' || type === 'cruise_missile' || type === 'ballistic_missile') return missileGlyph(cx, cy, color, s);
  return genericGlyph(cx, cy, color, (THREAT[type] || THREAT.unknown).sym, s);
}
function buildIcon(s) {
  const info = statusInfo(s), color = info.color;
  const bearing = confidentBearing(s);
  const isWarn = info.warn, isDanger = info.level >= 3;
  const count = Math.max(1, s.count || 1);
  const scale = 1.05, glyphR = 7.8 * scale;
  const showCount = count > 1, label = '×' + count, fs = 12.5;
  const labelW = showCount ? label.length * 7 + 12 : 0, labelGap = 6, labelHalf = showCount ? 10 : 0;
  const ringR = isDanger ? glyphR + 4 : glyphR;
  const arrowReach = bearing !== null ? glyphR + 22 : 0, m = 5;
  const leftPad = Math.max(ringR, arrowReach);
  const topPad = Math.max(ringR, arrowReach, labelHalf);
  const botPad = Math.max(ringR, arrowReach, labelHalf);
  const rightPad = Math.max(ringR, arrowReach, glyphR + labelGap + labelW);
  const Gx = leftPad + m, Gy = topPad + m;
  const W = Math.ceil(leftPad + rightPad + 2 * m), H = Math.ceil(topPad + botPad + 2 * m);
  const glyph = s.status === 'all_clear' ? clearGlyph(Gx, Gy, color, scale) : threatGlyph(s.threatType, Gx, Gy, color, scale);
  let arrow = '';
  if (bearing !== null) {
    const base = glyphR + 3, head = glyphR + 16, tip = glyphR + 22;
    arrow = `<g transform="rotate(${bearing} ${Gx} ${Gy})">` +
      `<line x1="${Gx}" y1="${Gy-base}" x2="${Gx}" y2="${Gy-head}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>` +
      `<polygon points="${Gx},${Gy-tip} ${Gx-6},${Gy-head+1} ${Gx+6},${Gy-head+1}" fill="${color}"/></g>`;
  }
  const pulse = isWarn ? `<circle class="pulse" cx="${Gx}" cy="${Gy}" r="${glyphR}" fill="${color}"/>` : '';
  const alertRing = isDanger ? `<circle class="pulse-alert" cx="${Gx}" cy="${Gy}" r="${glyphR+4}" fill="none" stroke="${color}" stroke-width="2" opacity="0.8"/>` : '';
  let badge = '';
  if (showCount) {
    const bx = Gx + glyphR + labelGap;
    badge = `<rect x="${bx}" y="${Gy-9}" width="${labelW}" height="18" rx="9" fill="#0d1b2a" stroke="${color}" stroke-width="1.5"/>` +
      `<text x="${bx+labelW/2}" y="${Gy+4}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fs}" font-weight="bold" fill="${color}">${label}</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${alertRing}${pulse}${arrow}${glyph}${badge}</svg>`;
  return L.divIcon({ className: 'threat-icon', html: svg, iconSize: [W, H], iconAnchor: [Gx, Gy], popupAnchor: [0, -(topPad + 2)] });
}
function arrowheadIcon(bearing, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
    `<g transform="rotate(${bearing} 11 11)"><polygon points="11,2 4,17 11,13 18,17" fill="${color}" stroke="#0d1b2a" stroke-width="1"/></g></svg>`;
  return L.divIcon({ className: 'arrow-icon', html: svg, iconSize: [22, 22], iconAnchor: [11, 11] });
}

function popupHtml(s) {
  const t = THREAT[s.threatType] || THREAT.unknown;
  const info = statusInfo(s);
  const bits = [t.label];
  if (s.count) bits.push('×' + s.count);
  if (s.region) bits.push(s.region);
  const bearing = resolveBearing(s);
  const destName = s.destination || extractDestFromHeading(s.heading);
  let going = '';
  if (destName) going = `<div class="popup-dest">➤ Heading toward ${esc(destName)}</div>`;
  else if (bearing !== null) going = `<div class="popup-dest">➤ Heading ${esc(s.heading || bearingWord(bearing))}</div>`;
  const statusLine = `<div class="popup-status" style="color:${info.color}">● ${esc(info.label)}${info.level >= 3 ? ' — warning' : ''}</div>`;
  const nSources = s.sources ? s.sources.length : (s.channel ? 1 : 0);
  const confirmLine = nSources >= 2 ? `<div class="popup-confirm">✓ Confirmed by ${nSources} sources</div>` : '';
  const accParts = [];
  if (s.reports > 1) accParts.push(esc(`${s.reports} reports`));
  accParts.push(esc(s.geocodePrecision === 'region' ? 'region-level (approx.)' : 'pinpoint'));
  if (typeof s.confidence === 'number') accParts.push(esc(`${Math.round(s.confidence * 100)}% conf.`));
  const chans = s.sources && s.sources.length ? s.sources : (s.channel ? [s.channel] : []);
  if (chans.length) accParts.push(chans.map(channelTag).join(' '));
  const utc = fmtUTC(s.timestamp);
  if (utc) accParts.push(esc(utc));
  return `
    <div class="popup-title">${esc(s.location)}</div>
    ${statusLine}${confirmLine}
    <div class="popup-meta">${esc(bits.join(' · '))} · ${fmtTime(s.timestamp)}</div>
    ${going}
    <div class="popup-acc">${accParts.join(' · ')}</div>
    ${s.postText ? `<div class="popup-text">${esc(s.postText)}</div>` : ''}
    ${s.postLink ? `<div class="popup-link"><a href="#" data-ext="${esc(s.postLink)}">Open in Telegram ↗</a></div>` : ''}`;
}

// ---------- map ----------
const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([54.5, 42.0], 5);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19, crossOrigin: 'anonymous',
  attribution: '© OpenStreetMap © CARTO',
}).addTo(map);

const tracksLayer = L.layerGroup().addTo(map);
const zonesLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markersLayer = L.layerGroup().addTo(map);
const labelsLayer = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map);
const LAYER_GROUPS = { tracks: tracksLayer, zones: zonesLayer, lines: routeLayer, labels: labelsLayer };

function applyLayerToggles() {
  for (const [key, grp] of Object.entries(LAYER_GROUPS)) {
    if (state.layers[key]) { if (!map.hasLayer(grp)) map.addLayer(grp); }
    else if (map.hasLayer(grp)) map.removeLayer(grp);
  }
  document.getElementById('clock').style.display = state.layers.clock ? 'block' : 'none';
  document.querySelectorAll('#layerBar .chip').forEach((b) => b.classList.toggle('active', !!state.layers[b.dataset.layer]));
}

// Open Telegram links via the main process (CSP blocks navigation).
map.getContainer().addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-ext]');
  if (a) { e.preventDefault(); api.openExternal(a.getAttribute('data-ext')); }
});

// ---------- render ----------
function currentAsOf() { return state.timeline.live ? Date.now() : state.timeline.asOf; }

function renderAll() {
  const asOf = currentAsOf();
  const sightings = sightingsAsOf(asOf);
  renderMarkers(sightings);
  renderTracks(tracksAsOf(asOf));
  renderWarnings(sightings);
  updateHeader(sightings);
  updateClock();
}

function renderMarkers(sightings) {
  zonesLayer.clearLayers(); routeLayer.clearLayers();
  markersLayer.clearLayers(); labelsLayer.clearLayers();
  const asOf = currentAsOf();
  const toShow = sightings.filter(matchesFilter);
  const pts = [];
  for (const s of toShow) {
    const info = statusInfo(s), color = info.color;
    if (info.level >= 3) {
      L.circle([s.lat, s.lon], { radius: 45000, color, fillColor: color, fillOpacity: 0.045, weight: 1, opacity: 0.28, dashArray: '5 5' }).addTo(zonesLayer);
    } else if (s.geocodePrecision === 'region') {
      L.circle([s.lat, s.lon], { radius: 30000, color: '#6f93b4', weight: 1, opacity: 0.25, fill: false, dashArray: '3 6' }).addTo(zonesLayer);
    }
    const dest = confidentDest(s), bearing = resolveBearing(s);
    if (dest) {
      const lineBearing = bearingTo(s.lat, s.lon, dest.lat, dest.lon);
      L.polyline([[s.lat, s.lon], [dest.lat, dest.lon]], { color, weight: 2.5, opacity: 0.55, dashArray: '7 6' }).addTo(routeLayer);
      L.marker([dest.lat, dest.lon], { icon: arrowheadIcon(lineBearing, color), interactive: false, keyboard: false }).addTo(routeLayer);
      pts.push([dest.lat, dest.lon]);
    } else if (bearing !== null && info.warn) {
      const projEnd = projectPoint(s.lat, s.lon, bearing, 200);
      L.polyline([[s.lat, s.lon], projEnd], { color, weight: 1.5, opacity: 0.25, dashArray: '3 10' }).addTo(routeLayer);
      L.marker(projEnd, { icon: arrowheadIcon(bearing, color), interactive: false, keyboard: false, opacity: 0.35 }).addTo(routeLayer);
    }
    const ageMin = (asOf - (Date.parse(s.timestamp || '') || asOf)) / 60000;
    const opacity = ageMin <= 10 ? 1 : Math.max(0.5, 1 - (ageMin - 10) / 100);
    L.marker([s.lat, s.lon], { icon: buildIcon(s), opacity }).bindPopup(popupHtml(s), { maxWidth: 280 }).addTo(markersLayer);
    pts.push([s.lat, s.lon]);
    L.tooltip({ permanent: true, direction: 'bottom', className: 'place-label', offset: [0, 14], interactive: false })
      .setContent(`<span style="color:${color}">${esc(s.location)}</span>`).setLatLng([s.lat, s.lon]).addTo(labelsLayer);
  }
  if (!state.hasAutoZoomed && pts.length) {
    const activePts = toShow.filter((s) => statusInfo(s).warn).map((s) => [s.lat, s.lon]);
    map.fitBounds(activePts.length ? activePts : pts, { padding: [80, 80], maxZoom: 9 });
    state.hasAutoZoomed = true;
  }
}

function trackTooltip(t) {
  const from = t.points[0], to = t.points[t.points.length - 1];
  const kind = t.threatClass === 'missile' ? 'Missile' : 'Drone';
  const span = `${fmtUTC(t.firstSeen).replace(' UTC','')} → ${fmtUTC(t.lastSeen)}`;
  return `<b>${kind} track</b> · ${t.points.length} waypoints · ~${t.distanceKm} km` +
    `<br>${esc(from.location || '?')} → ${esc(to.location || '?')}` +
    `${t.ended ? ' · <b style="color:#4fb6ff">ended</b>' : ''}<br><span style="color:#8ab0d0">${span}</span>`;
}
function renderTracks(tracks) {
  tracksLayer.clearLayers();
  const asOf = currentAsOf();
  for (const t of tracks) {
    if (!trackMatchesFilter(t)) continue;
    const latlngs = t.points.map((p) => [p.lat, p.lon]);
    const color = TRACK_COLORS[t.threatClass] || TRACK_COLORS.other;
    const ageH = Math.max(0, (asOf - (Date.parse(t.lastSeen) || asOf)) / 3600000);
    const alpha = Math.max(0.14, 0.9 - ageH * 0.075);
    const glow = L.polyline(latlngs, { color, weight: 9, opacity: alpha * 0.16 }).addTo(tracksLayer);
    glow.bindTooltip(trackTooltip(t), { sticky: true, className: 'trk-tip', opacity: 1 });
    L.polyline(latlngs, { color, weight: 1.7, opacity: alpha, interactive: false }).addTo(tracksLayer);
    for (const p of t.points) {
      L.circleMarker([p.lat, p.lon], { radius: 2.1, color, fillColor: color, fillOpacity: alpha, opacity: alpha, weight: 1, interactive: false }).addTo(tracksLayer);
    }
    if (!t.ended && ageH < 2 && latlngs.length >= 2) {
      const a = latlngs[latlngs.length - 2], b = latlngs[latlngs.length - 1];
      L.marker(b, { icon: arrowheadIcon(bearingTo(a[0], a[1], b[0], b[1]), color), interactive: false, keyboard: false, opacity: Math.min(1, alpha + 0.15) }).addTo(tracksLayer);
    }
  }
}

function renderWarnings(sightings) {
  const panel = document.getElementById('warnPanel');
  const list = document.getElementById('warnList');
  const title = document.getElementById('warnTitle');
  const warns = sightings.filter((s) => statusInfo(s).warn);
  if (!warns.length) { panel.style.display = 'none'; return; }
  const groups = new Map();
  for (const s of warns) {
    const key = s.region || s.location || '—', info = statusInfo(s);
    let g = groups.get(key);
    if (!g) { g = { key, level: 0, spots: 0, latest: 0, latlng: [s.lat, s.lon], label: info.label, color: info.color }; groups.set(key, g); }
    g.spots++;
    const t = Date.parse(s.timestamp || '') || 0;
    if (t > g.latest) g.latest = t;
    if (info.level > g.level) { g.level = info.level; g.label = info.label; g.color = info.color; g.latlng = [s.lat, s.lon]; }
  }
  const arr = [...groups.values()].sort((a, b) => b.level - a.level || b.latest - a.latest).slice(0, 14);
  const danger = arr.some((g) => g.level >= 3);
  panel.className = 'warn-panel' + (danger ? ' danger' : '');
  panel.style.display = 'block';
  title.textContent = `Active warnings (${groups.size})`;
  list.innerHTML = '';
  for (const g of arr) {
    const ago = g.latest ? fmtTime(new Date(g.latest).toISOString()) : '';
    const row = document.createElement('div');
    row.className = 'warn-item';
    row.innerHTML = `<span class="warn-sev" style="background:${g.color}"></span>` +
      `<span class="warn-body"><span class="warn-region">${esc(g.key)}</span>` +
      `<span class="warn-meta">${esc(g.label)} · ${g.spots} spot${g.spots > 1 ? 's' : ''}${ago ? ' · ' + ago : ''}</span></span>`;
    row.addEventListener('click', () => { if (typeof g.latlng[0] === 'number') map.flyTo(g.latlng, Math.max(map.getZoom(), 8), { duration: 0.6 }); });
    list.appendChild(row);
  }
}

function updateHeader(sightings) {
  const badge = document.getElementById('threatBadge');
  const active = sightings.filter((s) => s.status !== 'all_clear');
  const danger = active.filter((s) => statusInfo(s).level >= 3).length;
  const inbound = active.filter((s) => statusInfo(s).level === 2).length;
  const lvl = danger >= 3 ? 'CRITICAL' : danger >= 1 ? 'HIGH' : inbound >= 2 ? 'ELEVATED' : inbound >= 1 ? 'MODERATE' : active.length ? 'LOW' : 'CLEAR';
  const lvlColor = danger >= 3 ? '#ff2d2d' : danger >= 1 ? '#ff5c5c' : inbound >= 2 ? '#ff7a3d' : inbound >= 1 ? '#ffb03d' : active.length ? '#9ab4d0' : '#3fd87f';
  badge.innerHTML = `· <b style="color:${lvlColor}">${lvl}</b> · ${active.length} active`;
}

// ---------- console clock ----------
function updateClock() {
  const asOf = currentAsOf();
  const d = new Date(asOf);
  const p = (n) => String(n).padStart(2, '0');
  document.getElementById('clockDate').textContent = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  document.getElementById('clockTime').textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const zone = document.getElementById('clockZone');
  const clock = document.getElementById('clock');
  if (state.timeline.live) { zone.textContent = 'UTC · LIVE'; clock.classList.remove('replay'); }
  else { zone.textContent = 'UTC · REPLAY'; clock.classList.add('replay'); }
}
setInterval(() => { if (state.timeline.live) updateClock(); }, 1000);

// ---------- timeline ----------
function historyBounds() {
  const times = state.sightings.map((s) => Date.parse(s.timestamp || '') || 0).filter(Boolean);
  const now = Date.now();
  const retentionMs = (state.config.retentionHours || 48) * 3600 * 1000;
  const min = times.length ? Math.max(Math.min(...times), now - retentionMs) : now - retentionMs;
  return { min, max: now };
}
function sliderToTime(v) { const { min, max } = historyBounds(); return min + (max - min) * (v / 1000); }
function timeToSlider(t) { const { min, max } = historyBounds(); return max <= min ? 1000 : Math.round(((t - min) / (max - min)) * 1000); }

function setTimelineTime(asOf, { fromSlider = false } = {}) {
  const { max } = historyBounds();
  state.timeline.live = asOf >= max - 1000;
  state.timeline.asOf = Math.min(asOf, max);
  const tlTime = document.getElementById('tlTime');
  if (state.timeline.live) { tlTime.textContent = 'LIVE'; tlTime.classList.remove('replay'); }
  else { tlTime.textContent = fmtUTC(state.timeline.asOf); tlTime.classList.add('replay'); }
  document.getElementById('tlLive').classList.toggle('active', state.timeline.live);
  if (!fromSlider) document.getElementById('tlSlider').value = timeToSlider(state.timeline.asOf);
  renderAll();
}
function goLive() {
  stopReplay();
  state.timeline.live = true;
  document.getElementById('tlSlider').value = 1000;
  setTimelineTime(Date.now());
}
let replayTimer = null;
function startReplay() {
  if (replayTimer) return;
  // If we're at LIVE, rewind to the start of history to replay the whole window.
  if (state.timeline.live) { const { min } = historyBounds(); state.timeline.asOf = min; state.timeline.live = false; }
  state.timeline.playing = true;
  document.getElementById('tlPlay').textContent = '⏸';
  let lastTick = Date.now();
  replayTimer = setInterval(() => {
    const nowReal = Date.now();
    const dtReal = (nowReal - lastTick) / 1000; lastTick = nowReal;
    const advance = dtReal * state.timeline.speed * 1000; // sim-ms per real-second
    const { max } = historyBounds();
    let next = state.timeline.asOf + advance;
    if (next >= max) { next = max; setTimelineTime(next); goLive(); return; }
    setTimelineTime(next);
  }, 200);
}
function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  state.timeline.playing = false;
  document.getElementById('tlPlay').textContent = '▶';
}
function toggleReplay() { if (state.timeline.playing) stopReplay(); else startReplay(); }

document.getElementById('tlSlider').addEventListener('input', (e) => {
  stopReplay();
  setTimelineTime(sliderToTime(+e.target.value), { fromSlider: true });
});
document.getElementById('tlPlay').addEventListener('click', toggleReplay);
document.getElementById('tlLive').addEventListener('click', goLive);
document.getElementById('tlSpeed').addEventListener('change', (e) => { state.timeline.speed = +e.target.value; });

// ---------- filter + layer chips ----------
document.querySelectorAll('#filterBar .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    document.querySelectorAll('#filterBar .chip').forEach((b) => b.classList.toggle('active', b === btn));
    renderAll();
  });
});
document.querySelectorAll('#layerBar .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.layer;
    state.layers[key] = !state.layers[key];
    try { localStorage.setItem('ddx-layers', JSON.stringify(state.layers)); } catch {}
    applyLayerToggles();
  });
});

// ---------- monitor controls ----------
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
function setStatus(state_, message) {
  statusText.textContent = message || '';
  statusDot.className = 'dot';
  if (state_ === 'error') statusDot.classList.add('error');
  else if (['polling','processing','backfill','starting'].includes(state_)) statusDot.classList.add('busy');
  else if (state.running) statusDot.classList.add('live');
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const res = await api.startMonitor();
  if (!res.ok) { setStatus('error', res.error); alert(res.error); return; }
  state.running = true;
  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;
  setStatus('starting', 'Monitor started — backfilling history…');
});
document.getElementById('stopBtn').addEventListener('click', async () => {
  await api.stopMonitor();
  state.running = false;
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
  setStatus('stopped', 'Monitor stopped.');
});
document.getElementById('pollBtn').addEventListener('click', async () => {
  setStatus('polling', 'Polling…');
  await api.pollOnce();
  await refreshData();
});

// ---------- backfill progress ----------
function showBackfill(p) {
  const bar = document.getElementById('backfillBar');
  const label = document.getElementById('backfillLabel');
  const fill = document.getElementById('backfillFill');
  bar.style.display = 'flex';
  if (p.phase === 'fetch') { label.textContent = `Downloading @${p.channel} — page ${p.page} (${p.fetched} posts)…`; fill.style.width = '8%'; }
  else if (p.phase === 'fetched') { label.textContent = `@${p.channel}: ${p.total} posts queued`; fill.style.width = '15%'; }
  else if (p.phase === 'extract') {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    label.textContent = `Analyzing posts — ${p.done}/${p.total} (+${p.sightings} sightings)`;
    fill.style.width = Math.max(15, pct) + '%';
  } else if (p.phase === 'done') {
    label.textContent = `Backfill complete — ${p.sightings} sighting(s) from ${p.total} post(s).`;
    fill.style.width = '100%';
    setTimeout(() => { bar.style.display = 'none'; }, 2500);
  }
}

// ---------- data refresh ----------
async function refreshData() {
  const [sightings, tracks] = await Promise.all([api.getSightings(), api.getTracks()]);
  state.sightings = sightings || [];
  state.tracks = tracks || [];
  if (state.timeline.live) { document.getElementById('tlSlider').value = 1000; }
  renderAll();
}

// ---------- export (area → PNG) ----------
function regionOf(s) { return s.region || s.location || '—'; }
function populateExportChrome(bounds) {
  const shown = sightingsAsOf(currentAsOf());
  const inArea = shown.filter((s) => typeof s.lat === 'number' && bounds.contains([s.lat, s.lon]));
  const regionCounts = {};
  inArea.forEach((s) => { const r = regionOf(s); regionCounts[r] = (regionCounts[r] || 0) + 1; });
  const top = Object.entries(regionCounts).sort((a, b) => b[1] - a[1])[0];
  const active = inArea.filter((s) => s.status !== 'all_clear');
  const warns = inArea.filter((s) => statusInfo(s).warn);
  document.getElementById('expMetaTitle').textContent = top ? top[0] : 'Selected area';
  document.getElementById('expMetaSub').textContent = `${fmtUTC(new Date(currentAsOf()))} · ${active.length} active · ${warns.length} warnings`;
  const groups = new Map();
  for (const s of warns) {
    const key = regionOf(s), info = statusInfo(s);
    let g = groups.get(key);
    if (!g) { g = { key, level: 0, spots: 0, color: info.color, label: info.label }; groups.set(key, g); }
    g.spots++;
    if (info.level > g.level) { g.level = info.level; g.color = info.color; g.label = info.label; }
  }
  const arr = [...groups.values()].sort((a, b) => b.level - a.level).slice(0, 8);
  const el = document.getElementById('expWarns');
  el.innerHTML = arr.length
    ? `<div class="eh"><i>●</i> Warnings in view (${groups.size})</div>` + arr.map((g) =>
        `<div class="er"><i style="background:${g.color}"></i><span><b>${esc(g.key)}</b> — ${esc(g.label)}${g.spots > 1 ? ' · ' + g.spots + ' spots' : ''}</span></div>`).join('')
    : '<div class="eh"><i>●</i> Warnings in view</div><div class="eq">No active warnings here.</div>';
}
async function captureToPng(filename) {
  const canvas = await html2canvas(document.body, {
    useCORS: true, backgroundColor: '#0b1622', scale: 2, logging: false, imageTimeout: 15000,
    ignoreElements: (el) => el.classList && (el.classList.contains('no-export') || el.classList.contains('sel-rect') || el.classList.contains('sel-hint')),
    onclone: (doc) => { const st = doc.createElement('style'); st.textContent = '.pulse,.pulse-alert{display:none !important}.threat-icon .rotor{animation:none !important}'; doc.head.appendChild(st); },
  });
  const link = document.createElement('a');
  link.download = filename; link.href = canvas.toDataURL('image/png');
  document.body.appendChild(link); link.click(); link.remove();
}
async function exportArea(bounds) {
  if (typeof html2canvas !== 'function') { alert('Image renderer failed to load.'); return; }
  const btn = document.getElementById('dlBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Rendering…';
  map.fitBounds(bounds, { animate: false, paddingTopLeft: [12, 24], paddingBottomRight: [12, 24] });
  populateExportChrome(map.getBounds());
  document.body.classList.add('export-skin');
  try {
    await new Promise((r) => setTimeout(r, 700));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    await captureToPng(`drone-map-${stamp}.png`);
  } catch (err) { alert('Could not render: ' + err.message); }
  finally { document.body.classList.remove('export-skin'); btn.disabled = false; btn.textContent = orig; }
}
let selecting = false, selStart = null, selDiv = null, selHint = null;
function selPoint(e) { const r = map.getContainer().getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY }; }
function startAreaSelect() {
  if (selecting) return;
  selecting = true;
  map.getContainer().classList.add('map-selecting'); map.dragging.disable(); if (map.boxZoom) map.boxZoom.disable();
  selHint = document.createElement('div'); selHint.className = 'sel-hint no-export';
  selHint.innerHTML = 'Drag to select an area to export · <b>Esc</b> to cancel';
  document.body.appendChild(selHint);
  map.getContainer().addEventListener('pointerdown', selDown); document.addEventListener('keydown', selKey);
}
function selDown(e) {
  if (!selecting || e.button !== 0) return;
  e.preventDefault(); selStart = selPoint(e);
  selDiv = document.createElement('div'); selDiv.className = 'sel-rect';
  Object.assign(selDiv.style, { left: selStart.cx + 'px', top: selStart.cy + 'px', width: '0px', height: '0px' });
  document.body.appendChild(selDiv);
  window.addEventListener('pointermove', selMove); window.addEventListener('pointerup', selUp);
}
function selMove(e) {
  if (!selStart) return; const p = selPoint(e);
  Object.assign(selDiv.style, { left: Math.min(p.cx, selStart.cx) + 'px', top: Math.min(p.cy, selStart.cy) + 'px', width: Math.abs(p.cx - selStart.cx) + 'px', height: Math.abs(p.cy - selStart.cy) + 'px' });
}
function selUp(e) {
  window.removeEventListener('pointermove', selMove); window.removeEventListener('pointerup', selUp);
  const p = selPoint(e), start = selStart; cancelAreaSelect();
  if (!start) return;
  if (Math.abs(p.x - start.x) < 20 || Math.abs(p.y - start.y) < 20) return;
  const a = map.containerPointToLatLng([Math.min(p.x, start.x), Math.min(p.y, start.y)]);
  const b = map.containerPointToLatLng([Math.max(p.x, start.x), Math.max(p.y, start.y)]);
  exportArea(L.latLngBounds(a, b));
}
function selKey(e) { if (e.key === 'Escape') cancelAreaSelect(); }
function cancelAreaSelect() {
  selecting = false; selStart = null;
  if (selDiv) { selDiv.remove(); selDiv = null; }
  if (selHint) { selHint.remove(); selHint = null; }
  map.getContainer().classList.remove('map-selecting'); map.dragging.enable(); if (map.boxZoom) map.boxZoom.enable();
  map.getContainer().removeEventListener('pointerdown', selDown); document.removeEventListener('keydown', selKey);
  window.removeEventListener('pointermove', selMove); window.removeEventListener('pointerup', selUp);
}
document.getElementById('dlBtn').addEventListener('click', startAreaSelect);

// ---------- settings ----------
const modal = document.getElementById('settingsModal');
function openSettings() {
  const c = state.config;
  document.getElementById('setBackend').value = c.aiBackend || 'ollama';
  document.getElementById('setOllamaUrl').value = c.ollamaBaseUrl || '';
  document.getElementById('setOllamaModel').value = c.ollamaModel || '';
  document.getElementById('setVerify').checked = c.verifyPass !== false;
  document.getElementById('setOrKey').value = '';
  document.getElementById('setOrModel').value = c.openrouterModel || '';
  document.getElementById('setChannels').value = c.telegramChannels || '';
  document.getElementById('setBackfill').value = c.backfillHours || 48;
  document.getElementById('setPoll').value = c.pollIntervalSeconds || 120;
  document.getElementById('setDemo').checked = !!c.demo;
  document.getElementById('backendTestResult').textContent = '';
  syncBackendGroups();
  modal.style.display = 'flex';
}
function syncBackendGroups() {
  const b = document.getElementById('setBackend').value;
  document.getElementById('grpOllama').style.display = b === 'ollama' ? 'block' : 'none';
  document.getElementById('grpOpenrouter').style.display = b === 'openrouter' ? 'block' : 'none';
}
document.getElementById('setBackend').addEventListener('change', syncBackendGroups);
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsCancel').addEventListener('click', () => { modal.style.display = 'none'; });
document.getElementById('testBackendBtn').addEventListener('click', async () => {
  const el = document.getElementById('backendTestResult');
  el.className = 'mtest'; el.textContent = 'Testing…';
  // Persist first so the check uses the current form values.
  await saveSettings(false);
  const res = await api.checkBackend();
  if (res.ok) { el.className = 'mtest ok'; el.textContent = `✓ ${res.backend} ready${res.models ? ' — ' + res.models.length + ' model(s) installed' : ''}.`; }
  else { el.className = 'mtest bad'; el.textContent = '✗ ' + res.error; }
});
async function saveSettings(close = true) {
  const patch = {
    aiBackend: document.getElementById('setBackend').value,
    ollamaBaseUrl: document.getElementById('setOllamaUrl').value.trim(),
    ollamaModel: document.getElementById('setOllamaModel').value.trim(),
    verifyPass: document.getElementById('setVerify').checked,
    openrouterModel: document.getElementById('setOrModel').value.trim(),
    telegramChannels: document.getElementById('setChannels').value.trim(),
    backfillHours: +document.getElementById('setBackfill').value,
    pollIntervalSeconds: +document.getElementById('setPoll').value,
    demo: document.getElementById('setDemo').checked,
  };
  const orKey = document.getElementById('setOrKey').value.trim();
  if (orKey) patch.openrouterApiKey = orKey;
  state.config = await api.updateSettings(patch);
  if (close) modal.style.display = 'none';
}
document.getElementById('settingsSave').addEventListener('click', () => saveSettings(true));

// ---------- events ----------
api.on('pipeline:status', (s) => setStatus(s.state, s.message));
api.on('pipeline:backfill', (p) => showBackfill(p));
api.on('pipeline:tracks', (t) => { state.tracks = t.tracks || []; renderAll(); });
api.on('pipeline:sighting', () => { /* debounced refresh below via tick */ });
api.on('pipeline:tick', () => refreshData());
api.on('pipeline:error', (e) => console.warn('[pipeline]', e.message));

// ---------- boot ----------
(async function boot() {
  try {
    const boot = await api.bootstrap();
    state.config = boot.config || {};
    state.sightings = boot.sightings || [];
    state.tracks = boot.tracks || [];
  } catch (err) {
    console.error('bootstrap failed', err);
  }
  applyLayerToggles();
  setTimelineTime(Date.now());
  renderAll();
  setStatus('idle', state.sightings.length ? `${state.sightings.length} sighting(s) loaded — press Start to monitor.` : 'Idle — press Start to backfill history and monitor.');
})();
