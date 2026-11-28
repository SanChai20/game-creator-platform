// Sharing outside the platform (src/share.ts): the link card's facts, the embed card (escaped, no script, nothing of an
// adults-only game), oEmbed answers only for this site's game links, and embed sizes stay within the limits asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const S = await import('../src/share.ts');
const O = 'https://hearthcade.test';
const G = { slug: 'star-hop', title: 'Star <Hop>', tagline: 'Jump between stars.', author: 'Ada', author_id: 'u1', price_cents: 0, rating_sum: 46, rating_count: 10, cover: `${O}/api/media/c.png`, age: null, playing: 12, plays: 3400 };

test('the link card says who is playing, the rating and the price', () => {
  assert.equal(S.shareFacts(G), '12 playing now · ★ 4.6 (10) · Free · by Ada');
  assert.equal(S.shareFacts({ ...G, playing: 0, rating_count: 0, price_cents: 499 }), '3.4k plays · $4.99 · by Ada');
  assert.match(S.shareDescription(G, 'HearthCade'), /^Jump between stars\. 12 playing now/);
  assert.doesNotMatch(S.shareDescription({ ...G, age: 18 }, 'HearthCade'), /Jump between/);
});

test('the embed card is escaped, has no script and opens the game on the platform', () => {
  const html = S.embedHtml(O, 'HearthCade', G, 'en');
  assert.ok(html.includes('Star &#60;Hop&#62;'));
  assert.doesNotMatch(html, /<script/i);
  assert.ok(html.includes(`${O}/g/star-hop?play=1&#38;ref=embed`));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('12 playing now'));
  const adult = S.embedHtml(O, 'HearthCade', { ...G, age: 18 }, 'en');
  assert.doesNotMatch(adult, /c\.png/);
  assert.match(adult, /For adults only/);
  assert.match(S.embedHtml(O, 'HearthCade', G, 'ja'), /プレイ/);
});

test('embed language: the query, then the browser, then English', () => {
  assert.equal(S.embedLang('es', 'ja'), 'es');
  assert.equal(S.embedLang(null, 'zh-TW,zh;q=0.9'), 'zh-TW');
  assert.equal(S.embedLang(null, 'zh-CN'), 'zh');
  assert.equal(S.embedLang('xx', 'de-DE,ko;q=0.5'), 'ko');
  assert.equal(S.embedLang(undefined, undefined), 'en');
});

test('oEmbed answers only for this site\'s game links, within the size asked', () => {
  assert.equal(S.slugFromUrl(O, `${O}/g/star-hop`), 'star-hop');
  assert.equal(S.slugFromUrl(O, 'https://www.hearthcade.test/embed/star-hop/'), 'star-hop');
  assert.equal(S.slugFromUrl(O, 'https://evil.test/g/star-hop'), null);
  assert.equal(S.slugFromUrl(O, `${O}/creator/u1`), null);
  assert.equal(S.slugFromUrl(O, 'not a url'), null);
  assert.deepEqual(S.embedSize(), { width: 480, height: 300 });
  assert.deepEqual(S.embedSize(320), { width: 320, height: 200 });
  assert.deepEqual(S.embedSize(2000, 250), { width: 480, height: 250 });
  assert.deepEqual(S.embedSize(100), { width: 280, height: 175 });
  const o = S.oembed(O, 'HearthCade', G, S.embedSize(400));
  assert.equal(o.type, 'rich'); assert.equal(o.width, 400);
  assert.match(o.html, /^<iframe src="https:\/\/hearthcade\.test\/embed\/star-hop" width="400"/);
  assert.equal(S.oembed(O, 'HearthCade', { ...G, age: 18 }, S.embedSize()).thumbnail_url, undefined);
});
