'use strict';
/* global L */

// View-only map for the Python app. Reads data/{sightings,tracks,status}.json
// (written by drone_detector.py) and renders the live threat map, flight
// tracks and a history timeline. Polls every few seconds.

const THREAT = {
  drone: { label: 'Drone / UAV', sym: '✈' }, aircraft: { label: 'Aircraft / Jet', sym: '✈' },
  missile: { label: 'Missile', sym: '▲' },
  cruise_missile: { label: 'Cruise missile', sym: '▲' }, ballistic_missile: { label: 'Ballistic missile', sym: '▲' },
  air_defense: { label: 'Air defense', sym: '◆' }, explosion: { label: 'Explosion', sym: '✸' }, unknown: { label: 'Unknown', sym: '●' },
};
const STATUS_INFO = {
  alert: { level: 3, color: '#ff3b3b', label: 'Danger', warn: true }, impact: { level: 3, color: '#ff2d2d', label: 'Impact', warn: true },
  approaching: { level: 2, color: '#ff7a3d', label: 'Inbound', warn: true }, overhead: { level: 2, color: '#ffb03d', label: 'Overhead', warn: true },
  shot_down: { level: 1, color: '#4fb6ff', label: 'Intercepted', warn: false }, all_clear: { level: 0, color: '#3fd87f', label: 'All clear', warn: false },
  unknown: { level: 1, color: '#9ab4d0', label: 'Reported', warn: false },
};
function statusInfo(s) { return STATUS_INFO[s && s.status] || STATUS_INFO.unknown; }
const CHANNEL_COLORS = { radarrussiia: '#ff5c5c', kpszsu: '#4fb6ff', lpr1_treugolnik: '#ff9f3d', locatorru: '#a78bfa' };
const TRACK_COLORS = { drone: '#ff4fd8', aircraft: '#8fd6ff', missile: '#ffb03d', other: '#8aa8c8' };
// Markers (current positions) show only the last hour. Tracks show the whole
// recent flight PATH (up to 6h of waypoints) so long winding routes stay
// visible like a radar console — but a track vanishes once its object hasn't
// been reported for an hour. The timeline can still replay full history.
const DISPLAY_WINDOW_MS = 60 * 60 * 1000;
const TRACK_WINDOW_MS = 6 * 3600 * 1000;   // how much of each path to draw
const TRACK_EXPIRE_MS = 60 * 60 * 1000;    // drop the track 1h after its last report
const TRAIL_POINTS = 60;                    // show the full winding path, not a stub

const state = {
  sightings: [], tracks: [], filter: 'all', hasAutoZoomed: false,
  layers: (() => { const d = { tracks: true, zones: true, bases: true, labels: false, clock: true }; try { return Object.assign(d, JSON.parse(localStorage.getItem('ddx-layers') || '{}')); } catch { return d; } })(),
  timeline: { live: true, asOf: Date.now(), playing: false, speed: 300 },
  autoTranslate: (() => { try { return localStorage.getItem('ddx-translate') === '1'; } catch { return false; } })(),
};

// ---- geo helpers ----
function normPlace(str) { return (str || '').toString().toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`.,()\-–—]/g, ' ').replace(/\s+/g, ' ').trim(); }
const COMPASS = { n:0,north:0,север:0,ne:45,'north-east':45,northeast:45,'северо-восток':45,e:90,east:90,восток:90,se:135,'south-east':135,southeast:135,'юго-восток':135,s:180,south:180,юг:180,sw:225,'south-west':225,southwest:225,'юго-запад':225,w:270,west:270,запад:270,nw:315,'north-west':315,northwest:315,'северо-запад':315 };
function headingToBearing(h) { if (!h) return null; const k = h.toString().trim().toLowerCase().replace(/\s+/g, '-'); if (k in COMPASS) return COMPASS[k]; for (const w of Object.keys(COMPASS)) if (w.length > 2 && k.includes(w)) return COMPASS[w]; return null; }
function extractDestFromHeading(h) { if (!h) return null; const m = h.toString().match(/^\s*towards?\s+(.+)/i); return m ? m[1].split(',')[0].trim() : null; }
function bearingTo(lat1, lon1, lat2, lon2) { const r = (d) => d * Math.PI / 180; const p1 = r(lat1), p2 = r(lat2), dl = r(lon2 - lon1); const y = Math.sin(dl) * Math.cos(p2); const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
function haversineKm(lat1, lon1, lat2, lon2) { const r = (d) => d * Math.PI / 180; const dla = r(lat2 - lat1), dlo = r(lon2 - lon1); const a = Math.sin(dla / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dlo / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(a)); }
function projectPoint(lat, lon, bd, dk) { const R = 6371, d = dk / R, b = bd * Math.PI / 180, p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180; const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b)); const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2)); return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI) + 540) % 360 - 180]; }

const DEST_RAW = [[55.7558,37.6173,['Moscow','Москва','Москву','Москвы','Moscow Oblast']],[59.9343,30.3351,['Saint Petersburg','Санкт-Петербург','Петербург']],[50.4501,30.5234,['Kyiv','Київ','Киев']],[49.9935,36.2304,['Kharkiv','Харків','Харьков']],[46.4825,30.7233,['Odesa','Одеса','Одесса']],[48.4647,35.0462,['Dnipro','Дніпро','Днепр']],[47.8388,35.1396,['Zaporizhzhia','Запоріжжя']],[46.9750,31.9946,['Mykolaiv','Миколаїв']],[46.6354,32.6169,['Kherson','Херсон']],[49.5883,34.5514,['Poltava','Полтава']],[50.9077,34.7981,['Sumy','Суми']],[50.5997,36.5983,['Belgorod','Белгород']],[51.7373,36.1874,['Kursk','Курск']],[51.6608,39.2003,['Voronezh','Воронеж']],[53.2436,34.3634,['Bryansk','Брянск']],[47.2357,39.7015,['Rostov-on-Don','Ростов']],[45.0355,38.9753,['Krasnodar','Краснодар']],[54.1931,37.6173,['Tula','Тула']],[54.5293,36.2754,['Kaluga','Калуга']],[52.9651,36.0785,['Oryol','Орёл','Орел']],[52.6031,39.5708,['Lipetsk','Липецк']],[54.6269,39.6916,['Ryazan','Рязань']],[56.2965,43.9361,['Nizhny Novgorod','Нижний Новгород']],[51.5331,46.0342,['Saratov','Саратов']],[51.4847,46.1207,['Engels','Энгельс']],[48.7080,44.5133,['Volgograd','Волгоград']],[44.9521,34.1024,['Simferopol','Симферополь']],[44.6166,33.5254,['Sevastopol','Севастополь']],[55.8304,49.0661,['Kazan','Казань']],[53.1959,50.1002,['Samara','Самара']]];
const DEST_COORDS = {};
for (const [lat, lon, names] of DEST_RAW) for (const nm of names) DEST_COORDS[normPlace(nm)] = [lat, lon];
function lookupDest(name) { const k = normPlace(name); if (!k) return null; if (DEST_COORDS[k]) return DEST_COORDS[k]; const s = k.replace(/\b(oblast|region|raion|district|city|krai|republic)\b/g, '').replace(/\s+/g, ' ').trim(); return s && DEST_COORDS[s] ? DEST_COORDS[s] : null; }
function resolveDestLatLon(s) { const name = s.destination || extractDestFromHeading(s.heading); if (name) { const g = lookupDest(name); if (g) return { lat: g[0], lon: g[1], name }; } return null; }
function destIsElsewhere(s, d) { return d && typeof s.lat === 'number' && (Math.abs(d.lat - s.lat) > 0.05 || Math.abs(d.lon - s.lon) > 0.05); }
function resolveBearing(s) { if (typeof s.bearing === 'number' && isFinite(s.bearing)) return s.bearing; const d = resolveDestLatLon(s); if (destIsElsewhere(s, d)) return bearingTo(s.lat, s.lon, d.lat, d.lon); return headingToBearing(s.heading); }
function confidentDest(s) { const d = resolveDestLatLon(s); if (!destIsElsewhere(s, d)) return null; if (haversineKm(s.lat, s.lon, d.lat, d.lon) > 1500) return null; return d; }
function confidentBearing(s) { const d = confidentDest(s); return d ? bearingTo(s.lat, s.lon, d.lat, d.lon) : null; }

function esc(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; const diff = Math.round((Date.now() - d) / 60000); if (diff < 1) return 'just now'; if (diff < 60) return diff + 'm ago'; return Math.round(diff / 60) + 'h ago'; }
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtUTC(d) { d = d instanceof Date ? d : new Date(d); if (isNaN(d)) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`; }
function bearingWord(b) { return ['N','NE','E','SE','S','SW','W','NW'][Math.round(b / 45) % 8]; }
function channelTag(name) { if (!name) return ''; const c = CHANNEL_COLORS[name] || '#8ab0d0'; return `<span style="background:${c};color:#0d1b2a;border-radius:3px;padding:0 5px;font-size:10px;font-weight:700">@${esc(name)}</span>`; }

