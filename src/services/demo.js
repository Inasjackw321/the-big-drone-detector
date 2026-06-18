'use strict';

/**
 * Demo mode: a set of realistic (Russian) Telegram-style posts plus a mock LLM
 * that returns the structured extraction for each. This lets the FULL pipeline
 * (fetch -> extract -> geocode -> store -> map) run with no network and no API
 * key, so the app is demonstrably working out of the box. Geocoding still goes
 * through the real offline gazetteer.
 */

function isoMinutesAgo(mins) {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

const DEMO_POSTS = [
  {
    postId: 90001,
    text:
      'Внимание! БпЛА курсом на Воронеж со стороны Лиски. Объявлена опасность атаки беспилотников.',
    extraction: {
      isRelevant: true,
      summary: 'UAV heading towards Voronezh from the south-east.',
      sightings: [
        {
          location: 'Voronezh', locationRu: 'Воронеж', region: 'Voronezh Oblast',
          lat: null, lon: null, threatType: 'drone', count: null,
          heading: 'towards Voronezh', status: 'approaching', confidence: 0.9,
        },
      ],
    },
  },
  {
    postId: 90002,
    text: 'Белгород и Шебекино — работает ПВО. Слышны взрывы в небе.',
    extraction: {
      isRelevant: true,
      summary: 'Air defense active over Belgorod and Shebekino.',
      sightings: [
        {
          location: 'Belgorod', locationRu: 'Белгород', region: 'Belgorod Oblast',
          lat: null, lon: null, threatType: 'air_defense', count: null,
          heading: null, status: 'overhead', confidence: 0.85,
        },
        {
          location: 'Shebekino', locationRu: 'Шебекино', region: 'Belgorod Oblast',
          lat: null, lon: null, threatType: 'air_defense', count: null,
          heading: null, status: 'overhead', confidence: 0.8,
        },
      ],
    },
  },
  {
    postId: 90003,
    text:
      'Несколько БпЛА зафиксированы над Краснодарским краем, курс на НПЗ в Славянске-на-Кубани. Не менее 4 целей.',
    extraction: {
      isRelevant: true,
      summary: 'At least 4 UAVs over Krasnodar Krai heading to Slavyansk-na-Kubani refinery.',
      sightings: [
        {
          location: 'Slavyansk-na-Kubani', locationRu: 'Славянск-на-Кубани',
          region: 'Krasnodar Krai', lat: null, lon: null, threatType: 'drone',
          count: 4, heading: 'towards refinery', status: 'approaching', confidence: 0.88,
        },
      ],
    },
  },
  {
    postId: 90004,
    text: 'Энгельс (Саратовская область): сообщают о работе ПВО и взрывах рядом с аэродромом.',
    extraction: {
      isRelevant: true,
      summary: 'Air defense and explosions reported near Engels airfield.',
      sightings: [
        {
          location: 'Engels', locationRu: 'Энгельс', region: 'Saratov Oblast',
          lat: null, lon: null, threatType: 'explosion', count: null,
          heading: null, status: 'impact', confidence: 0.82,
        },
      ],
    },
  },
  {
    postId: 90005,
    text:
      'Ростовская область: БпЛА сбит над Таганрогом силами ПВО. Также цели в районе Морозовска.',
    extraction: {
      isRelevant: true,
      summary: 'UAV shot down over Taganrog; more near Morozovsk.',
      sightings: [
        {
          location: 'Taganrog', locationRu: 'Таганрог', region: 'Rostov Oblast',
          lat: null, lon: null, threatType: 'drone', count: 1,
          heading: null, status: 'shot_down', confidence: 0.9,
        },
        {
          location: 'Morozovsk', locationRu: 'Морозовск', region: 'Rostov Oblast',
          lat: null, lon: null, threatType: 'drone', count: null,
          heading: null, status: 'approaching', confidence: 0.7,
        },
      ],
    },
  },
  {
    postId: 90006,
    text: 'Москва и область — закрыт аэропорт, объявлен план «Ковёр». Угроза БпЛА.',
    extraction: {
      isRelevant: true,
      summary: 'Moscow region airspace restricted due to UAV threat.',
      sightings: [
        {
          location: 'Moscow', locationRu: 'Москва', region: 'Moscow',
          lat: null, lon: null, threatType: 'drone', count: null,
          heading: null, status: 'alert', confidence: 0.75,
        },
      ],
    },
  },
  {
    postId: 90007,
    text: 'Татарстан: БпЛА большой дальности замечены в районе Елабуги (ОЭЗ Алабуга).',
    extraction: {
      isRelevant: true,
      summary: 'Long-range UAVs near Yelabuga (Alabuga SEZ).',
      sightings: [
        {
          location: 'Yelabuga', locationRu: 'Елабуга', region: 'Tatarstan',
          lat: null, lon: null, threatType: 'drone', count: 2,
          heading: 'north-east', status: 'approaching', confidence: 0.78,
        },
      ],
    },
  },
  {
    postId: 90008,
    text: 'Реклама нашего канала — подписывайтесь! Скидки на VPN.',
    extraction: { isRelevant: false, summary: 'Channel advertisement.', sightings: [] },
  },
];

/** Build posts with timestamps spread over the last hour (most recent last). */
function demoPosts(channel = 'radarrussiia') {
  const n = DEMO_POSTS.length;
  return DEMO_POSTS.map((p, i) => ({
    id: `${channel}/${p.postId}`,
    postId: p.postId,
    channel,
    link: `https://t.me/${channel}/${p.postId}`,
    text: p.text,
    date: isoMinutesAgo((n - i) * 7),
    hasPhoto: false,
  }));
}

/** A fetchPosts() drop-in for the pipeline. */
async function demoFetchPosts({ channel } = {}) {
  return demoPosts(channel);
}

/** A mock OpenRouter client returning the baked extraction for each post. */
class DemoLlmClient {
  constructor() {
    this.model = 'demo/owl-alpha';
    this._byId = new Map(DEMO_POSTS.map((p) => [p.postId, p.extraction]));
  }

  async extractSightings(post) {
    // Simulate a little latency so the UI animates.
    await new Promise((r) => setTimeout(r, 80));
    const e = this._byId.get(post.postId);
    return e || { isRelevant: false, summary: '', sightings: [] };
  }

  async ping() {
    return true;
  }
}

module.exports = { DEMO_POSTS, demoPosts, demoFetchPosts, DemoLlmClient };
