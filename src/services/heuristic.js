'use strict';

/**
 * Deterministic fallback parser for the @radarrussiia post format.
 *
 * The channel is highly regular, e.g.:
 *
 *   Медынский район
 *   Калужская область
 *   Фиксация от 5 БПЛА
 *
 *   ГО Бронницы
 *   Московская область
 *   Работа ПВО по БПЛА
 *
 *   Павловский Посад, Орехово-Зуево, Московская область - опасность по БПЛА.
 *
 * Parsing these with rules (instead of relying on the LLM every time) makes
 * detection far more consistent: counts and statuses come out the same way
 * every run, and a post is never silently dropped when the model has a bad
 * day. Used both as a safety net when the LLM fails and to backfill missing
 * count/status on LLM results. Output matches normalizeExtraction's shape.
 */

const DRONE_RE = /бпла|дрон|беспилотн|fpv/i;
const MISSILE_RE = /ракет|крылат|баллист/i;
const REGION_RE = /(област|край|краю|республик|округ|\bА[РP]\b)/i;

// Lines that are channel boilerplate / contact footer, not content.
const FOOTER_RE = /(радар по всей|обход белых|@\w|https?:|t\.me|подписат|бот[аы]?\b)/i;

// Phrases that describe the event rather than a place — never a location.
const PHRASE_RE =
  /(бпла|дрон|беспилотн|fpv|опасн|сбит|пво|отбой|мер[аы]\s+безопасн|фиксац|работа|повторно|ракет|угроз|внимание|тревог)/i;

/** Map the Russian status wording to our status enum. */
function detectStatus(text) {
  const t = text.toLowerCase();
  if (/отбой/.test(t)) return 'all_clear';
  if (/(прил[её]т|взрыв|поврежд|попадан|удар)/.test(t)) return 'impact';
  if (/(сбит|уничтож|пораж)/.test(t)) return 'shot_down';
  if (/(работа\s+пво|пво\s+работа|работает\s+пво|отражени)/.test(t)) return 'overhead';
  if (/(опасн|угроз|тревог)/.test(t)) return 'alert';
  if (/(в сторону|в направлени|курс на|лет(ят|ит|еть|ел)\s+на|движ|приближ|фиксац|пересека)/.test(t)) {
    return 'approaching';
  }
  return 'unknown';
}

/** Pull a drone count out of "от 5 БПЛА" / "20 БПЛА" / "5 дронов". */
function detectCount(text) {
  let m = text.match(/от\s+(\d{1,4})\s*(?:бпла|дрон|беспилотн|fpv)/i);
  if (m) return parseInt(m[1], 10);
  m = text.match(/(\d{1,4})\s*(?:бпла|дрон|беспилотн|fpv)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** Pull a destination place out of "в направлении Москвы" / "курс на Москву". */
function detectDestination(text) {
  const m = text.match(
    /(?:в\s+сторону|в\s+направлении|курс\s+на|лет(?:ят|ит|еть|ел)\s+на|направля\w*\s+на)\s+([А-ЯЁ][а-яё-]+)/
  );
  return m ? m[1] : null;
}

function detectThreatType(text) {
  if (MISSILE_RE.test(text)) {
    if (/крылат/i.test(text)) return 'cruise_missile';
    if (/баллист/i.test(text)) return 'ballistic_missile';
    return 'missile';
  }
  return 'drone';
}

/** Strip administrative prefixes so the geocoder can match the bare name. */
function cleanLocation(s) {
  return s
    .replace(/^(МО|ГО|г\.|г|пгт|с\.|д\.|город|село|деревня|пос\.?)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A real place name is short and capitalised — this rejects free-form prose
// (e.g. "Один за другим пересекают стык ... области") from becoming a location.
function isPlaceLike(c) {
  return /^[А-ЯЁA-Z]/.test(c) && c.length <= 40 && c.split(/\s+/).length <= 4;
}

function meaningfulLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^[❗️🌐•▪️◾️\-—]/.test(l))
    .filter((l) => !FOOTER_RE.test(l));
}

/**
 * Parse a post into the normalizeExtraction shape:
 *   { isRelevant, summary, sightings: [{ location, locationRu, region, lat,
 *     lon, threatType, count, heading, destination, status, confidence }] }
 *
 * Returns isRelevant=false when the post is not about an aerial threat, and
 * isRelevant=true with sightings=[] when it is a threat post we could not pin
 * to a place (so callers can still treat the LLM result as authoritative).
 */
function analyzePost(text) {
  const out = { isRelevant: false, summary: '', sightings: [] };
  if (!text || (!DRONE_RE.test(text) && !MISSILE_RE.test(text))) return out;

  out.isRelevant = true;
  const threatType = detectThreatType(text);
  const status = detectStatus(text);
  const count = detectCount(text);
  const destination = detectDestination(text);

  // Break the post into place "chunks": meaningful lines, with any trailing
  // " - <phrase>" cut off, then split on commas.
  const chunks = [];
  for (let line of meaningfulLines(text)) {
    line = line.replace(/\s[-–—:]\s.*$/, '');
    for (const piece of line.split(',')) {
      const c = piece.trim();
      if (c && !PHRASE_RE.test(c) && isPlaceLike(c)) chunks.push(c);
    }
  }

  // The region is the last chunk that looks like an oblast/krai/republic.
  let region = '';
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (REGION_RE.test(chunks[i])) {
      region = chunks[i];
      break;
    }
  }

  // Locations are the remaining, non-region chunks.
  let locations = chunks.filter((c) => c !== region && !REGION_RE.test(c)).map(cleanLocation);
  locations = [...new Set(locations.filter(Boolean))];

  // A region-wide post (no specific town) still maps to the region centroid.
  if (locations.length === 0 && region) locations = [cleanLocation(region)];
  if (locations.length === 0) return out; // threat post but no locatable place

  for (const loc of locations) {
    out.sightings.push({
      location: loc,
      locationRu: loc,
      region: region || '',
      lat: null,
      lon: null,
      threatType,
      count,
      heading: null,
      destination: destination || null,
      status,
      confidence: 0.55,
    });
  }
  out.summary = `${threatType === 'drone' ? 'Drone' : 'Missile'} activity (${status}) at ${locations.join(', ')}`.slice(0, 300);
  return out;
}

module.exports = {
  analyzePost,
  detectStatus,
  detectCount,
  detectDestination,
  detectThreatType,
  cleanLocation,
};