// ---- cleaning + as-of windowing ----
function isRegionLevelClear(s) { if (s.status !== 'all_clear') return false; const loc = normPlace(s.location), reg = normPlace(s.region); return (reg && loc === reg) || /област|oblast|region|край|республик/.test(loc); }
function supersedeWithAllClears(list) { const cleared = new Map(); for (const s of list) { if (!isRegionLevelClear(s)) continue; const rk = normPlace(s.region || s.location); const t = Date.parse(s.timestamp || '') || 0; if (!cleared.has(rk) || t > cleared.get(rk)) cleared.set(rk, t); } if (!cleared.size) return list; return list.filter((s) => { if (!statusInfo(s).warn) return true; const ct = cleared.get(normPlace(s.region || '')); const st = Date.parse(s.timestamp || '') || 0; return !(ct && st <= ct); }); }
function consolidateByLocation(list) { const groups = new Map(); for (const s of list) { const key = normPlace(s.location) + '|' + normPlace(s.region); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); } const out = []; for (const arr of groups.values()) { arr.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0)); const rep = Object.assign({}, arr[0]); rep.reports = arr.length; rep.sources = [...new Set(arr.map((s) => s.channel).filter(Boolean))]; if (rep.count == null) { const c = arr.map((s) => s.count).filter((n) => typeof n === 'number'); rep.count = c.length ? Math.max.apply(null, c) : null; } out.push(rep); } return out; }
function sightingsAsOf(asOf) { const lo = asOf - DISPLAY_WINDOW_MS; const w = state.sightings.filter((s) => { if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false; const t = Date.parse(s.timestamp || '') || 0; return t > 0 && t <= asOf && t >= lo; }).filter((s) => typeof s.confidence !== 'number' || s.confidence >= 0.3); return consolidateByLocation(supersedeWithAllClears(w)); }
function tracksAsOf(asOf) {
  const winLo = asOf - TRACK_WINDOW_MS;
  const out = [];
  for (const t of state.tracks) {
    const upto = (t.points || []).filter((p) => (Date.parse(p.time) || 0) <= asOf);
    if (upto.length < 3) continue; // real paths only — never a straight 2-point line
    const headT = Date.parse(upto[upto.length - 1].time) || 0;
    if (asOf - headT > TRACK_EXPIRE_MS) continue; // object not reported for >1h → gone
    // Draw up to the last 6h of the path (keeps long winding routes visible).
    const pts = upto.filter((p) => (Date.parse(p.time) || 0) >= winLo);
    if (pts.length < 2) continue;
    out.push(Object.assign({}, t, { points: pts, firstSeen: pts[0].time, lastSeen: pts[pts.length - 1].time, ended: t.ended && pts.length === upto.length }));
  }
  return out;
}

function matchesFilter(s) { switch (state.filter) { case 'danger': return statusInfo(s).level >= 3; case 'inbound': return s.status === 'approaching' || s.status === 'overhead'; case 'cleared': return s.status === 'all_clear' || s.status === 'shot_down'; case 'drone': return s.threatType === 'drone'; case 'aircraft': return s.threatType === 'aircraft'; case 'missile': return ['missile','cruise_missile','ballistic_missile'].includes(s.threatType); default: return true; } }
function trackMatchesFilter(t) { if (state.filter === 'drone') return t.threatClass === 'drone'; if (state.filter === 'aircraft') return t.threatClass === 'aircraft'; if (state.filter === 'missile') return t.threatClass === 'missile'; return true; }

