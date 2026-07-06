'use strict';

/**
 * Track correlation: chain time-ordered sightings into flight tracks.
 *
 * The channels report the same drone group town-by-town as it crosses the
 * country ("Фиксация БПЛА" in Tula → Ryazan → Kolomna…). Individually those
 * are dots; chained together they are a flight path. This module links
 * successive sightings into tracks using distance / time / speed / turn-angle
 * plausibility, so the map can draw the actual route flown.
 *
 * Input sightings need: lat, lon, timestamp, threatType, status. Optional:
 * location, geocodePrecision, channel, count, bearing.
 */

const DEFAULTS = {
  maxLegKm: 450,      // max distance between consecutive points of one track
  maxGapMin: 100,     // max minutes between consecutive points
  maxSpeedKmh: 500,   // Shaheds ~185 km/h, cruise missiles ~800 — but post lag
                      // compresses apparent time, so allow a generous ceiling
  maxTurnDeg: 100,    // max change of course between successive legs
  minPointKm: 12,     // closer than this to the last point = same place, merge
};

function toRad(d) { return (d * Math.PI) / 180; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const dla = toRad(lat2 - lat1);
  const dlo = toRad(lon2 - lon1);
  const a =
    Math.sin(dla / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// drones chain with drones, missiles (all kinds) with missiles.
function threatClass(threatType) {
  if (threatType === 'drone') return 'drone';
  if (threatType === 'missile' || threatType === 'cruise_missile' || threatType === 'ballistic_missile') {
    return 'missile';
  }
  return 'other';
}

// Statuses that represent an actual observed position of the object.
// "alert"/"all_clear" are area-wide announcements, not positions — chaining
// their region centroids would draw zigzags through oblast centers.
const POSITION_STATUSES = new Set(['approaching', 'overhead', 'unknown']);
// Terminal statuses: the object stopped here (shot down / hit something).
const TERMINAL_STATUSES = new Set(['shot_down', 'impact']);

function isTrackable(s) {
  if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false;
  if (!s.timestamp || isNaN(Date.parse(s.timestamp))) return false;
  if (s.geocodePrecision === 'region') return false; // centroid ≠ position
  const st = s.status || 'unknown';
  return POSITION_STATUSES.has(st) || TERMINAL_STATUSES.has(st);
}

/**
 * Build tracks from a history of sightings.
 * @param {Array} sightings raw sighting objects (any order)
 * @param {object} [opts] override DEFAULTS
 * @returns {Array<{id:string, threatClass:string, points:Array, firstSeen:string,
 *   lastSeen:string, ended:boolean, distanceKm:number}>} tracks with ≥2 points
 */
function buildTracks(sightings, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const pts = (sightings || [])
    .filter(isTrackable)
    .map((s) => ({
      lat: s.lat,
      lon: s.lon,
      t: Date.parse(s.timestamp),
      time: s.timestamp,
      location: s.location || '',
      status: s.status || 'unknown',
      channel: s.channel || (s.sources && s.sources[0]) || '',
      count: typeof s.count === 'number' ? s.count : null,
      cls: threatClass(s.threatType),
    }))
    .sort((a, b) => a.t - b.t);

  const tracks = [];
  let nextId = 1;

  for (const p of pts) {
    let best = null;
    let bestDist = Infinity;

    for (const trk of tracks) {
      if (trk.ended) continue;
      if (trk.cls !== p.cls) continue;
      const last = trk.points[trk.points.length - 1];
      const dtMin = (p.t - last.t) / 60000;
      if (dtMin < 0 || dtMin > cfg.maxGapMin) continue;
      const dKm = haversineKm(last.lat, last.lon, p.lat, p.lon);
      if (dKm > cfg.maxLegKm) continue;
      // Same-spot repeat report → merge into the last point below.
      if (dKm >= cfg.minPointKm) {
        // Speed plausibility (skip when dt≈0 — posts can share a timestamp).
        if (dtMin > 2 && (dKm / (dtMin / 60)) > cfg.maxSpeedKmh) continue;
        // Course consistency vs the previous leg.
        if (trk.points.length >= 2) {
          const prev = trk.points[trk.points.length - 2];
          const legPrev = bearingDeg(prev.lat, prev.lon, last.lat, last.lon);
          const legNew = bearingDeg(last.lat, last.lon, p.lat, p.lon);
          if (angleDiff(legPrev, legNew) > cfg.maxTurnDeg) continue;
        }
      }
      if (dKm < bestDist) {
        bestDist = dKm;
        best = trk;
      }
    }

    if (best) {
      const last = best.points[best.points.length - 1];
      if (bestDist < cfg.minPointKm) {
        // Repeat report of the same place: refresh, don't add a zero-leg.
        last.t = p.t;
        last.time = p.time;
        last.status = p.status;
        if (p.count != null) last.count = p.count;
      } else {
        best.points.push(p);
      }
      if (TERMINAL_STATUSES.has(p.status)) best.ended = true;
    } else {
      tracks.push({ id: `trk-${nextId++}`, cls: p.cls, points: [p], ended: TERMINAL_STATUSES.has(p.status) });
    }
  }

  // Only multi-point chains are tracks; single dots are just markers.
  return tracks
    .filter((t) => t.points.length >= 2)
    .map((t) => {
      let dist = 0;
      for (let i = 1; i < t.points.length; i++) {
        dist += haversineKm(
          t.points[i - 1].lat, t.points[i - 1].lon,
          t.points[i].lat, t.points[i].lon
        );
      }
      return {
        id: t.id,
        threatClass: t.cls,
        points: t.points.map((p) => ({
          lat: +p.lat.toFixed(4),
          lon: +p.lon.toFixed(4),
          time: p.time,
          location: p.location,
          status: p.status,
          count: p.count,
        })),
        firstSeen: t.points[0].time,
        lastSeen: t.points[t.points.length - 1].time,
        ended: t.ended,
        distanceKm: Math.round(dist),
      };
    });
}

module.exports = {
  buildTracks,
  isTrackable,
  threatClass,
  haversineKm,
  bearingDeg,
  angleDiff,
  DEFAULTS,
};
