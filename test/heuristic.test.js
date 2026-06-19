'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  analyzePost,
  detectStatus,
  detectCount,
  detectDestination,
  cleanLocation,
} = require('../src/services/heuristic');

const FOOTER = '\n\n❗️Радар по всей России - @radarrussiia\n🌐 Обход белых списков - @Internet_Boost_bot';

test('parses the standard block format with count', () => {
  const r = analyzePost('Медынский район\nКалужская область\nФиксация от 5 БПЛА' + FOOTER);
  assert.equal(r.isRelevant, true);
  assert.equal(r.sightings.length, 1);
  const s = r.sightings[0];
  assert.equal(s.location, 'Медынский район');
  assert.equal(s.region, 'Калужская область');
  assert.equal(s.count, 5);
  assert.equal(s.status, 'approaching');
  assert.equal(s.threatType, 'drone');
});

test('strips МО/ГО administrative prefixes from the location', () => {
  const r = analyzePost('ГО Бронницы\nМосковская область\nРабота ПВО по БПЛА' + FOOTER);
  assert.equal(r.sightings[0].location, 'Бронницы');
  assert.equal(r.sightings[0].status, 'overhead');
});

test('maps Сбитие to shot_down and Отбой to all_clear', () => {
  assert.equal(detectStatus('Сбитие БПЛА'), 'shot_down');
  assert.equal(detectStatus('Отбой опасности по БПЛА'), 'all_clear');
});

test('parses inline multi-location danger posts', () => {
  const r = analyzePost(
    'Павловский Посад, Орехово-Зуево, Ногинск, Московская область - опасность по БПЛА, повторно.' + FOOTER
  );
  assert.equal(r.isRelevant, true);
  const names = r.sightings.map((s) => s.location);
  assert.deepEqual(names, ['Павловский Посад', 'Орехово-Зуево', 'Ногинск']);
  assert.ok(r.sightings.every((s) => s.region === 'Московская область'));
  assert.ok(r.sightings.every((s) => s.status === 'alert'));
});

test('extracts a destination from "в сторону X"', () => {
  const r = analyzePost(
    'Жуковский район, Калужская область - ещё фиксации БПЛА в сторону Чехов.' + FOOTER
  );
  assert.equal(r.sightings[0].destination, 'Чехов');
  assert.equal(r.sightings[0].status, 'approaching');
});

test('does NOT treat the tail of a word like "Коломна" as a destination', () => {
  const r = analyzePost('ГО Коломна\nМосковская область\nРабота ПВО по БПЛА' + FOOTER);
  assert.equal(r.sightings[0].destination, null);
});

test('free-form prose is relevant but yields no fake location', () => {
  const r = analyzePost(
    'Очень много БПЛА продолжают лететь на Москву.\n\nОдин за другим пересекают стык Московской и Тульской области.' + FOOTER
  );
  assert.equal(r.isRelevant, true);
  assert.equal(r.sightings.length, 0);
});

test('does not attach a count to multi-location posts (likely a total)', () => {
  const r = analyzePost('Чехов, Серпухов, Коломна, Московская область - фіксація 6 БПЛА.' + FOOTER);
  assert.ok(r.sightings.length >= 2);
  assert.ok(r.sightings.every((s) => s.count === null));
});

test('region-only post maps to the region', () => {
  const r = analyzePost('Ростовская область\nОтбой опасности по БПЛА' + FOOTER);
  assert.equal(r.sightings.length, 1);
  assert.equal(r.sightings[0].location, 'Ростовская область');
  assert.equal(r.sightings[0].status, 'all_clear');
});

test('non-threat posts are not relevant', () => {
  assert.equal(analyzePost('Сегодня хорошая погода, подписывайтесь на канал.').isRelevant, false);
  assert.equal(analyzePost('').isRelevant, false);
});

test('detectCount handles "от N" and bare "N БПЛА"', () => {
  assert.equal(detectCount('От 20 БПЛА через Тульскую область'), 20);
  assert.equal(detectCount('Фиксация от 5 БПЛА'), 5);
  assert.equal(detectCount('3 дрона над городом'), 3);
  assert.equal(detectCount('Работа ПВО по БПЛА'), null);
});

test('cleanLocation removes prefixes but keeps district names', () => {
  assert.equal(cleanLocation('МО Раменское'), 'Раменское');
  assert.equal(cleanLocation('Жуковский район'), 'Жуковский район');
});

// --- Ukrainian (kpszsu) support ---

test('maps Ukrainian status wording', () => {
  assert.equal(detectStatus('Збито 12 ворожих шахедів'), 'shot_down');
  assert.equal(detectStatus('Відбій повітряної тривоги'), 'all_clear');
  assert.equal(detectStatus('Загроза застосування ударних БпЛА'), 'alert'); // "ударних" must NOT be impact
  assert.equal(detectStatus('БпЛА курсом на Дніпро'), 'approaching');
  assert.equal(detectStatus('Зафіксовано приліт у місті'), 'impact');
});

test('extracts a Ukrainian destination after "курсом на"', () => {
  assert.equal(detectDestination('БпЛА курсом на Дніпро'), 'Дніпро');
  assert.equal(detectDestination('Шахеди у напрямку Києва'), 'Києва');
});

test('recognises Shahed posts as drone activity', () => {
  const r = analyzePost('Харківська область — загроза застосування ударних БпЛА.');
  assert.equal(r.isRelevant, true);
  assert.equal(r.sightings[0].threatType, 'drone');
  assert.equal(r.sightings[0].region, 'Харківська область');
  assert.equal(r.sightings[0].status, 'alert');
});