// ---- glyphs ----
// Long-range strike drone (Shahed-style delta wing), nose up (bearing 0) so it
// can be rotated to face its heading. Pointed nose, swept delta, small canards
// and a spinning pusher-prop line at the tail.
function droneGlyph(cx, cy, color, s) {
  const k = s, dark = '#0a1622';
  const wing = `<polygon points="${cx},${cy-9*k} ${cx+7*k},${cy+5.6*k} ${cx},${cy+2.6*k} ${cx-7*k},${cy+5.6*k}" fill="${color}" stroke="${dark}" stroke-width="${0.8*k}" stroke-linejoin="round"/>`;
  const spine = `<line x1="${cx}" y1="${cy-9*k}" x2="${cx}" y2="${cy+2.6*k}" stroke="${dark}" stroke-width="${1.2*k}" opacity="0.5"/>`;
  const canard = `<line x1="${cx-3.1*k}" y1="${cy-2.2*k}" x2="${cx+3.1*k}" y2="${cy-2.2*k}" stroke="${dark}" stroke-width="${1*k}" opacity="0.5"/>`;
  const nose = `<circle cx="${cx}" cy="${cy-7.9*k}" r="${1.15*k}" fill="${dark}"/>`;
  const prop = `<line class="rotor" x1="${cx-2.7*k}" y1="${cy+3.6*k}" x2="${cx+2.7*k}" y2="${cy+3.6*k}" stroke="${color}" stroke-width="${1.1*k}" stroke-linecap="round"/>`;
  return wing + spine + canard + nose + prop;
}
// Formation offsets (local frame, nose up) for count → up to 3 drone glyphs.
function droneFormation(n) {
  if (n <= 1) return [[0, 0]];
  if (n === 2) return [[-5.5, 2.5], [5.5, 2.5]];
  return [[0, -5.5], [-6.5, 4], [6.5, 4]]; // lead + two wingmen
}
// Sleek rocket: pointed nose-cone, slim body, swept tail fins and a warm
// exhaust flame at the base. Nose up so it rotates to face its heading.
function missileGlyph(cx, cy, color, s) {
  const k = s, dark = '#0a1622';
  const flame = `<polygon points="${cx},${cy+8.6*k} ${cx-1.7*k},${cy+5*k} ${cx+1.7*k},${cy+5*k}" fill="#ffb648"/>`;
  const body = `<path d="M ${cx} ${cy-9*k} Q ${cx+2.5*k} ${cy-5.5*k} ${cx+2.3*k} ${cy+1.5*k} L ${cx+2.3*k} ${cy+5*k} L ${cx-2.3*k} ${cy+5*k} L ${cx-2.3*k} ${cy+1.5*k} Q ${cx-2.5*k} ${cy-5.5*k} ${cx} ${cy-9*k} Z" fill="${color}" stroke="${dark}" stroke-width="${0.7*k}" stroke-linejoin="round"/>`;
  const finL = `<polygon points="${cx-2.3*k},${cy+1*k} ${cx-5.2*k},${cy+6*k} ${cx-2.3*k},${cy+5*k}" fill="${color}"/>`;
  const finR = `<polygon points="${cx+2.3*k},${cy+1*k} ${cx+5.2*k},${cy+6*k} ${cx+2.3*k},${cy+5*k}" fill="${color}"/>`;
  const port = `<circle cx="${cx}" cy="${cy-3.2*k}" r="${1.05*k}" fill="${dark}"/>`;
  return flame + finL + finR + body + port;
}
function genericGlyph(cx, cy, color, sym, s) { const r = 7.5 * s; return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0d1b2a" stroke="${color}" stroke-width="${2*s}"/><text x="${cx}" y="${cy+3.6*s}" text-anchor="middle" font-family="Arial" font-size="${10.5*s}" font-weight="bold" fill="${color}">${sym}</text>`; }
function clearGlyph(cx, cy, color, s) { const r = 7.5 * s; return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0d1b2a" stroke="${color}" stroke-width="${2*s}"/><path d="M${cx-3.6*s},${cy+0.3*s} L${cx-1*s},${cy+3*s} L${cx+3.8*s},${cy-3*s}" fill="none" stroke="${color}" stroke-width="${2*s}" stroke-linecap="round" stroke-linejoin="round"/>`; }
// Swept-wing jet: an arrowhead body with two back-swept wings.
function jetGlyph(cx, cy, color, s) {
  const k = s;
  return `<polygon points="${cx},${cy-8*k} ${cx-1.6*k},${cy+5*k} ${cx+1.6*k},${cy+5*k}" fill="${color}"/>` +
    `<polygon points="${cx},${cy-1*k} ${cx-7*k},${cy+5*k} ${cx-1.4*k},${cy+3*k}" fill="${color}"/>` +
    `<polygon points="${cx},${cy-1*k} ${cx+7*k},${cy+5*k} ${cx+1.4*k},${cy+3*k}" fill="${color}"/>` +
    `<polygon points="${cx},${cy+3*k} ${cx-3*k},${cy+7*k} ${cx+3*k},${cy+7*k}" fill="${color}"/>`;
}
function threatGlyph(type, cx, cy, color, s) { if (type === 'drone') return droneGlyph(cx, cy, color, s); if (type === 'aircraft') return jetGlyph(cx, cy, color, s); if (['missile','cruise_missile','ballistic_missile'].includes(type)) return missileGlyph(cx, cy, color, s); return genericGlyph(cx, cy, color, (THREAT[type] || THREAT.unknown).sym, s); }
const ORIENTABLE = new Set(['drone', 'aircraft', 'missile', 'cruise_missile', 'ballistic_missile']);
function buildIcon(s) {
  const info = statusInfo(s), color = info.color;
  const isWarn = info.warn, isDanger = info.level >= 3, count = Math.max(1, s.count || 1);
  // Danger markers are noticeably bigger so warnings pop out at a glance.
  const scale = isDanger ? 1.45 : isWarn ? 1.2 : 1.05;
  const isClear = s.status === 'all_clear';
  const brg = isClear ? null : resolveBearing(s);
  const orient = brg !== null && ORIENTABLE.has(s.threatType);
  // A count of drones is shown as an actual formation of up to 3 drone glyphs,
  // not one icon with a number — plus the exact ×N badge for the true total.
  const isDrone = s.threatType === 'drone';
  const nGlyph = isDrone ? Math.min(count, 3) : 1;
  const offs = droneFormation(nGlyph);
  const gscale = scale * (nGlyph > 1 ? 0.82 : 1);
  const maxOff = Math.max(0, ...offs.map(([x, y]) => Math.hypot(x, y)));
  const gExtent = (maxOff + 8.5) * scale;                 // covers glyph(s) at any rotation
  const pulseR = gExtent * 0.8;
  const ringExtent = isDanger ? gExtent + 8 : gExtent + 2;
  const showCount = count > 1, label = '×' + count;
  const labelW = showCount ? label.length * 7 + 12 : 0, gap = 4, m = 4;
  const leftExt = ringExtent, topExt = ringExtent, botExt = ringExtent;
  const rightExt = Math.max(ringExtent, gExtent + gap + labelW);
  const Gx = leftExt + m, Gy = topExt + m;
  const W = Math.ceil(leftExt + rightExt + 2 * m), H = Math.ceil(topExt + botExt + 2 * m);

  let glyphs = '';
  if (isClear) glyphs = clearGlyph(Gx, Gy, color, scale);
  else for (const [dx, dy] of offs) glyphs += threatGlyph(s.threatType, Gx + dx * scale, Gy + dy * scale, color, gscale);
  const oriented = orient ? `<g transform="rotate(${brg.toFixed(1)} ${Gx} ${Gy})">${glyphs}</g>` : glyphs;

  const pulse = isWarn ? `<circle class="pulse" cx="${Gx}" cy="${Gy}" r="${pulseR}" fill="${color}"/>` : '';
  // Danger: a bright solid ring + a big expanding alert halo so it's unmissable.
  const ring = isDanger
    ? `<circle cx="${Gx}" cy="${Gy}" r="${gExtent + 2}" fill="none" stroke="${color}" stroke-width="2" opacity="0.9"/>` +
      `<circle class="pulse-alert" cx="${Gx}" cy="${Gy}" r="${gExtent + 4}" fill="none" stroke="${color}" stroke-width="2.5" opacity="0.9"/>`
    : '';
  let badge = '';
  if (showCount) { const bx = Gx + gExtent + gap; badge = `<rect x="${bx}" y="${Gy-9}" width="${labelW}" height="18" rx="9" fill="#0d1b2a" stroke="${color}" stroke-width="1.5"/><text x="${bx+labelW/2}" y="${Gy+4}" text-anchor="middle" font-family="Arial" font-size="12.5" font-weight="bold" fill="${color}">${label}</text>`; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${ring}${pulse}${oriented}${badge}</svg>`;

  // Moving objects gently drift along their heading, so a glance shows which way
  // each one is going (paired with the nose-forward orientation above).
  const moving = orient && (s.status === 'approaching' || s.status === 'overhead');
  if (moving) {
    const rad = brg * Math.PI / 180, A = 3.2;
    const mx = (Math.sin(rad) * A).toFixed(1), my = (-Math.cos(rad) * A).toFixed(1);
    const html = `<div class="mvwrap" style="--mx:${mx}px;--my:${my}px">${svg}</div>`;
    return L.divIcon({ className: 'threat-icon moving', html, iconSize: [W, H], iconAnchor: [Gx, Gy], popupAnchor: [0, -(topExt + 2)] });
  }
  return L.divIcon({ className: 'threat-icon', html: svg, iconSize: [W, H], iconAnchor: [Gx, Gy], popupAnchor: [0, -(topExt + 2)] });
}
// Small chevron at the track head — a subtle direction pip, not a big arrow.
function arrowheadIcon(bearing, color) { const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><g transform="rotate(${bearing} 7 7)"><polygon points="7,1.5 3.2,10 7,7.6 10.8,10" fill="${color}" stroke="#0a1622" stroke-width="0.8"/></g></svg>`; return L.divIcon({ className: 'arrow-icon', html: svg, iconSize: [14, 14], iconAnchor: [7, 7] }); }

// ---- hatched affected-region zones ----
// Warnings shade the whole area under threat as a diagonally-hatched patch (like
// an air-raid alert map) so the affected region is discernible at a glance, not
// just a point. Rendered as an SVG overlay so the hatch pattern survives even
// though the vector layers draw to canvas.
let hatchUid = 0;
function svgFromString(str) { const d = document.createElement('div'); d.innerHTML = str.trim(); return d.querySelector('svg'); }
function drawHatchEllipse(lat, lon, rk, color, level) {
  const dLat = rk / 111, dLon = rk / (111 * Math.cos(lat * Math.PI / 180));
  const bounds = L.latLngBounds([lat - dLat, lon - dLon], [lat + dLat, lon + dLon]);
  const uid = 'hz' + (hatchUid++), fillOp = level >= 3 ? 0.5 : 0.32, gap = level >= 3 ? 6 : 8;
  const svg = svgFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">` +
    `<defs><pattern id="${uid}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line x1="0" y1="0" x2="0" y2="${gap}" stroke="${color}" stroke-width="2.3"/></pattern></defs>` +
    `<ellipse cx="50" cy="50" rx="48" ry="48" fill="url(#${uid})" fill-opacity="${fillOp}" ` +
    `stroke="${color}" stroke-opacity="0.8" stroke-width="1.3" stroke-dasharray="5 4"/></svg>`);
  L.svgOverlay(svg, bounds, { interactive: false, className: 'zone-hatch' }).addTo(zonesLayer);
}
// Group nearby warnings (same oblast, or within ~110 km) into one blob so a
// cluster of alerts reads as a single region-area warning, not a pile of rings.
function clusterWarns(warns) {
  const TH = 110, cl = [];
  for (const s of warns.slice().sort((a, b) => statusInfo(b).level - statusInfo(a).level)) {
    const rk = normPlace(s.region || '');
    let c = cl.find((c) => (rk && c.rk === rk) || haversineKm(c.lat, c.lon, s.lat, s.lon) <= TH);
    if (!c) { c = { lat: s.lat, lon: s.lon, rk, pts: [], level: 0, color: '#ff7a3d', worst: s }; cl.push(c); }
    c.pts.push(s);
    c.lat = c.pts.reduce((a, p) => a + p.lat, 0) / c.pts.length;
    c.lon = c.pts.reduce((a, p) => a + p.lon, 0) / c.pts.length;
    const info = statusInfo(s);
    if (info.level > c.level) { c.level = info.level; c.color = info.color; c.worst = s; }
  }
  return cl;
}
function addClusterZone(c) {
  const anyRegion = c.pts.some((p) => p.geocodePrecision === 'region');
  let maxd = 0; for (const p of c.pts) maxd = Math.max(maxd, haversineKm(c.lat, c.lon, p.lat, p.lon));
  let rk;
  if (c.pts.length === 1) rk = c.pts[0].geocodePrecision === 'region' ? 62 : c.level >= 3 ? 30 : 22;
  else rk = Math.max(anyRegion ? 62 : 44, maxd + 24);   // enclose the whole cluster
  drawHatchEllipse(c.lat, c.lon, rk, c.color, c.level);
  if (c.level >= 3) L.circleMarker([c.worst.lat, c.worst.lon], { radius: 4, color: c.color, fillColor: c.color, fillOpacity: 0.95, weight: 1, opacity: 0.9 }).addTo(zonesLayer);
}

// ---- airbase reference layer ----
// Known military airfields near the theatre. A reference layer so it's easy to
// see which strikes/overflights sit near a base. (name, lat, lon)
const AIRBASES = [
  { name: 'Engels-2', lat: 51.480, lon: 46.194 }, { name: 'Morozovsk', lat: 48.309, lon: 41.790 },
  { name: 'Millerovo', lat: 48.949, lon: 40.300 }, { name: 'Kushchyovskaya', lat: 46.546, lon: 39.605 },
  { name: 'Primorsko-Akhtarsk', lat: 46.051, lon: 38.150 }, { name: 'Yeysk', lat: 46.680, lon: 38.211 },
  { name: 'Krymsk', lat: 44.962, lon: 37.990 }, { name: 'Marinovka', lat: 48.640, lon: 44.060 },
  { name: 'Baltimor (Voronezh)', lat: 51.622, lon: 39.180 }, { name: 'Buturlinovka', lat: 50.792, lon: 40.598 },
  { name: 'Taganrog-Tsentralny', lat: 47.198, lon: 38.849 }, { name: 'Rostov-on-Don', lat: 47.258, lon: 39.818 },
  { name: 'Shaykovka', lat: 54.232, lon: 34.370 }, { name: 'Dyagilevo (Ryazan)', lat: 54.643, lon: 39.580 },
  { name: 'Savasleyka', lat: 55.459, lon: 42.330 }, { name: 'Akhtubinsk', lat: 48.306, lon: 46.240 },
  { name: 'Borisoglebsk', lat: 51.366, lon: 42.090 }, { name: 'Voronezh-Baltimor', lat: 51.620, lon: 39.220 },
  { name: 'Saky (Novofedorivka)', lat: 45.093, lon: 33.599 }, { name: 'Belbek', lat: 44.691, lon: 33.573 },
  { name: 'Gvardeyskoye', lat: 45.111, lon: 33.977 }, { name: 'Dzhankoi', lat: 45.708, lon: 34.418 },
  { name: 'Kacha', lat: 44.775, lon: 33.586 },
];
function airbaseIcon() {
  const c = '#93b7d8', dark = '#0b1826';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
    `<circle cx="11" cy="11" r="9" fill="${dark}" stroke="${c}" stroke-width="1.5" opacity="0.96"/>` +
    jetGlyph(11, 12, c, 0.86) + `</svg>`;
  return L.divIcon({ className: 'base-icon', html: svg, iconSize: [22, 22], iconAnchor: [11, 11] });
}
function renderBases() {
  basesLayer.clearLayers();
  const showLabels = map.getZoom() >= 7;
  for (const b of AIRBASES) {
    L.marker([b.lat, b.lon], { icon: airbaseIcon(), keyboard: false, zIndexOffset: -600 })
      .bindTooltip(`✈ ${esc(b.name)} airbase`, { direction: 'top', className: 'base-tip', offset: [0, -8] })
      .addTo(basesLayer);
    if (showLabels) L.tooltip({ permanent: true, direction: 'right', className: 'base-label', offset: [11, 0], interactive: false })
      .setContent(esc(b.name)).setLatLng([b.lat, b.lon]).addTo(basesLayer);
  }
}

function popupHtml(s) {
  const t = THREAT[s.threatType] || THREAT.unknown, info = statusInfo(s);
  const bits = [t.label]; if (s.count) bits.push('×' + s.count); if (s.region) bits.push(s.region);
  const bearing = resolveBearing(s), destName = s.destination || extractDestFromHeading(s.heading);
  let going = destName ? `<div class="popup-dest">➤ Heading toward ${esc(destName)}</div>` : (bearing !== null ? `<div class="popup-dest">➤ Heading ${esc(s.heading || bearingWord(bearing))}</div>` : '');
  const statusLine = `<div class="popup-status" style="color:${info.color}">● ${esc(info.label)}${info.level >= 3 ? ' — warning' : ''}</div>`;
  const n = s.sources ? s.sources.length : (s.channel ? 1 : 0);
  const confirm = n >= 2 ? `<div class="popup-confirm">✓ Confirmed by ${n} sources</div>` : '';
  const acc = [];
  if (s.reports > 1) acc.push(esc(`${s.reports} reports`));
  acc.push(esc(s.geocodePrecision === 'region' ? 'region-level (approx.)' : 'pinpoint'));
  if (typeof s.confidence === 'number') acc.push(esc(`${Math.round(s.confidence * 100)}% conf.`));
  const chans = s.sources && s.sources.length ? s.sources : (s.channel ? [s.channel] : []);
  if (chans.length) acc.push(chans.map(channelTag).join(' '));
  const utc = fmtUTC(s.timestamp); if (utc) acc.push(esc(utc));
  const post = s.postText ? `<div class="popup-text" data-orig>${esc(s.postText)}</div>` +
    `<div class="popup-tr" style="display:none"></div>` +
    `<a class="popup-trlink" href="#">🌐 Translate</a>` : '';
  return `<div class="popup-title">${esc(s.location)}</div>${statusLine}${confirm}<div class="popup-meta">${esc(bits.join(' · '))} · ${fmtTime(s.timestamp)}</div>${going}<div class="popup-acc">${acc.join(' · ')}</div>${post}${s.postLink ? `<div class="popup-link"><a href="${esc(s.postLink)}" target="_blank" rel="noopener">Open in Telegram ↗</a></div>` : ''}`;
}

// ---- translation (on-demand, cached; server calls the local Ollama model) ----
const _trCache = new Map();
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
// Returns the English translation, or throws on failure/timeout so the caller
// can show an explicit state instead of silently doing nothing.
async function translateText(text) {
  if (_trCache.has(text)) return _trCache.get(text);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const t = norm(d.translation);
    if (!t) throw new Error('empty translation');
    _trCache.set(text, t);
    return t;
  } finally { clearTimeout(to); }
}
// Wire the Translate link (and auto-run it when the toggle is on) each time a popup opens.
function wirePopupTranslate(popup) {
  const node = popup && popup._contentNode;
  const s = popup && popup._source && popup._source._s;
  if (!node || !s || !s.postText) return;
  const link = node.querySelector('.popup-trlink');
  const trDiv = node.querySelector('.popup-tr');
  const orig = node.querySelector('[data-orig]');
  if (!link || !trDiv || !orig) return;
  const hasCyrillic = /[Ѐ-ӿ]/.test(s.postText);
  const showTranslation = async () => {
    if (link.dataset.done !== '1') {
      link.textContent = '🌐 Translating…';
      try {
        const t = await translateText(s.postText);
        if (hasCyrillic && norm(t) === norm(s.postText)) {
          // Model echoed the source untouched → almost certainly no chat model
          // is available to translate. Say so instead of showing the same text.
          trDiv.innerHTML = `<span class="tr-warn">No translation available — start Ollama with a chat model (e.g. <b>ollama run gemma3:12b</b>).</span>`;
        } else {
          trDiv.textContent = t;
        }
      } catch {
        trDiv.innerHTML = `<span class="tr-warn">Translation unavailable — is Ollama running? Check the model in the header.</span>`;
      }
      link.dataset.done = '1';
    }
    trDiv.style.display = 'block';
    orig.style.display = 'none';
    link.textContent = '🌐 Show original';
    link.dataset.shown = '1';
  };
  const showOriginal = () => {
    trDiv.style.display = 'none';
    orig.style.display = 'block';
    link.textContent = '🌐 Translate';
    link.dataset.shown = '';
  };
  link.onclick = (e) => { e.preventDefault(); (link.dataset.shown === '1') ? showOriginal() : showTranslation(); };
  if (state.autoTranslate) showTranslation();
}

// ---- map ----
const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([54.5, 42.0], 5);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, crossOrigin: 'anonymous', attribution: '© OpenStreetMap © CARTO' }).addTo(map);
const tracksLayer = L.layerGroup().addTo(map), zonesLayer = L.layerGroup().addTo(map), basesLayer = L.layerGroup().addTo(map), markersLayer = L.layerGroup().addTo(map), labelsLayer = L.layerGroup().addTo(map);
const LAYER_GROUPS = { tracks: tracksLayer, zones: zonesLayer, bases: basesLayer, labels: labelsLayer };
function applyLayerToggles() { for (const [k, g] of Object.entries(LAYER_GROUPS)) { if (state.layers[k]) { if (!map.hasLayer(g)) map.addLayer(g); } else if (map.hasLayer(g)) map.removeLayer(g); } document.getElementById('clock').style.display = state.layers.clock ? 'block' : 'none'; document.querySelectorAll('#layerBar .chip[data-layer]').forEach((b) => b.classList.toggle('active', !!state.layers[b.dataset.layer])); }
map.on('popupopen', (e) => wirePopupTranslate(e.popup));
map.on('zoomend', () => { if (state.layers.bases) renderBases(); });

