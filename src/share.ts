// Sharing a game outside HearthCade: the link card other sites show (Open Graph, with the live player count), the
// embeddable game card for blogs and wikis (/embed/:slug, the only page any site may frame), and oEmbed so sites that
// understand it (WordPress, Notion, Discourse and others) turn a pasted game link into that card by themselves.
// Pure functions over a game row; src/index.ts serves them. Tested in tests/share.mjs.
//
// Rules: the embed never plays the game inside another site. Sign-in, buying and the play clock all depend on the
// platform's own first-party page, so Play opens the game on HearthCade in a new tab. An adults-only game shows no cover
// and no description anywhere outside the platform.

export interface ShareGame {
  slug: string; title: string; tagline: string | null; author: string; author_id: string; price_cents: number;
  rating_sum: number; rating_count: number; cover: string | null; age: number | null; playing: number; plays: number;
}

export const EMBED = { width: 480, height: 300, min_width: 280 };

const h = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const adult = (g: ShareGame) => (g.age || 0) >= 18;
const rating = (g: ShareGame) => (g.rating_count > 0 ? Math.round((g.rating_sum / g.rating_count) * 10) / 10 : null);
const nf = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

/** The one-line facts a link card shows after the tagline: players now, rating, price. */
export function shareFacts(g: ShareGame): string {
  const r = rating(g);
  return [
    g.playing > 0 ? `${nf(g.playing)} playing now` : g.plays > 0 ? `${nf(g.plays)} plays` : '',
    r ? `★ ${r.toFixed(1)} (${nf(g.rating_count)})` : '',
    g.price_cents > 0 ? `$${(g.price_cents / 100).toFixed(2)}` : 'Free',
    `by ${g.author}`,
  ].filter(Boolean).join(' · ');
}

/** The link card's description: the tagline (left out for adults-only games), then the facts. */
export function shareDescription(g: ShareGame, brand: string): string {
  const lead = !adult(g) && g.tagline ? g.tagline : `${g.title}, a web game on ${brand}.`;
  return `${/[.!?。！？…]$/.test(lead.trim()) ? lead.trim() : lead.trim() + '.'} ${shareFacts(g)}. Play in your browser, nothing to install.`;
}

/** oEmbed maxwidth and maxheight are limits: the card is 480x300 and shrinks to fit them (never below 280 wide). */
export function embedSize(maxwidth?: unknown, maxheight?: unknown) {
  const mw = Number(maxwidth), mh = Number(maxheight);
  const width = Number.isFinite(mw) && mw > 0 ? Math.max(EMBED.min_width, Math.min(EMBED.width, Math.floor(mw))) : EMBED.width;
  let height = Math.round(width * (EMBED.height / EMBED.width));
  if (Number.isFinite(mh) && mh > 0 && mh < height) height = Math.max(180, Math.floor(mh));
  return { width, height };
}

/** The iframe code a creator or player pastes into another site. */
export function embedCode(origin: string, g: Pick<ShareGame, 'slug' | 'title'>, size = { width: EMBED.width, height: EMBED.height }): string {
  return `<iframe src="${h(origin)}/embed/${encodeURIComponent(g.slug)}" width="${size.width}" height="${size.height}" title="${h(g.title)} on HearthCade" style="border:0;border-radius:12px;max-width:100%" loading="lazy" allow="web-share"></iframe>`;
}

