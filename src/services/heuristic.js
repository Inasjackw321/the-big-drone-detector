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

// Russian (бпла/дрон) and Ukrainian (бпла/шахед/мопед) drone wording.
const DRONE_RE = /бпла|дрон|беспилотн|безпілотн|шахед|шахід|мопед|fpv/i;
const MISSILE_RE = /ракет|крылат|крилат|баллист|балістич/i;
// Crewed aircraft: jets, bombers, helicopters, named types.
const AIRCRAFT_RE = /авиац|авіац|самол[еёо]т|літак|бомбардир|истребител|винищувач|штурмовик|вертол[еёі]т|гелікоптер|ми[гj]-?\s?\d|су-?\s?\d|ту-?\s?\d|kinzhal|кинжал|кинджал/i;
const REGION_RE = /(област|край|краю|республик|округ|\bА[РP]\b)/i;

// Lines that are channel boilerplate / contact footer, not content.
const FOOTER_RE = /(радар по всей|обход белых|@\w|https?:|t\.me|подписат|бот[аы]?\b)/i;

// Phrases that describe the event rather than a place — never a location.
const PHRASE_RE =
  /(бпла|дрон|беспилотн|безпілотн|шахед|fpv|опасн|сбит|збит|пво|ппо|отбой|відбій|мер[аы]\s+безопасн|фиксац|работа|повторно|ракет|угроз|загроз|внимание|увага|тревог|тривог)/i;

/** Map Russian and Ukrainian status wording to our status enum. */
function detectStatus(text) {
  const t = text.toLowerCase();
  if (/отбой|відбій/.test(t)) return 'all_clear';
  // "удар" = a strike (impact), but NOT "ударний/ударних" = strike-type drone.
  if (/(прил[её]т|приліт|взрыв|вибух[иів]*|поврежд|попадан|влучан|удар(?!н))/.test(t)) return 'impact';
  if (/(сбит|уничтож|пораж|збит|збил|знищ)/.test(t)) return 'shot_down';
  if (/(работа\s+пво|пво\s+работа|работает\s+пво|отражени|робот[а-яёіїєґ]*\s+ппо|ппо\s+прац|відбива)/.test(t)) {
    return 'overhead';
  }
  if (/(опасн|угроз|тревог|тривог|загроз)/.test(t)) return 'alert';
  if (/(в сторону|в направлени|курс|лет(?:ят|ит|еть|ел|ить)\s+на|движ|приближ|зафіксован|виявлен|фиксац|пересека|руха|прямую|проліта|у напрямку|в бік|прямують|detected)/.test(t)) {
    return 'approaching';
  }
  return 'unknown';
}