function currentAsOf() { return state.timeline.live ? Date.now() : state.timeline.asOf; }
function renderAll() {
  const asOf = currentAsOf();
  const sightings = sightingsAsOf(asOf);
  const tracks = tracksAsOf(asOf).filter(trackMatchesFilter);
  renderTracks(tracks);
  renderMarkers(sightings, tracks);
  renderBases();
  renderWarnings(sightings);
  updateHeader(sightings);
  updateClock();
}

// Ages a status colour toward transparent by how long ago it was reported, so
// stale positions visibly recede — freshness is a first-class signal.
function ageOpacity(ageMin) { return ageMin <= 8 ? 1 : Math.max(0.4, 1 - (ageMin - 8) / 90); }

function renderMarkers(sightings, tracks) {
  zonesLayer.clearLayers(); markersLayer.clearLayers(); labelsLayer.clearLayers();
  state.movers = [];
  const asOf = currentAsOf(), toShow = sightings.filter(matchesFilter), pts = [];
  // A track already draws a trailing tail from the object's last known location,
  // so DON'T also drop a full marker on every past waypoint — that is what made
  // it look like separate drones wired together. Suppress markers that sit on a
  // track's tail (everything except its head); the head keeps its icon.
  const tailPts = [];
  if (state.layers.tracks) for (const t of tracks) { const p = t.points; for (let i = 0; i < p.length - 1; i++) tailPts.push(p[i]); }
  const onTail = (s) => tailPts.some((p) => haversineKm(s.lat, s.lon, p.lat, p.lon) < 2.5);
  const visible = toShow.filter((s) => !onTail(s));

  // ZONES: cluster nearby warnings into one region-area warning; lesser
  // region-level reports get a faint dashed footprint.
  for (const c of clusterWarns(visible.filter((s) => statusInfo(s).warn))) addClusterZone(c);
  for (const s of visible) if (!statusInfo(s).warn && s.geocodePrecision === 'region')
    L.circle([s.lat, s.lon], { radius: 30000, color: '#6f93b4', weight: 1, opacity: 0.25, fill: false, dashArray: '3 6' }).addTo(zonesLayer);

  // MARKERS
  for (const s of visible) {
    const info = statusInfo(s), color = info.color;
    const ageMin = (asOf - (Date.parse(s.timestamp || '') || asOf)) / 60000, opacity = ageOpacity(ageMin);
    const mk = L.marker([s.lat, s.lon], { icon: buildIcon(s), opacity, zIndexOffset: info.level * 100 }).bindPopup(popupHtml(s), { maxWidth: 300 }).addTo(markersLayer);
    mk._s = s; // let the popup-open handler reach this sighting for translation
    pts.push([s.lat, s.lon]);
    const label = L.tooltip({ permanent: true, direction: 'bottom', className: 'place-label', offset: [0, 14], interactive: false }).setContent(`<span style="color:${color}">${esc(s.location)}</span>`).setLatLng([s.lat, s.lon]).addTo(labelsLayer);
    // A drone with a known heading/destination slowly creeps that way from its
    // last known spot (dead reckoning), so the map shows it advancing live.
    if (state.timeline.live) registerMover(s, mk, label, asOf);
  }
  if (!state.hasAutoZoomed && pts.length) { const ap = toShow.filter((s) => statusInfo(s).warn).map((s) => [s.lat, s.lon]); map.fitBounds(ap.length ? ap : pts, { padding: [80, 80], maxZoom: 9 }); state.hasAutoZoomed = true; }
}

