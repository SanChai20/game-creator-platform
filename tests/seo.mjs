// Being found (src/seo.ts): crawlers, AI ones included, are welcome on public pages and kept off personal ones; the
// sitemap lists only public pages; llms.txt states the platform's facts; pages carry valid JSON-LD that cannot break out
// of its script tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const S = await import('../src/seo.ts');
const O = 'https://hearthcade.test';

test('robots.txt welcomes crawlers and keeps them off personal pages', () => {
  const r = S.robotsTxt(O);
  for (const a of ['*', 'GPTBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot', 'CCBot']) assert.match(r, new RegExp(`^User-agent: ${a.replace('*', '\\*')}$`, 'm'));
  assert.match(r, /^Allow: \/$/m);
  for (const p of ['/account', '/library', '/purchases', '/console', '/admin', '/api', '/mcp', '/authorize', '/device', '/verify', '/login']) assert.match(r, new RegExp(`^Disallow: ${p}$`, 'm'), p);
  assert.doesNotMatch(r, /^Disallow: \/$/m);
  assert.match(r, /^Sitemap: https:\/\/hearthcade\.test\/sitemap\.xml$/m);
  // one group: every User-agent line comes before the rules, so each named crawler gets the same rules as *
  const lines = r.split('\n').filter((l) => /^(User-agent|Allow|Disallow):/.test(l)), firstRule = lines.findIndex((l) => !l.startsWith('User-agent'));
  assert.ok(lines.slice(firstRule).every((l) => !l.startsWith('User-agent')));
});

test('personal pages are private; public ones are not', () => {
  for (const p of ['/account', '/library', '/purchases', '/console', '/console/p/abc', '/admin/users', '/api/me', '/verify', '/device', '/login', '/authorize']) assert.ok(S.isPrivatePath(p), p);
  for (const p of ['/', '/g/fun', '/browse', '/categories', '/c/puzzle', '/creator-store', '/creator-store/fun', '/docs', '/create', '/llms.txt', '/accounts-help', '/legal/privacy']) assert.ok(!S.isPrivatePath(p), p);
});

test('the sitemap lists public pages once, escaped, and never a private one', () => {
  const x = S.sitemapXml(O, [{ path: '/', priority: 1 }, { path: '/g/a&b', lastmod: Date.UTC(2026, 10, 1) }, { path: '/g/a&b' }, { path: '/account' }, { path: '/library' }]);
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal((x.match(/<url>/g) || []).length, 2);
  assert.match(x, /<loc>https:\/\/hearthcade\.test\/g\/a&amp;b<\/loc><lastmod>2026-11-01<\/lastmod>/);
  assert.doesNotMatch(x, /account|library/);
});

test('llms.txt follows the format and states the facts', () => {
  const t = S.llmsTxt({ brand: 'HearthCade', origin: O, games: 12, creators: 5, licenseTermCents: 1000, licenseTermDays: 365, licenseLifetimeCents: 5000, feePercent: 10, feeOpenPercent: 5 },
    [{ slug: 'star-run', title: 'Star Run', tagline: 'Run between stars', genre: 'action', price_cents: 0, author: 'Ann', plays: 9 }]);
  assert.match(t, /^# HearthCade\n\n> /);
  assert.match(t, /^## Docs$/m); assert.match(t, /^## Games$/m); assert.match(t, /^## Optional$/m);
  assert.match(t, /\[Star Run\]\(https:\/\/hearthcade\.test\/g\/star-run\): Run between stars \(action, free, by Ann\)/);
  assert.match(t, /\$10 for 365 days or \$50 for life/);
  assert.match(t, /https:\/\/hearthcade\.test\/mcp/);
  for (const [f] of S.GUIDES) assert.ok(existsSync(new URL(`../web/public/guides/${f}`, import.meta.url)), `guide ${f} exists`);
});

const INDEX = '<!doctype html><html><head><title>HearthCade</title>\n<meta name="description" content="old"></head><body><div id="root"></div></body></html>';

test('a game page carries the game: title, description, Open Graph, VideoGame JSON-LD and a summary', () => {
  const m = S.gamePage(O, 'HearthCade', { slug: 'star-run', title: 'Star </script><b>Run', tagline: 'Run "between" stars', description: 'Long text.', genre: 'action', tags: ['space', 'pixel-art'], price_cents: 499, author: 'Ann',
    rating_sum: 9, rating_count: 2, cover: `${O}/api/media/c.png`, age: 12, published_at: Date.UTC(2026, 0, 2), updated_at: null, plays: 3, multiplayer: true });
  const out = S.injectMeta(INDEX, O, m);
  assert.match(out, /<title>Star &#60;\/script&#62;&#60;b&#62;Run: play in your browser \| HearthCade<\/title>/);
  assert.match(out, /<meta name="description" content="Run &#34;between&#34; stars">/);
  assert.match(out, /<link rel="canonical" href="https:\/\/hearthcade\.test\/g\/star-run">/);
  assert.match(out, /<meta property="og:image" content="https:\/\/hearthcade\.test\/api\/media\/c\.png">/);
  assert.equal((out.match(/<\/script>/g) || []).length, (out.match(/<script/g) || []).length, 'nothing closes a script tag early');
  const lds = [...out.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((x) => JSON.parse(x[1]));
  const g = lds.find((j) => j['@type'] === 'VideoGame');
  assert.equal(g.name, 'Star </script><b>Run');
  assert.deepEqual(g.offers, { '@type': 'Offer', price: '4.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: `${O}/g/star-run` });
  assert.deepEqual(g.aggregateRating, { '@type': 'AggregateRating', ratingValue: 4.5, ratingCount: 2, bestRating: 5, worstRating: 1 });
  assert.equal(g.contentRating, '12+'); assert.deepEqual(g.playMode, ['SinglePlayer', 'MultiPlayer']);
  assert.ok(lds.some((j) => j['@type'] === 'BreadcrumbList'));
  assert.match(out, /<noscript><article><h1>Star &#60;\/script&#62;&#60;b&#62;Run<\/h1>/);
});

test('a private page is marked noindex and carries nothing else', () => {
  const out = S.injectMeta(INDEX, O, { title: 'HearthCade', description: 'x', path: '/account', noindex: true, noscript: '<p>secret</p>' });
  assert.match(out, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(out, /canonical|ld\+json|secret|og:/);
});

test('the site JSON-LD names the site, its search and its operator', () => {
  const [site, org] = S.siteJsonLd(O, 'HearthCade', { name: 'Horylo LLC', url: 'https://horylo.com' });
  assert.equal(site['@type'], 'WebSite'); assert.equal(site.potentialAction.target.urlTemplate, `${O}/browse?q={search_term_string}`);
  assert.equal(org.parentOrganization.name, 'Horylo LLC');
  assert.ok(existsSync(new URL('../web/public/icons/icon-512.png', import.meta.url)));
});

test('the service worker never keeps the crawler files or the sign-up link page', () => {
  const sw = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8'), NEVER = eval(sw.match(/const NEVER = (\/.*\/);/)[1]);
  for (const p of ['/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt', '/verify', '/api/me']) assert.ok(NEVER.test(p), p);
  assert.ok(!NEVER.test('/g/fun'));
});
