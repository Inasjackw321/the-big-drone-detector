'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  parsePreviewHtml,
  htmlToText,
  fetchChannelPosts,
} = require('../src/services/telegram');

const sampleHtml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'sample-telegram.html'),
  'utf8'
);

test('parses all messages from preview HTML', () => {
  const msgs = parsePreviewHtml(sampleHtml, 'radarrussiia');
  assert.equal(msgs.length, 3);
  assert.deepEqual(
    msgs.map((m) => m.postId),
    [76241, 76242, 76243]
  );
});

test('extracts decoded Cyrillic text and links', () => {
  const msgs = parsePreviewHtml(sampleHtml, 'radarrussiia');
  const second = msgs.find((m) => m.postId === 76242);
  assert.match(second.text, /Воронеж/);
  assert.match(second.text, /БпЛА/);
  // <br/> should become a newline.
  assert.match(second.text, /\n/);
  assert.equal(second.link, 'https://t.me/radarrussiia/76242');
  assert.equal(second.channel, 'radarrussiia');
});

test('captures timestamps and photo flag', () => {
  const msgs = parsePreviewHtml(sampleHtml, 'radarrussiia');
  const third = msgs.find((m) => m.postId === 76243);
  assert.equal(third.date, '2026-06-18T10:00:00+00:00');
  assert.equal(third.hasPhoto, true);
  assert.equal(msgs[0].hasPhoto, false);
});

test('messages are sorted ascending by id', () => {
  const msgs = parsePreviewHtml(sampleHtml, 'radarrussiia');
  for (let i = 1; i < msgs.length; i++) {
    assert.ok(msgs[i].postId > msgs[i - 1].postId);
  }
});

test('htmlToText strips tags and decodes entities', () => {
  const out = htmlToText('Hello&nbsp;<b>world</b><br/>line2 &amp; more');
  assert.equal(out, 'Hello world\nline2 & more');
});

test('parser is resilient to empty / garbage input', () => {
  assert.deepEqual(parsePreviewHtml('', 'x'), []);
  assert.deepEqual(parsePreviewHtml('<html>no messages</html>', 'x'), []);
});

test('fetchChannelPosts uses injected fetch and browser UA', async () => {
  let calledUrl = null;
  let calledHeaders = null;
  const fakeFetch = async (url, opts) => {
    calledUrl = url;
    calledHeaders = opts.headers;
    return { ok: true, status: 200, text: async () => sampleHtml };
  };
  const posts = await fetchChannelPosts({
    channel: 'radarrussiia',
    fetchImpl: fakeFetch,
  });
  assert.equal(posts.length, 3);
  assert.match(calledUrl, /t\.me\/s\/radarrussiia/);
  assert.match(calledHeaders['User-Agent'], /Mozilla/);
});

test('fetchChannelPosts throws a helpful error on non-200', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, text: async () => '' });
  await assert.rejects(
    () => fetchChannelPosts({ channel: 'x', fetchImpl: fakeFetch }),
    /HTTP 403/
  );
});