/** Pull a drone count out of "от/від 5 БПЛА" / "20 БПЛА" / "5 дронів" / "N об'єктів". */
function detectCount(text) {
  // "від N" (Ukrainian "from N") and "от N" (Russian)
  let m = text.match(/(?:від|от)\s+(\d{1,4})\s*(?:бпла|дрон\w*|беспилотн|безпілотн\w*|шахед\w*|об'єкт\w*|ціл\w*|fpv)/i);
  if (m) return parseInt(m[1], 10);
  // "N БПЛА" / "N об'єктів" / "N цілей" / "N шахедів"
  m = text.match(/(\d{1,4})\s*(?:бпла|дрон[ів]*|беспилотн|безпілотн\w*|шахед[ів]*|об'єкт[ів]*|ціл[ей]*|fpv)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** Pull a destination place out of "в направлении Москвы" / "курсом на Київ" / "в бік Харкова". */
function detectDestination(text) {
  const m = text.match(
    /(?:в\s+сторону|в\s+направлении|у\s+напрямку|в\s+бік|курс[а-яёіїєґ]*\s+на|лет(?:ят|ит|еть|ел|ить)\s+на|летить\s+(?:у\s+напрямку\s+)?(?:на|до)|направля[а-яёіїєґ]*\s+на|прямую[а-яёіїєґ]*\s+на|рухаються?\s+(?:у\s+напрямку\s+)?(?:на|до)|прямують?\s+(?:на|до))\s+([А-ЯЁІЇЄҐ][а-яёіїєґ’ʼ’-]+(?:\s+[А-ЯЁІЇЄҐ][а-яёіїєґ’ʼ’-]+)?)/
  );
  return m ? m[1] : null;
}

function detectThreatType(text) {
  // A drone reference wins even if a missile word also appears (mixed posts).
  if (DRONE_RE.test(text)) return 'drone';
  if (AIRCRAFT_RE.test(text)) return 'aircraft';
  if (MISSILE_RE.test(text)) {
    if (/крылат|крилат/i.test(text)) return 'cruise_missile';
    if (/баллист|балістич/i.test(text)) return 'ballistic_missile';
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

// MoD-style recap totals ("over the past night air defense destroyed 216 UAVs
// over the territories of Belgorod, Bryansk … oblasts", "с 8:00 до 14:00 …").
// These are summaries, not specific sightings — don't map them.
function isInterceptionRecap(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const destroyed = /(уничтожен|сбит|перехвач|ликвидир|отражен|destroyed|intercepted|shot down)/.test(t);
  if (!destroyed) return false;
  const m =
    t.match(/(\d{1,4})\s*(?:бпла|дрон\w*|безпілотн\w*|шахед\w*|uav|drone)/) ||
    t.match(/(?:уничтожен\w*|сбит\w*|перехвач\w*|destroyed|intercepted)\D{0,14}(\d{1,4})/);
  const total = m ? parseInt(m[1], 10) : 0;
  const times = (t.match(/\b\d{1,2}[:.]\d{2}\b/g) || []).length;
  const recapPhrase =
    /над\s+территор|over the territ|минобороны|ministry of def|за\s+(минувш|прошедш|истекш|сутки|ночь|вчера|день)|over the past (night|day|24)/.test(t) ||
    times >= 2;
  return total >= 10 && recapPhrase;
}

// Generic / non-mappable "locations" (seas, whole countries, vague terms).
const BLOCKED_LOCATIONS = new Set([
  'russia', 'russian federation', 'ukraine', 'belarus', 'border', 'frontline',
  'unknown', 'various', 'multiple', 'na', 'n/a',
  'россия', 'российская федерация', 'украина', 'беларусь', 'граница', 'неизвестно',
]);
function isBlockedLocation(name) {
  const k = (name || '').toString().toLowerCase().replace(/ё/g, 'е').replace(/[.,"'»«]/g, '').trim();
  if (!k) return true;
  if (BLOCKED_LOCATIONS.has(k)) return true;
  // Water bodies — a "Black Sea" sighting isn't a place on land.
  if (/(^|\s)(море|sea|ocean|океан|залив|gulf|bay)(\s|$)/.test(k)) return true;
  return false;
}

// A real place name is short and capitalised — this rejects free-form prose
// (e.g. "Один за другим пересекают стык ... области") from becoming a location.
function isPlaceLike(c) {
  return /^[А-ЯЁІЇЄҐA-Z]/.test(c) && c.length <= 40 && c.split(/\s+/).length <= 4;
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
  if (!text || (!DRONE_RE.test(text) && !MISSILE_RE.test(text) && !AIRCRAFT_RE.test(text))) return out;
  if (isInterceptionRecap(text)) return out; // a totals recap, not a sighting

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

  // Locations are the remaining, non-region chunks (minus junk like seas).
  let locations = chunks.filter((c) => c !== region && !REGION_RE.test(c)).map(cleanLocation);
  locations = [...new Set(locations.filter((l) => l && !isBlockedLocation(l)))];

  // A region-wide post (no specific town) still maps to the region centroid.
  if (locations.length === 0 && region && !isBlockedLocation(region)) locations = [cleanLocation(region)];
  if (locations.length === 0) return out; // threat post but no locatable place

  // A count alongside several places is ambiguous (usually a total), so only
  // attach it when the post names a single location.
  const perLocationCount = locations.length === 1 ? count : null;
  for (const loc of locations) {
    out.sightings.push({
      location: loc,
      locationRu: loc,
      region: region || '',
      lat: null,
      lon: null,
      threatType,
      count: perLocationCount,
      heading: null,
      destination: destination || null,
      status,
      confidence: 0.55,
    });
  }
  const threatLabel = threatType === 'drone' ? 'Drone' : threatType === 'aircraft' ? 'Aircraft' : 'Missile';
  out.summary = `${threatLabel} activity (${status}) at ${locations.join(', ')}`.slice(0, 300);
  return out;
}

module.exports = {
  analyzePost,
  detectStatus,
  detectCount,
  detectDestination,
  detectThreatType,
  cleanLocation,
  isInterceptionRecap,
  isBlockedLocation,
};
