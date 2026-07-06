'use strict';

/**
 * Shared post-extraction enrichment & sanity logic, used by both the GitHub
 * Actions map pipeline (scripts/update-map.js) and the desktop app pipeline
 * (src/services/pipeline.js), so both produce identically-cleaned data.
 */

const { normalizeKey } = require('./geocode');

// Map a free-text compass heading to a bearing in degrees (0=N, clockwise).
const COMPASS = {
  n: 0, north: 0, север: 0, северное: 0,
  ne: 45, 'north-east': 45, northeast: 45, 'северо-восток': 45,
  e: 90, east: 90, восток: 90, восточное: 90,
  se: 135, 'south-east': 135, southeast: 135, 'юго-восток': 135,
  s: 180, south: 180, юг: 180, южное: 180,
  sw: 225, 'south-west': 225, southwest: 225, 'юго-запад': 225,
  w: 270, west: 270, запад: 270, западное: 270,
  nw: 315, 'north-west': 315, northwest: 315, 'северо-запад': 315,
};

function headingToBearing(heading) {
  if (!heading) return null;
  const key = heading.toString().trim().toLowerCase().replace(/\s+/g, '-');
  if (key in COMPASS) return COMPASS[key];
  // Loose contains match (e.g. "heading north toward Moscow").
  for (const word of Object.keys(COMPASS)) {
    if (word.length > 2 && key.includes(word)) return COMPASS[word];
  }
  return null;
}

// Great-circle initial bearing from point 1 to point 2, in degrees (0=N).
function bearingBetween(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI; // -180..180; (deg+360)%360 to normalize
}

// Rough bounding box: Russia + nearby conflict areas. Filters out geocoder results
// that landed on a different continent (e.g. Moscow, Idaho).
function isInRegion(lat, lon) {
  return lat >= 38 && lat <= 78 && lon >= 18 && lon <= 195;
}

const VALID_HEADINGS = new Set([
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
]);

// If the LLM put a place name in "heading" (e.g. "towards Moscow"), extract it
// as the destination and clear the heading so it doesn't confuse bearing logic.
function normalizeSightingDirection(s) {
  if (!s.heading) return s;
  const h = s.heading.toLowerCase().trim();
  if (VALID_HEADINGS.has(h.replace(/\s+/g, '-'))) return s; // already valid compass
  // Extract place name from free-text like "towards Moscow" / "toward Kursk"
  if (!s.destination) {
    const m = h.match(/^towards?\s+(.+)/);
    if (m) {
      // Preserve original case for the extracted place name
      const idx = s.heading.toLowerCase().indexOf(m[1]);
      s.destination = s.heading.slice(idx).split(',')[0].trim();
    }
  }
  s.heading = null;
  return s;
}

// Pull a place name out of a free-text heading like "towards Moscow".
function destFromHeading(heading) {
  if (!heading) return '';
  const m = heading.toString().match(/^\s*towards?\s+(.+)/i);
  return m ? m[1].split(',')[0].trim() : '';
}

// Where a sighting is heading (explicit field or parsed from the heading text).
function sightingDestination(s) {
  return (s.destination && s.destination.toString().trim()) || destFromHeading(s.heading);
}

// Remove "destination echo" markers: when one sighting in a post is heading
// toward a place, a second sighting AT that place (from the same post) is the
// LLM duplicating the destination as its own location. Drop those so a single
// event shows one group with an arrow, not two groups.
function dropDestinationEchoes(sightings) {
  const byPost = new Map();
  for (const s of sightings) {
    // Key by channel + post so the same post number on two channels never merges.
    const key = s.postId != null ? `${s.channel || ''}/${s.postId}` : s.id;
    if (!byPost.has(key)) byPost.set(key, []);
    byPost.get(key).push(s);
  }
  const stripRegionWord = (k) =>
    k.replace(/\s+(oblast|region|raion|district|krai|republic|область|области|округ|край)$/, '').trim();
  const drop = new Set();
  for (const group of byPost.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      const aLoc = normalizeKey(a.location);
      if (!aLoc) continue;
      const aLocBare = stripRegionWord(aLoc);
      for (const b of group) {
        if (a === b) continue;
        const bDest = normalizeKey(sightingDestination(b));
        if (bDest && (bDest === aLoc || bDest === aLocBare)) {
          drop.add(a.id);
          break;
        }
      }
    }
  }
  return sightings.filter((s) => !drop.has(s.id));
}

// Fill in count/status the model left blank using the deterministic parser, so
// "Фиксация от 5 БПЛА" reliably becomes count=5 and "Отбой" becomes all_clear.
function backfillFromHeuristic(sightings, heur) {
  if (!heur || !heur.isRelevant || !heur.sightings.length) return;
  const heurCount = heur.sightings[0].count;
  const heurStatus = heur.sightings[0].status;
  // Only attribute a count to a LONE sighting — a number alongside several
  // places is ambiguous (often a total), so don't stamp it on each.
  const single = sightings.length === 1;
  for (const s of sightings) {
    if (single && (s.count === null || s.count === undefined) && heurCount != null) {
      s.count = heurCount;
    }
    if ((!s.status || s.status === 'unknown') && heurStatus && heurStatus !== 'unknown') {
      s.status = heurStatus;
    }
  }
}

// A single post that lists one big number across MANY areas is a TOTAL, not a
// per-location count (e.g. "133 UAVs over Belgorod, Bryansk, Kaluga … oblasts").
// Don't stamp that number on every marker.
function stripSummaryCounts(sightings) {
  if (sightings.length < 3) return sightings;
  const counts = sightings.map((s) => s.count).filter((c) => typeof c === 'number');
  if (counts.length >= 3 && new Set(counts).size === 1 && counts[0] >= 10) {
    for (const s of sightings) s.count = null;
  }
  return sightings;
}

/**
 * Resolve where a sighting is going: geocode the destination if the post named
 * one, then derive a travel bearing (great-circle to the destination, falling
 * back to the compass heading). Returns {destination, destinationLat,
 * destinationLon, bearing}.
 */
async function resolveMovement(sighting, geo, geocoder, log = () => {}) {
  let destination = sighting.destination || null;
  let destinationLat = null;
  let destinationLon = null;
  let bearing = null;

  if (destination) {
    const destGeo = await geocoder.resolve({
      location: destination,
      region: '', // don't bias by sighting region — destination may be a different region
    });
    // Only trust the geocoded destination if it lands in the expected region.
    if (destGeo && isInRegion(destGeo.lat, destGeo.lon)) {
      destinationLat = destGeo.lat;
      destinationLon = destGeo.lon;
      const b = bearingBetween(geo.lat, geo.lon, destGeo.lat, destGeo.lon);
      bearing = ((b % 360) + 360) % 360;
    } else if (destGeo) {
      log(`bad-dest-geo: ${destination} resolved outside region (${destGeo.lat},${destGeo.lon})`);
    }
  }
  if (bearing === null) bearing = headingToBearing(sighting.heading);
  return { destination, destinationLat, destinationLon, bearing };
}

module.exports = {
  COMPASS,
  headingToBearing,
  bearingBetween,
  isInRegion,
  normalizeSightingDirection,
  destFromHeading,
  sightingDestination,
  dropDestinationEchoes,
  backfillFromHeuristic,
  stripSummaryCounts,
  resolveMovement,
};
