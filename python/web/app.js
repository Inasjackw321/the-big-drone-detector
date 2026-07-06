'use strict';
/* global L */

// View-only map for the Python app. Reads data/{sightings,tracks,status}.json
// (written by drone_detector.py) and renders the live threat map, flight
// tracks and a history timeline. Polls every few seconds.

const THREAT = {
  drone: { label: 'Drone / UAV', sym: '✈' }, missile: { label: 'Missile', sym: '▲' },
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
const CHANNEL_COLORS = { radarrussiia: '#ff5c5c', kpszsu: '#4fb6ff', lpr1_treugolnik: '#ff9f3d' };
const TRACK_COLORS = { drone: '#ff4fd8', missile: '#ffb03d', other: '#8aa8c8' };
const DISPLAY_WINDOW_MS = 90 * 60 * 1000;
const TRACK_KEEP_MS = 4 * 3600 * 1000;

const state = {
  sightings: [], tracks: [], filter: 'all', hasAutoZoomed: false,
  layers: (() => { const d = { tracks: true, zones: true, lines: true, labels: false, clock: true }; try { return Object.assign(d, JSON.parse(localStorage.getItem('ddx-layers') || '{}')); } catch { return d; } })(),
  timeline: { live: true, asOf: Date.now(), playing: false, speed: 300 },
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
function tracksAsOf(asOf) { const out = []; for (const t of state.tracks) { const pts = (t.points || []).filter((p) => (Date.parse(p.time) || 0) <= asOf); if (pts.length < 2) continue; const last = Date.parse(pts[pts.length - 1].time) || 0; if (asOf - last > TRACK_KEEP_MS) continue; out.push(Object.assign({}, t, { points: pts, lastSeen: pts[pts.length - 1].time, ended: t.ended && pts.length === t.points.length })); } return out; }

function matchesFilter(s) { switch (state.filter) { case 'danger': return statusInfo(s).level >= 3; case 'inbound': return s.status === 'approaching' || s.status === 'overhead'; case 'cleared': return s.status === 'all_clear' || s.status === 'shot_down'; case 'drone': return s.threatType === 'drone'; case 'missile': return ['missile','cruise_missile','ballistic_missile'].includes(s.threatType); default: return true; } }
function trackMatchesFilter(t) { if (state.filter === 'drone') return t.threatClass === 'drone'; if (state.filter === 'missile') return t.threatClass === 'missile'; return true; }

// ---- glyphs ----
function droneGlyph(cx, cy, color, s) { const a = 4.8 * s, rr = 3 * s, sw = 1.6 * s; let arms = '', rot = ''; for (const [dx, dy] of [[-a,-a],[a,-a],[-a,a],[a,a]]) { arms += `<line x1="${cx}" y1="${cy}" x2="${cx+dx}" y2="${cy+dy}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`; rot += `<circle class="rotor" cx="${cx+dx}" cy="${cy+dy}" r="${rr}" fill="#0d1b2a" stroke="${color}" stroke-width="${1.3*s}"/>`; } return arms + rot + `<circle cx="${cx}" cy="${cy}" r="${2.6*s}" fill="${color}"/>`; }
function missileGlyph(cx, cy, color, s) { const h = 7.5 * s; return `<polygon points="${cx},${cy-h} ${cx-h*0.55},${cy+h*0.7} ${cx+h*0.55},${cy+h*0.7}" fill="#0d1b2a" stroke="${color}" stroke-width="${1.7*s}" stroke-linejoin="round"/><polygon points="${cx},${cy-h} ${cx-h*0.28},${cy} ${cx+h*0.28},${cy}" fill="${color}"/>`; }
function genericGlyph(cx, cy, color, sym, s) { const r = 7.5 * s; return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0d1b2a" stroke="${color}" stroke-width="${2*s}"/><text x="${cx}" y="${cy+3.6*s}" text-anchor="middle" font-family="Arial" font-size="${10.5*s}" font-weight="bold" fill="${color}">${sym}</text>`; }
function clearGlyph(cx, cy, color, s) { const r = 7.5 * s; return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0d1b2a" stroke="${color}" stroke-width="${2*s}"/><path d="M${cx-3.6*s},${cy+0.3*s} L${cx-1*s},${cy+3*s} L${cx+3.8*s},${cy-3*s}" fill="none" stroke="${color}" stroke-width="${2*s}" stroke-linecap="round" stroke-linejoin="round"/>`; }
function threatGlyph(type, cx, cy, color, s) { if (type === 'drone') return droneGlyph(cx, cy, color, s); if (['missile','cruise_missile','ballistic_missile'].includes(type)) return missileGlyph(cx, cy, color, s); return genericGlyph(cx, cy, color, (THREAT[type] || THREAT.unknown).sym, s); }
function buildIcon(s) {
  const info = statusInfo(s), color = info.color, bearing = confidentBearing(s);
  const isWarn = info.warn, isDanger = info.level >= 3, count = Math.max(1, s.count || 1);
  const scale = 1.05, gR = 7.8 * scale, showCount = count > 1, label = '×' + count;
  const labelW = showCount ? label.length * 7 + 12 : 0, gap = 6, half = showCount ? 10 : 0;
  const ringR = isDanger ? gR + 4 : gR, reach = bearing !== null ? gR + 22 : 0, m = 5;
  const lp = Math.max(ringR, reach), tp = Math.max(ringR, reach, half), bp = Math.max(ringR, reach, half), rp = Math.max(ringR, reach, gR + gap + labelW);
  const Gx = lp + m, Gy = tp + m, W = Math.ceil(lp + rp + 2 * m), H = Math.ceil(tp + bp + 2 * m);
  const glyph = s.status === 'all_clear' ? clearGlyph(Gx, Gy, color, scale) : threatGlyph(s.threatType, Gx, Gy, color, scale);
  let arrow = '';
  if (bearing !== null) { const base = gR + 3, head = gR + 16, tip = gR + 22; arrow = `<g transform="rotate(${bearing} ${Gx} ${Gy})"><line x1="${Gx}" y1="${Gy-base}" x2="${Gx}" y2="${Gy-head}" stroke="${color}" stroke-width="3" stroke-linecap="round"/><polygon points="${Gx},${Gy-tip} ${Gx-6},${Gy-head+1} ${Gx+6},${Gy-head+1}" fill="${color}"/></g>`; }
  const pulse = isWarn ? `<circle class="pulse" cx="${Gx}" cy="${Gy}" r="${gR}" fill="${color}"/>` : '';
  const ring = isDanger ? `<circle class="pulse-alert" cx="${Gx}" cy="${Gy}" r="${gR+4}" fill="none" stroke="${color}" stroke-width="2" opacity="0.8"/>` : '';
  let badge = '';
  if (showCount) { const bx = Gx + gR + gap; badge = `<rect x="${bx}" y="${Gy-9}" width="${labelW}" height="18" rx="9" fill="#0d1b2a" stroke="${color}" stroke-width="1.5"/><text x="${bx+labelW/2}" y="${Gy+4}" text-anchor="middle" font-family="Arial" font-size="12.5" font-weight="bold" fill="${color}">${label}</text>`; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${ring}${pulse}${arrow}${glyph}${badge}</svg>`;
  return L.divIcon({ className: 'threat-icon', html: svg, iconSize: [W, H], iconAnchor: [Gx, Gy], popupAnchor: [0, -(tp + 2)] });
}
function arrowheadIcon(bearing, color) { const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><g transform="rotate(${bearing} 11 11)"><polygon points="11,2 4,17 11,13 18,17" fill="${color}" stroke="#0d1b2a" stroke-width="1"/></g></svg>`; return L.divIcon({ className: 'arrow-icon', html: svg, iconSize: [22, 22], iconAnchor: [11, 11] }); }

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
  return `<div class="popup-title">${esc(s.location)}</div>${statusLine}${confirm}<div class="popup-meta">${esc(bits.join(' · '))} · ${fmtTime(s.timestamp)}</div>${going}<div class="popup-acc">${acc.join(' · ')}</div>${s.postText ? `<div class="popup-text">${esc(s.postText)}</div>` : ''}${s.postLink ? `<div class="popup-link"><a href="${esc(s.postLink)}" target="_blank" rel="noopener">Open in Telegram ↗</a></div>` : ''}`;
}

// ---- map ----
const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([54.5, 42.0], 5);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© OpenStreetMap © CARTO' }).addTo(map);
const tracksLayer = L.layerGroup().addTo(map), zonesLayer = L.layerGroup().addTo(map), routeLayer = L.layerGroup().addTo(map), markersLayer = L.layerGroup().addTo(map), labelsLayer = L.layerGroup().addTo(map);
const LAYER_GROUPS = { tracks: tracksLayer, zones: zonesLayer, lines: routeLayer, labels: labelsLayer };
function applyLayerToggles() { for (const [k, g] of Object.entries(LAYER_GROUPS)) { if (state.layers[k]) { if (!map.hasLayer(g)) map.addLayer(g); } else if (map.hasLayer(g)) map.removeLayer(g); } document.getElementById('clock').style.display = state.layers.clock ? 'block' : 'none'; document.querySelectorAll('#layerBar .chip').forEach((b) => b.classList.toggle('active', !!state.layers[b.dataset.layer])); }

function currentAsOf() { return state.timeline.live ? Date.now() : state.timeline.asOf; }
function renderAll() { const asOf = currentAsOf(); const sightings = sightingsAsOf(asOf); renderMarkers(sightings); renderTracks(tracksAsOf(asOf)); renderWarnings(sightings); updateHeader(sightings); updateClock(); }

function renderMarkers(sightings) {
  zonesLayer.clearLayers(); routeLayer.clearLayers(); markersLayer.clearLayers(); labelsLayer.clearLayers();
  const asOf = currentAsOf(), toShow = sightings.filter(matchesFilter), pts = [];
  for (const s of toShow) {
    const info = statusInfo(s), color = info.color;
    if (info.level >= 3) L.circle([s.lat, s.lon], { radius: 45000, color, fillColor: color, fillOpacity: 0.045, weight: 1, opacity: 0.28, dashArray: '5 5' }).addTo(zonesLayer);
    else if (s.geocodePrecision === 'region') L.circle([s.lat, s.lon], { radius: 30000, color: '#6f93b4', weight: 1, opacity: 0.25, fill: false, dashArray: '3 6' }).addTo(zonesLayer);
    const dest = confidentDest(s), bearing = resolveBearing(s);
    if (dest) { const lb = bearingTo(s.lat, s.lon, dest.lat, dest.lon); L.polyline([[s.lat, s.lon], [dest.lat, dest.lon]], { color, weight: 2.5, opacity: 0.55, dashArray: '7 6' }).addTo(routeLayer); L.marker([dest.lat, dest.lon], { icon: arrowheadIcon(lb, color), interactive: false, keyboard: false }).addTo(routeLayer); pts.push([dest.lat, dest.lon]); }
    else if (bearing !== null && info.warn) { const pe = projectPoint(s.lat, s.lon, bearing, 200); L.polyline([[s.lat, s.lon], pe], { color, weight: 1.5, opacity: 0.25, dashArray: '3 10' }).addTo(routeLayer); L.marker(pe, { icon: arrowheadIcon(bearing, color), interactive: false, keyboard: false, opacity: 0.35 }).addTo(routeLayer); }
    const ageMin = (asOf - (Date.parse(s.timestamp || '') || asOf)) / 60000, opacity = ageMin <= 10 ? 1 : Math.max(0.5, 1 - (ageMin - 10) / 100);
    L.marker([s.lat, s.lon], { icon: buildIcon(s), opacity }).bindPopup(popupHtml(s), { maxWidth: 280 }).addTo(markersLayer);
    pts.push([s.lat, s.lon]);
    L.tooltip({ permanent: true, direction: 'bottom', className: 'place-label', offset: [0, 14], interactive: false }).setContent(`<span style="color:${color}">${esc(s.location)}</span>`).setLatLng([s.lat, s.lon]).addTo(labelsLayer);
  }
  if (!state.hasAutoZoomed && pts.length) { const ap = toShow.filter((s) => statusInfo(s).warn).map((s) => [s.lat, s.lon]); map.fitBounds(ap.length ? ap : pts, { padding: [80, 80], maxZoom: 9 }); state.hasAutoZoomed = true; }
}
function trackTooltip(t) { const from = t.points[0], to = t.points[t.points.length - 1], kind = t.threatClass === 'missile' ? 'Missile' : 'Drone'; const span = `${fmtUTC(t.firstSeen).replace(' UTC','')} → ${fmtUTC(t.lastSeen)}`; return `<b>${kind} track</b> · ${t.points.length} waypoints · ~${t.distanceKm} km<br>${esc(from.location || '?')} → ${esc(to.location || '?')}${t.ended ? ' · <b style="color:#4fb6ff">ended</b>' : ''}<br><span style="color:#8ab0d0">${span}</span>`; }
function renderTracks(tracks) {
  tracksLayer.clearLayers(); const asOf = currentAsOf();
  for (const t of tracks) {
    if (!trackMatchesFilter(t)) continue;
    const ll = t.points.map((p) => [p.lat, p.lon]), color = TRACK_COLORS[t.threatClass] || TRACK_COLORS.other;
    const ageH = Math.max(0, (asOf - (Date.parse(t.lastSeen) || asOf)) / 3600000), alpha = Math.max(0.14, 0.9 - ageH * 0.075);
    const glow = L.polyline(ll, { color, weight: 9, opacity: alpha * 0.16 }).addTo(tracksLayer); glow.bindTooltip(trackTooltip(t), { sticky: true, className: 'trk-tip', opacity: 1 });
    L.polyline(ll, { color, weight: 1.7, opacity: alpha, interactive: false }).addTo(tracksLayer);
    for (const p of t.points) L.circleMarker([p.lat, p.lon], { radius: 2.1, color, fillColor: color, fillOpacity: alpha, opacity: alpha, weight: 1, interactive: false }).addTo(tracksLayer);
    if (!t.ended && ageH < 2 && ll.length >= 2) { const a = ll[ll.length - 2], b = ll[ll.length - 1]; L.marker(b, { icon: arrowheadIcon(bearingTo(a[0], a[1], b[0], b[1]), color), interactive: false, keyboard: false, opacity: Math.min(1, alpha + 0.15) }).addTo(tracksLayer); }
  }
}
function renderWarnings(sightings) {
  const panel = document.getElementById('warnPanel'), list = document.getElementById('warnList'), title = document.getElementById('warnTitle');
  const warns = sightings.filter((s) => statusInfo(s).warn);
  if (!warns.length) { panel.style.display = 'none'; return; }
  const groups = new Map();
  for (const s of warns) { const key = s.region || s.location || '—', info = statusInfo(s); let g = groups.get(key); if (!g) { g = { key, level: 0, spots: 0, latest: 0, latlng: [s.lat, s.lon], label: info.label, color: info.color }; groups.set(key, g); } g.spots++; const t = Date.parse(s.timestamp || '') || 0; if (t > g.latest) g.latest = t; if (info.level > g.level) { g.level = info.level; g.label = info.label; g.color = info.color; g.latlng = [s.lat, s.lon]; } }
  const arr = [...groups.values()].sort((a, b) => b.level - a.level || b.latest - a.latest).slice(0, 14), danger = arr.some((g) => g.level >= 3);
  panel.className = 'warn-panel' + (danger ? ' danger' : ''); panel.style.display = 'block'; title.textContent = `Active warnings (${groups.size})`;
  list.innerHTML = '';
  for (const g of arr) { const ago = g.latest ? fmtTime(new Date(g.latest).toISOString()) : ''; const row = document.createElement('div'); row.className = 'warn-item'; row.innerHTML = `<span class="warn-sev" style="background:${g.color}"></span><span class="warn-body"><span class="warn-region">${esc(g.key)}</span><span class="warn-meta">${esc(g.label)} · ${g.spots} spot${g.spots > 1 ? 's' : ''}${ago ? ' · ' + ago : ''}</span></span>`; row.addEventListener('click', () => { if (typeof g.latlng[0] === 'number') map.flyTo(g.latlng, Math.max(map.getZoom(), 8), { duration: 0.6 }); }); list.appendChild(row); }
}
function updateHeader(sightings) {
  const badge = document.getElementById('threatBadge');
  const active = sightings.filter((s) => s.status !== 'all_clear');
  const danger = active.filter((s) => statusInfo(s).level >= 3).length, inbound = active.filter((s) => statusInfo(s).level === 2).length;
  const lvl = danger >= 3 ? 'CRITICAL' : danger >= 1 ? 'HIGH' : inbound >= 2 ? 'ELEVATED' : inbound >= 1 ? 'MODERATE' : active.length ? 'LOW' : 'CLEAR';
  const col = danger >= 3 ? '#ff2d2d' : danger >= 1 ? '#ff5c5c' : inbound >= 2 ? '#ff7a3d' : inbound >= 1 ? '#ffb03d' : active.length ? '#9ab4d0' : '#3fd87f';
  badge.innerHTML = `· <b style="color:${col}">${lvl}</b> · ${active.length} active`;
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
function setTimelineTime(asOf, fromSlider) {
  const { max } = historyBounds();
  state.timeline.live = asOf >= max - 1000; state.timeline.asOf = Math.min(asOf, max);
  const tlTime = document.getElementById('tlTime');
  if (state.timeline.live) { tlTime.textContent = 'LIVE'; tlTime.classList.remove('replay'); } else { tlTime.textContent = fmtUTC(state.timeline.asOf); tlTime.classList.add('replay'); }
  document.getElementById('tlLive').classList.toggle('active', state.timeline.live);
  if (!fromSlider) document.getElementById('tlSlider').value = timeToSlider(state.timeline.asOf);
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
document.querySelectorAll('#layerBar .chip').forEach((btn) => btn.addEventListener('click', () => { const k = btn.dataset.layer; state.layers[k] = !state.layers[k]; try { localStorage.setItem('ddx-layers', JSON.stringify(state.layers)); } catch {} applyLayerToggles(); }));

// ---- status + data polling ----
function setStatus(st, msg) { const dot = document.getElementById('statusDot'), text = document.getElementById('statusText'); text.textContent = msg || ''; dot.className = 'dot'; if (st === 'error') dot.classList.add('error'); else if (['polling','processing','backfill','starting'].includes(st)) dot.classList.add('busy'); }
function showBackfill(s) {
  const bar = document.getElementById('backfillBar'), label = document.getElementById('backfillLabel'), fill = document.getElementById('backfillFill');
  if (s.state === 'backfill') { bar.style.display = 'flex'; label.textContent = s.message; const pct = s.total ? Math.round((s.done / s.total) * 100) : 8; fill.style.width = Math.max(8, s.phase === 'extract' ? pct : 10) + '%'; }
  else if (s.phase === 'done' || s.state === 'idle' || s.state === 'polling') { fill.style.width = '100%'; setTimeout(() => { bar.style.display = 'none'; }, 1500); }
}
async function fetchJson(url) { const r = await fetch(url + '?t=' + Date.now()); if (!r.ok) throw new Error(r.status); return r.json(); }
async function refreshData() {
  try {
    const [sd, td] = await Promise.all([fetchJson('data/sightings.json'), fetchJson('data/tracks.json')]);
    state.sightings = sd.sightings || []; state.tracks = td.tracks || [];
    if (sd.backend) document.getElementById('backendLabel').textContent = sd.backend;
    if (state.timeline.live) document.getElementById('tlSlider').value = 1000;
    renderAll();
  } catch { /* keep last good */ }
}
async function refreshStatus() {
  try { const s = await fetchJson('data/status.json'); setStatus(s.state, s.message); showBackfill(s); } catch {}
}

// ---- boot ----
applyLayerToggles();
setTimelineTime(Date.now());
refreshStatus(); refreshData();
setInterval(refreshStatus, 3000);
setInterval(refreshData, 8000);