// ---- moving drones: dead-reckon toward the destination between updates ----
const DRONE_KMH = 160;            // nominal Shahed cruise
function registerMover(s, marker, label, asOf) {
  if (s.threatType !== 'drone') return;
  if (s.status !== 'approaching' && s.status !== 'overhead') return;
  const brg = resolveBearing(s);
  if (brg === null) return;
  const dest = confidentDest(s);
  const maxKm = dest ? haversineKm(s.lat, s.lon, dest.lat, dest.lon) : 120;
  if (maxKm < 3) return;
  state.movers.push({ marker, label, fromLat: s.lat, fromLon: s.lon, brg,
    destLat: dest ? dest.lat : null, destLon: dest ? dest.lon : null, maxKm, postT: Date.parse(s.timestamp || '') || asOf });
}
function animateMovers() {
  const movers = state.movers || [];
  if (movers.length && state.timeline.live && !state.recording) {
    const now = Date.now();
    for (const m of movers) {
      const dist = Math.min(m.maxKm, DRONE_KMH * Math.max(0, (now - m.postT) / 3600000));
      if (dist < 0.2) continue;
      const [la, lo] = projectPoint(m.fromLat, m.fromLon, m.brg, dist);
      m.marker.setLatLng([la, lo]);
      if (m.label) m.label.setLatLng([la, lo]);
    }
  }
  requestAnimationFrame(animateMovers);
}
requestAnimationFrame(animateMovers);
function kindOf(cls) { return cls === 'missile' ? 'Missile' : cls === 'aircraft' ? 'Aircraft' : 'Drone'; }
function trackTooltip(t) {
  const from = t.points[0], to = t.points[t.points.length - 1];
  const span = `${fmtUTC(t.firstSeen).replace(' UTC','')} → ${fmtUTC(t.lastSeen)}`;
  const spd = typeof t.speedKmh === 'number' ? ` · ${t.speedKmh} km/h` : '';
  return `<b>${esc(t.code || kindOf(t.threatClass) + ' track')}</b> · ${kindOf(t.threatClass)}${spd}<br>` +
    `${t.points.length} waypoints · ~${t.distanceKm} km<br>${esc(from.location || '?')} → ${esc(to.location || '?')}` +
    `${t.ended ? ' · <b style="color:#4fb6ff">ended</b>' : ''}<br><span style="color:#8ab0d0">${span}</span>`;
}
// Radar-style head label: object id + speed + how long since last reported.
function trackHeadLabel(t, color, ageMin) {
  const spd = typeof t.speedKmh === 'number' ? `${t.speedKmh} km/h` : '';
  const age = ageMin < 1 ? 'now' : ageMin < 60 ? `${Math.round(ageMin)}m ago` : `${Math.round(ageMin / 60)}h ago`;
  const sub = [spd, age].filter(Boolean).join(' · ');
  return L.divIcon({ className: 'trk-label', iconSize: null, iconAnchor: [-8, -6],
    html: `<div class="tl-id" style="color:${color}">${esc(t.code || '')}</div>${sub ? `<div class="tl-spd">${esc(sub)}</div>` : ''}` });
}
// A track is drawn as a comet TAIL trailing the object's last known location —
// brightest at the head, fading to nothing behind it — never a bright line
// wiring separate markers together. Older tracks fade as a whole (freshness).
function renderTracks(tracks) {
  tracksLayer.clearLayers();
  const asOf = currentAsOf();
  for (const t of tracks) {
    if (!trackMatchesFilter(t)) continue;
    const pts = t.points.slice(-TRAIL_POINTS);
    if (pts.length < 2) continue;
    const ll = pts.map((p) => [p.lat, p.lon]);
    const color = TRACK_COLORS[t.threatClass] || TRACK_COLORS.other;
    const ageMin = Math.max(0, (asOf - (Date.parse(pts[pts.length - 1].time) || asOf)) / 60000);
    const headAlpha = Math.max(0.28, 1 - ageMin / 75); // whole tail dims with age
    const n = ll.length;

    // Invisible fat hit-line for the hover tooltip (whole path).
    L.polyline(ll, { color, weight: 10, opacity: 0, interactive: true }).addTo(tracksLayer)
      .bindTooltip(trackTooltip(t), { sticky: true, className: 'trk-tip', opacity: 1 });

    // Comet tail: transparent at the oldest end, bright at the head. A soft glow
    // underlay only near the head sells the "trail behind it" look.
    for (let i = 1; i < n; i++) {
      const frac = i / (n - 1);                 // 0 = tail, 1 = head
      const op = headAlpha * (0.05 + 0.75 * frac * frac);
      L.polyline([ll[i - 1], ll[i]], { color, weight: 1 + 3 * frac, opacity: op, lineCap: 'round', interactive: false }).addTo(tracksLayer);
      if (frac > 0.55) L.polyline([ll[i - 1], ll[i]], { color, weight: 5 + 4 * frac, opacity: op * 0.18, lineCap: 'round', interactive: false }).addTo(tracksLayer);
    }

    // Arrowhead + id/speed/age label at the current head (last known location).
    const a = ll[n - 2], b = ll[n - 1], brg = bearingTo(a[0], a[1], b[0], b[1]);
    L.marker(b, { icon: arrowheadIcon(brg, color), interactive: false, keyboard: false, opacity: Math.min(1, headAlpha + 0.15) }).addTo(tracksLayer);
    if (t.code) L.marker(b, { icon: trackHeadLabel(t, color, ageMin), interactive: false, keyboard: false, opacity: Math.min(1, headAlpha + 0.2) }).addTo(tracksLayer);
  }
}
const TCLASS_ICON = { drone: '✈', aircraft: '🛩', missile: '▲' };
function renderWarnings(sightings) {
  const panel = document.getElementById('warnPanel'), list = document.getElementById('warnList'), title = document.getElementById('warnTitle');
  const warns = sightings.filter((s) => statusInfo(s).warn);
  if (!warns.length) { panel.style.display = 'none'; return; }
  // Group active warnings by region; track the worst status, spot count, total
  // objects, source channels and freshness so each row is accurate + rich.
  const groups = new Map();
  for (const s of warns) {
    const key = s.region || s.location || '—', info = statusInfo(s);
    let g = groups.get(key);
    if (!g) { g = { key, level: 0, spots: 0, latest: 0, latlng: [s.lat, s.lon], label: info.label, color: info.color, count: 0, sources: new Set(), classes: new Set(), place: s.location }; groups.set(key, g); }
    g.spots++;
    if (typeof s.count === 'number') g.count += s.count;
    (s.sources || (s.channel ? [s.channel] : [])).forEach((c) => g.sources.add(c));
    g.classes.add(s.threatType === 'aircraft' ? 'aircraft' : ['missile','cruise_missile','ballistic_missile'].includes(s.threatType) ? 'missile' : 'drone');
    const t = Date.parse(s.timestamp || '') || 0; if (t > g.latest) g.latest = t;
    if (info.level > g.level) { g.level = info.level; g.label = info.label; g.color = info.color; g.latlng = [s.lat, s.lon]; g.place = s.location; }
  }
  const arr = [...groups.values()].sort((a, b) => b.level - a.level || b.latest - a.latest).slice(0, 16);
  const danger = arr.some((g) => g.level >= 3);
  const dangerCount = arr.filter((g) => g.level >= 3).length;
  panel.className = 'warn-panel' + (danger ? ' danger' : '');
  panel.style.display = 'block';
  title.innerHTML = `Active warnings <b>${groups.size}</b>` + (dangerCount ? ` · <span style="color:#ff5c5c">${dangerCount} danger</span>` : '');
  list.innerHTML = '';
  for (const g of arr) {
    const ago = g.latest ? fmtTime(new Date(g.latest).toISOString()) : '';
    const icons = [...g.classes].map((c) => TCLASS_ICON[c] || '').join('');
    const bits = [];
    if (g.count > 0) bits.push(`${icons} ×${g.count}`);
    else if (icons) bits.push(icons);
    if (g.spots > 1) bits.push(`${g.spots} spots`);
    if (g.sources.size >= 2) bits.push(`✓ ${g.sources.size} src`);
    if (ago) bits.push(ago);
    const row = document.createElement('div');
    row.className = 'warn-item';
    row.style.setProperty('--sev', g.color);
    row.innerHTML =
      `<div class="warn-body">` +
        `<div class="warn-top"><span class="warn-region">${esc(g.key)}</span>` +
        `<span class="warn-pill" style="color:${g.color};border-color:${g.color}66;background:${g.color}1f">${esc(g.label)}</span></div>` +
        `<div class="warn-meta">${bits.map(esc).join(' · ')}</div>` +
      `</div>`;
    row.addEventListener('click', () => { if (typeof g.latlng[0] === 'number') map.flyTo(g.latlng, Math.max(map.getZoom(), 8), { duration: 0.6 }); });
    list.appendChild(row);
  }
}
function updateHeader(sightings) {
  const active = sightings.filter((s) => s.status !== 'all_clear');
  const danger = active.filter((s) => statusInfo(s).level >= 3).length;
  const inbound = active.filter((s) => s.status === 'approaching').length;
  const overhead = active.filter((s) => s.status === 'overhead').length;
  const intercepted = active.filter((s) => s.status === 'shot_down').length;
  const cleared = sightings.filter((s) => s.status === 'all_clear').length;
  const lvl = danger >= 3 ? 'CRITICAL' : danger >= 1 ? 'HIGH' : (inbound + overhead) >= 2 ? 'ELEVATED' : (inbound + overhead) >= 1 ? 'MODERATE' : active.length ? 'LOW' : 'CLEAR';
  const col = danger >= 3 ? '#ff2d2d' : danger >= 1 ? '#ff5c5c' : (inbound + overhead) >= 2 ? '#ff7a3d' : (inbound + overhead) >= 1 ? '#ffb03d' : active.length ? '#9ab4d0' : '#3fd87f';
  const pill = (color, n, title) => n ? `<span class="pill" title="${title}"><span class="pdot" style="background:${color}"></span>${n}</span>` : '';
  const lvlPill = `<span class="pill lvl" style="color:${col};border-color:${col}55;background:${col}18">${lvl}</span>`;
  document.getElementById('stats').innerHTML = lvlPill +
    pill('#ff3b3b', danger, 'Danger') + pill('#ff7a3d', inbound, 'Inbound') +
    pill('#ffb03d', overhead, 'Overhead') + pill('#4fb6ff', intercepted, 'Intercepted') +
    pill('#3fd87f', cleared, 'All clear');
}
function updateClock() {
  const d = new Date(currentAsOf()), p = (n) => String(n).padStart(2, '0');
  document.getElementById('clockDate').textContent = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  document.getElementById('clockTime').textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const zone = document.getElementById('clockZone'), clock = document.getElementById('clock');
  if (state.timeline.live) { zone.textContent = 'UTC · LIVE'; clock.classList.remove('replay'); } else { zone.textContent = 'UTC · REPLAY'; clock.classList.add('replay'); }
}
setInterval(() => { if (state.timeline.live) updateClock(); }, 1000);

