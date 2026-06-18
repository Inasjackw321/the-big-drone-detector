'use strict';

/**
 * Reads recent posts from a PUBLIC Telegram channel via its web preview at
 * https://t.me/s/<channel>. This needs no Telegram account, bot token or API
 * keys — the preview is public HTML. We parse the stable markup that the
 * Telegram widget emits (`tgme_widget_message` blocks).
 *
 * Parsing is intentionally done with built-in tooling (regex over the known,
 * stable widget markup) so the module has zero runtime dependencies and can be
 * unit-tested offline against a saved sample page.
 */

const PREVIEW_BASE = 'https://t.me/s/';

/** Decode the HTML entities that appear in Telegram preview text. */
function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return _;
      }
    })
    .replace(/&amp;/g, '&');
}

/** Strip HTML tags, turning <br> and block boundaries into newlines. */
function htmlToText(html) {
  if (!html) return '';
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n');
  const noTags = withBreaks.replace(/<[^>]+>/g, '');
  return decodeEntities(noTags)
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
    .trim();
}

/**
 * Extract message blocks from the preview HTML.
 *
 * We anchor on the `data-post="channel/123"` attribute that marks each message
 * container, slicing the document from one anchor to the next. This avoids the
 * trap of splitting on the class name, since many inner elements also use
 * `tgme_widget_message_*` classes.
 *
 * @param {string} html
 * @param {string} channel
 * @returns {Array<{id:string, postId:number, channel:string, link:string, text:string, date:string|null, hasPhoto:boolean}>}
 */
function parsePreviewHtml(html, channel) {
  const messages = [];
  if (!html) return messages;

  const anchorRe = /data-post="([^"]+)"/g;
  const anchors = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    anchors.push({ post: m[1], index: m.index });
  }

  for (let i = 0; i < anchors.length; i++) {
    const { post: dataPost, index } = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const block = html.slice(index, end);

    const postNum = parseInt(dataPost.split('/').pop(), 10);
    if (!Number.isFinite(postNum)) continue;

    // The main message body always carries the `js-message_text` class; this
    // distinguishes it from reply previews and other text-bearing elements.
    let text = '';
    const textMatch = block.match(
      /<div class="[^"]*js-message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
    );
    if (textMatch) text = htmlToText(textMatch[1]);

    // Timestamp from the <time datetime="..."> element.
    const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
    const date = dateMatch ? dateMatch[1] : null;

    const hasPhoto = /tgme_widget_message_photo_wrap|message_video|message_roundvideo/.test(
      block
    );

    if (!text && !hasPhoto) continue; // skip service / empty blocks

    messages.push({
      id: `${channel}/${postNum}`,
      postId: postNum,
      channel,
      link: `https://t.me/${channel}/${postNum}`,
      text,
      date,
      hasPhoto,
    });
  }

  // De-dupe by postId (some blocks repeat for grouped albums), keep ascending.
  const seen = new Map();
  for (const m of messages) {
    if (!seen.has(m.postId)) seen.set(m.postId, m);
    else {
      // Prefer the variant that actually has text.
      const existing = seen.get(m.postId);
      if (!existing.text && m.text) seen.set(m.postId, m);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.postId - b.postId);
}

/**
 * Fetch the latest posts from a public channel.
 * @param {object} opts
 * @param {string} opts.channel  channel username (no @)
 * @param {number} [opts.beforeId] paginate to fetch posts before this id
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl] inject for testing
 * @returns {Promise<Array>}
 */
async function fetchChannelPosts({ channel, beforeId, timeoutMs = 15000, fetchImpl } = {}) {
  if (!channel) throw new Error('telegram: channel is required');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('telegram: no fetch implementation available');
  }

  let url = `${PREVIEW_BASE}${encodeURIComponent(channel)}`;
  if (beforeId) url += `?before=${beforeId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(url, {
      signal: controller.signal,
      headers: {
        // A real browser UA avoids the lightweight bot block that returns 403.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(
      `telegram: HTTP ${res.status} fetching @${channel} (the channel may be private, geo-blocked, or rate-limiting)`
    );
  }
  const html = await res.text();
  return parsePreviewHtml(html, channel);
}

module.exports = {
  PREVIEW_BASE,
  parsePreviewHtml,
  fetchChannelPosts,
  htmlToText,
  decodeEntities,
};