/** The game's page URL a game link resolves to, for oEmbed: /g/<slug> or /embed/<slug> on this origin, else null. */
export function slugFromUrl(origin: string, raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const o = new URL(origin);
  const host = (x: string) => x.replace(/^www\./, '');
  if (host(u.hostname) !== host(o.hostname)) return null;
  const m = u.pathname.match(/^\/(?:g|embed)\/([^/]+)\/?$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** oEmbed 1.0 "rich" answer for a game link. */
export function oembed(origin: string, brand: string, g: ShareGame, size: { width: number; height: number }) {
  return {
    version: '1.0', type: 'rich', provider_name: brand, provider_url: origin + '/',
    title: g.title, author_name: g.author, author_url: `${origin}/creator/${encodeURIComponent(g.author_id)}`,
    ...(g.cover && !adult(g) ? { thumbnail_url: g.cover, thumbnail_width: 1920, thumbnail_height: 1080 } : {}),
    html: embedCode(origin, g, size), width: size.width, height: size.height, cache_age: 3600,
  };
}

const WORDS: Record<string, Record<string, string>> = {
  en: { play: 'Play', playing: 'playing now', plays: 'plays', free: 'Free', by: 'by', adult: 'For adults only. Open it on HearthCade to see more.', on: 'Plays in your browser on' },
  zh: { play: '开始游戏', playing: '人正在玩', plays: '次游玩', free: '免费', by: '作者', adult: '仅限成人。请在 HearthCade 打开查看。', on: '在浏览器中游玩，来自' },
  'zh-TW': { play: '開始遊戲', playing: '人正在玩', plays: '次遊玩', free: '免費', by: '作者', adult: '僅限成人。請在 HearthCade 開啟查看。', on: '在瀏覽器中遊玩，來自' },
  ja: { play: 'プレイ', playing: '人がプレイ中', plays: '回プレイ', free: '無料', by: '作者', adult: '成人向けです。HearthCade で開いてご覧ください。', on: 'ブラウザで遊べます：' },
  ko: { play: '플레이', playing: '명 플레이 중', plays: '회 플레이', free: '무료', by: '제작', adult: '성인 전용입니다. HearthCade에서 열어 보세요.', on: '브라우저에서 플레이:' },
  es: { play: 'Jugar', playing: 'jugando ahora', plays: 'partidas', free: 'Gratis', by: 'de', adult: 'Solo para adultos. Ábrelo en HearthCade para ver más.', on: 'Se juega en el navegador en' },
};

/** The language the embed is shown in: ?lang=, else the visitor's browser languages, else English. */
export function embedLang(query: string | null | undefined, acceptLanguage: string | null | undefined): string {
  const pick = (l: string) => {
    const x = l.trim().toLowerCase();
    if (x === 'zh-tw' || x === 'zh-hk' || x === 'zh-hant') return 'zh-TW';
    const base = x.split('-')[0];
    return base === 'zh' ? 'zh' : WORDS[base] ? base : null;
  };
  if (query) { const q = pick(query); if (q) return q; }
  for (const part of String(acceptLanguage || '').split(',')) { const l = pick(part.split(';')[0]); if (l) return l; }
  return 'en';
}

/** The embeddable game card: a self-contained page with no script, framed by any site. */
export function embedHtml(origin: string, brand: string, g: ShareGame, lang = 'en', ref = 'embed'): string {
  const w = WORDS[lang] || WORDS.en, r = rating(g), playUrl = `${origin}/g/${encodeURIComponent(g.slug)}?play=1&ref=${encodeURIComponent(ref)}`;
  const pageUrl = `${origin}/g/${encodeURIComponent(g.slug)}?ref=${encodeURIComponent(ref)}`;
  const count = g.playing > 0 ? `<span class="live"><i></i>${h(nf(g.playing))} ${h(w.playing)}</span>` : g.plays > 0 ? `<span>${h(nf(g.plays))} ${h(w.plays)}</span>` : '';
  const facts = [count, r ? `<span>★ ${r.toFixed(1)}</span>` : '', `<span>${g.price_cents > 0 ? `$${(g.price_cents / 100).toFixed(2)}` : h(w.free)}</span>`].filter(Boolean).join('');
  const art = adult(g) || !g.cover ? `<div class="art none">${adult(g) ? '<b>18+</b>' : ''}</div>` : `<img class="art" src="${h(g.cover)}" alt="" loading="lazy">`;
  return `<!doctype html><html lang="${h(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(g.title)} · ${h(brand)}</title><meta name="robots" content="noindex">
<style>
:root{--bg:#fbf8f3;--fg:#17131a;--mute:#6b6470;--line:#e6dfd5;--accent:#e8243c;--good:#1d9a5b}
@media (prefers-color-scheme:dark){:root{--bg:#17131a;--fg:#f4efe8;--mute:#a69fab;--line:#2f2833}}
*{box-sizing:border-box;margin:0}html,body{height:100%}
body{background:var(--bg);color:var(--fg);font:14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}
a{color:inherit;text-decoration:none}
.card{position:relative;display:flex;flex-direction:column;height:100%;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.art{display:block;width:100%;flex:1;min-height:0;object-fit:cover;background:#2a2230}
.art.none{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3a2140,#17131a);color:#fff;font-size:28px}
.bar{display:flex;align-items:center;gap:12px;padding:10px 12px}
.txt{flex:1;min-width:0}
.t{font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m{color:var(--mute);font-size:12px;display:flex;gap:10px;flex-wrap:wrap;margin-top:2px}
.live{color:var(--good)}.live i{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--good);margin-right:5px;vertical-align:1px}
.play{flex:none;background:var(--accent);color:#fff;font-weight:700;border-radius:8px;padding:9px 16px;letter-spacing:.02em}
.play:hover{filter:brightness(1.08)}.play:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.by{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.62);color:#fff;font-size:11px;border-radius:6px;padding:3px 7px;max-width:calc(100% - 16px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.note{color:var(--mute);font-size:12px;padding:0 12px 10px}
</style></head><body>
<div class="card">
<a href="${h(pageUrl)}" target="_blank" rel="noopener" aria-label="${h(g.title)}" style="display:flex;flex:1;min-height:0">${art}</a>
<span class="by">${h(w.on)} ${h(brand)} · ${h(w.by)} ${h(g.author)}</span>
<div class="bar"><div class="txt"><a class="t" href="${h(pageUrl)}" target="_blank" rel="noopener">${h(g.title)}</a><div class="m">${facts}</div></div>
<a class="play" href="${h(playUrl)}" target="_blank" rel="noopener">${h(w.play)}</a></div>
${adult(g) ? `<p class="note">${h(w.adult)}</p>` : ''}
</div></body></html>`;
}