// ---- timeline ----
function historyBounds() { const times = state.sightings.map((s) => Date.parse(s.timestamp || '') || 0).filter(Boolean); const now = Date.now(); const min = times.length ? Math.min(...times) : now - 48 * 3600 * 1000; return { min, max: now }; }
function sliderToTime(v) { const { min, max } = historyBounds(); return min + (max - min) * (v / 1000); }
function timeToSlider(t) { const { min, max } = historyBounds(); return max <= min ? 1000 : Math.round(((t - min) / (max - min)) * 1000); }
function paintSlider(v) {
  const pct = Math.max(0, Math.min(100, v / 10));
  const el = document.getElementById('tlSlider');
  el.style.background = `linear-gradient(90deg, #5ad1ff 0%, #5ad1ff ${pct}%, #3a6f92 ${pct}%, #142a40 ${pct}%)`;
}
function setTimelineTime(asOf, fromSlider) {
  const { max } = historyBounds();
  state.timeline.live = asOf >= max - 1000; state.timeline.asOf = Math.min(asOf, max);
  const tlTime = document.getElementById('tlTime');
  if (state.timeline.live) { tlTime.textContent = 'LIVE'; tlTime.classList.remove('replay'); } else { tlTime.textContent = fmtUTC(state.timeline.asOf); tlTime.classList.add('replay'); }
  document.getElementById('tlLive').classList.toggle('active', state.timeline.live);
  const sliderVal = fromSlider ? +document.getElementById('tlSlider').value : timeToSlider(state.timeline.asOf);
  if (!fromSlider) document.getElementById('tlSlider').value = sliderVal;
  paintSlider(sliderVal);
  renderAll();
}
function goLive() { stopReplay(); state.timeline.live = true; document.getElementById('tlSlider').value = 1000; setTimelineTime(Date.now()); }
let replayTimer = null;
function startReplay() { if (replayTimer) return; if (state.timeline.live) { const { min } = historyBounds(); state.timeline.asOf = min; state.timeline.live = false; } state.timeline.playing = true; document.getElementById('tlPlay').textContent = '⏸'; let last = Date.now(); replayTimer = setInterval(() => { const nr = Date.now(), dt = (nr - last) / 1000; last = nr; const adv = dt * state.timeline.speed * 1000; const { max } = historyBounds(); let next = state.timeline.asOf + adv; if (next >= max) { setTimelineTime(max); goLive(); return; } setTimelineTime(next); }, 200); }
function stopReplay() { if (replayTimer) { clearInterval(replayTimer); replayTimer = null; } state.timeline.playing = false; document.getElementById('tlPlay').textContent = '▶'; }
function toggleReplay() { if (state.timeline.playing) stopReplay(); else startReplay(); }
document.getElementById('tlSlider').addEventListener('input', (e) => { stopReplay(); setTimelineTime(sliderToTime(+e.target.value), true); });
document.getElementById('tlPlay').addEventListener('click', toggleReplay);
document.getElementById('tlLive').addEventListener('click', goLive);
document.getElementById('tlSpeed').addEventListener('change', (e) => { state.timeline.speed = +e.target.value; });

// ---- chips ----
document.querySelectorAll('#filterBar .chip').forEach((btn) => btn.addEventListener('click', () => { state.filter = btn.dataset.filter; document.querySelectorAll('#filterBar .chip').forEach((b) => b.classList.toggle('active', b === btn)); renderAll(); }));
document.querySelectorAll('#layerBar .chip[data-layer]').forEach((btn) => btn.addEventListener('click', () => { const k = btn.dataset.layer; state.layers[k] = !state.layers[k]; try { localStorage.setItem('ddx-layers', JSON.stringify(state.layers)); } catch {} applyLayerToggles(); }));

// Auto-translate toggle — translate open/opening popups to English.
const translateChip = document.getElementById('translateChip');
if (translateChip) {
  translateChip.classList.toggle('active', state.autoTranslate);
  translateChip.addEventListener('click', () => {
    state.autoTranslate = !state.autoTranslate;
    try { localStorage.setItem('ddx-translate', state.autoTranslate ? '1' : '0'); } catch {}
    translateChip.classList.toggle('active', state.autoTranslate);
    // Apply immediately to any popup that's already open.
    if (state.autoTranslate && map._popup) wirePopupTranslate(map._popup);
  });
}

// ---- area PNG export ----
function regionOf(s) { return s.region || s.location || '—'; }
function populateExportChrome(bounds) {
  const shown = sightingsAsOf(currentAsOf()).filter((s) => typeof s.lat === 'number' && bounds.contains([s.lat, s.lon]));
  const counts = {};
  shown.forEach((s) => { const r = regionOf(s); counts[r] = (counts[r] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const active = shown.filter((s) => s.status !== 'all_clear');
  const warns = shown.filter((s) => statusInfo(s).warn);
  document.getElementById('expMetaTitle').textContent = top ? top[0] : 'Selected area';
  document.getElementById('expMetaSub').textContent = `${fmtUTC(new Date(currentAsOf()))} · ${active.length} active · ${warns.length} warnings`;
}
async function captureToPng(filename) {
  const canvas = await html2canvas(document.body, {
    useCORS: true, backgroundColor: '#0a1622', scale: 2, logging: false, imageTimeout: 15000,
    ignoreElements: (el) => el.classList && (el.classList.contains('no-export') || el.classList.contains('sel-rect') || el.classList.contains('sel-hint')),
    onclone: (doc) => { const st = doc.createElement('style'); st.textContent = '.pulse,.pulse-alert{display:none !important}.threat-icon .rotor{animation:none !important}'; doc.head.appendChild(st); },
  });
  const link = document.createElement('a');
  link.download = filename; link.href = canvas.toDataURL('image/png');
  document.body.appendChild(link); link.click(); link.remove();
}
async function exportArea(bounds) {
  if (typeof html2canvas !== 'function') { alert('Image renderer failed to load.'); return; }
  const btn = document.getElementById('dlBtn'), orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Rendering…';
  map.fitBounds(bounds, { animate: false, paddingTopLeft: [12, 24], paddingBottomRight: [12, 24] });
  populateExportChrome(map.getBounds());
  document.body.classList.add('export-skin');
  try {
    await new Promise((r) => setTimeout(r, 750)); // let tiles settle
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    await captureToPng(`drone-map-${stamp}.png`);
  } catch (err) { alert('Could not render the area: ' + err.message); }
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

// ---- session timelapse video ----
// Replays the map from the earliest data we have up to now, capturing each
// frame with html2canvas onto a canvas that MediaRecorder encodes to WebM.
function videoOverlay(text) {
  const el = document.createElement('div');
  el.className = 'vid-overlay no-export';
  el.innerHTML = `<div class="vlabel">${text}</div><div class="vbar"><div class="vfill"></div></div><div class="vhint">Keep this tab in the foreground.</div>`;
  document.body.appendChild(el);
  return { setPct(p) { el.querySelector('.vfill').style.width = p + '%'; }, setLabel(t) { el.querySelector('.vlabel').textContent = t; }, remove() { el.remove(); } };
}
// Burned-into-frame caption for the video: title, covered time span + a
// progress bar that sweeps as the timelapse plays. Captured (not no-export).
function videoCaption(min, max) {
  const el = document.createElement('div');
  el.className = 'vid-cap';
  el.innerHTML = `<div class="vc-title">The Big Drone Detector · session timelapse</div>` +
    `<div class="vc-span">${esc(fmtUTC(min))} → ${esc(fmtUTC(max))}</div>` +
    `<div class="vc-bar"><div class="vc-fill"></div></div>`;
  document.body.appendChild(el);
  return { setPct(p) { el.querySelector('.vc-fill').style.width = p + '%'; }, remove() { el.remove(); } };
}
function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
async function recordVideo() {
  if (typeof html2canvas !== 'function' || typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
    alert('Video recording is not supported in this browser.'); return;
  }
  const { min, max } = historyBounds();
  if (max - min < 60000) { alert('Not enough history yet — let the app run for a few minutes, then try again.'); return; }
  const btn = document.getElementById('videoBtn'), orig = btn.textContent;
  // Smoother + longer than before: more frames, higher fps + bitrate, easing,
  // and a short hold on the final live frame so the clip ends cleanly.
  const FRAMES = (window.DDX_VIDEO_FRAMES | 0) || 150, FPS = 24, HOLD = 24;
  const W = Math.floor(window.innerWidth), H = Math.floor(window.innerHeight);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const stream = canvas.captureStream(0);
  const vtrack = stream.getVideoTracks()[0];
  let mime = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mime)) mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12000000 });
  const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  state.recording = true; stopReplay();
  btn.disabled = true; btn.textContent = '● REC';
  const ov = videoOverlay('Preparing…');
  const cap = videoCaption(min, max);
  document.body.classList.add('recording');
  rec.start();
  const paint = (shot) => { ctx.fillStyle = '#0a1622'; ctx.fillRect(0, 0, W, H); if (shot) ctx.drawImage(shot, 0, 0, W, H); vtrack.requestFrame(); };
  try {
    for (let i = 0; i <= FRAMES + HOLD; i++) {
      const held = i > FRAMES;
      const frac = held ? 1 : easeInOut(i / FRAMES);   // ease-in-out through history
      cap.setPct(Math.round(frac * 100));
      setTimelineTime(min + (max - min) * frac);
      await new Promise((r) => setTimeout(r, held ? 20 : 110)); // let leaflet + tiles settle
      let shot;
      try {
        shot = await html2canvas(document.body, {
          useCORS: true, backgroundColor: '#0a1622', scale: 1, logging: false, imageTimeout: 8000,
          ignoreElements: (el) => el.classList && (el.classList.contains('no-export') || el.classList.contains('vid-overlay')),
        });
      } catch { shot = null; }
      paint(shot);
      const pct = Math.round((i / (FRAMES + HOLD)) * 100);
      ov.setLabel(`Rendering timelapse… ${pct}%`); ov.setPct(pct);
      await new Promise((r) => setTimeout(r, 1000 / FPS));
    }
  } finally {
    cap.remove();
    rec.stop();
    await stopped;
    document.body.classList.remove('recording');
    state.recording = false;
    ov.remove(); btn.disabled = false; btn.textContent = orig;
    goLive();
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `drone-timelapse-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
}
document.getElementById('videoBtn').addEventListener('click', recordVideo);

// ---- status + data polling ----
function setStatus(st, msg) { const dot = document.getElementById('statusDot'), text = document.getElementById('statusText'); text.textContent = msg || ''; dot.className = 'dot'; if (st === 'error') dot.classList.add('error'); else if (['polling','processing','backfill','starting'].includes(st)) dot.classList.add('busy'); }
function showBackfill(s) {
  const bar = document.getElementById('backfillBar'), label = document.getElementById('backfillLabel'), fill = document.getElementById('backfillFill');
  if (s.state === 'backfill') {
    bar.style.display = 'flex';
    document.body.classList.add('backfilling');
    label.textContent = s.message;
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 8;
    fill.style.width = Math.max(8, s.phase === 'extract' ? pct : 10) + '%';
  } else if (s.phase === 'done' || s.state === 'idle' || s.state === 'polling') {
    fill.style.width = '100%';
    setTimeout(() => { bar.style.display = 'none'; document.body.classList.remove('backfilling'); }, 1500);
  }
}
async function fetchJson(url) { const r = await fetch(url + '?t=' + Date.now()); if (!r.ok) throw new Error(r.status); return r.json(); }
async function refreshData() {
  if (state.recording) return; // don't redraw mid-capture
  try {
    const [sd, td] = await Promise.all([fetchJson('data/sightings.json'), fetchJson('data/tracks.json')]);
    // Only re-render when the data actually changed — lets us poll fast without
    // redrawing (and closing open popups) every few seconds for no reason.
    const stamp = (sd.updatedAt || '') + '|' + (td.updatedAt || '');
    const changed = stamp !== state._stamp;
    state._stamp = stamp;
    state.sightings = sd.sightings || []; state.tracks = td.tracks || [];
    if (sd.backend) document.getElementById('backendLabel').textContent = sd.backend;
    if (state.timeline.live) document.getElementById('tlSlider').value = 1000;
    // Always re-render in replay (the clock is moving); in LIVE only on change.
    if (changed || !state.timeline.live) renderAll();
  } catch { /* keep last good */ }
}
async function refreshStatus() {
  try { const s = await fetchJson('data/status.json'); setStatus(s.state, s.message); showBackfill(s); } catch {}
}

// ---- boot ----
applyLayerToggles();
setTimelineTime(Date.now());
refreshStatus(); refreshData();
setInterval(refreshStatus, 2000);
setInterval(refreshData, 3500);   // pick up new positions within a few seconds
