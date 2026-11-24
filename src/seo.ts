// Being found: search engines and AI crawlers (for search and for model training) are welcome on every public page,
// and kept away from every page that is about one person.
//
// - /robots.txt allows all crawlers, AI ones named too, everywhere public, and disallows the signed-in and personal
//   pages, the API, sign-in, agent approval and MCP. Those pages also answer with X-Robots-Tag: noindex and a robots
//   meta tag, and need a sign-in for anything personal anyway (the API refuses without one).
// - /sitemap.xml lists the public pages: the store, categories, live games, the Creator Store, the docs and guides.
// - /llms.txt (llmstxt.org) is the platform in plain words with links to the Markdown guides; /llms-full.txt adds the
//   guides' full text, so an agent gets everything in one fetch.
// - Every public page carries a description, a canonical address, Open Graph tags and schema.org JSON-LD, and a game's
//   page carries the game itself (VideoGame), all in the HTML the server sends, since most crawlers do not run scripts.
//   A <noscript> summary of the page repeats what the app shows, for the same reason.
//
// Pure functions: the Worker (src/index.ts) feeds them rows, tests/seo.mjs checks them.

/** Pages that are about one person or one sign-in, or are machinery: never crawled, never indexed. */
export const PRIVATE_PREFIXES = ['/account', '/library', '/purchases', '/license', '/console', '/admin', '/claim-admin', '/device', '/verify', '/login', '/signup', '/forgot', '/reset', '/authorize', '/oauth', '/api', '/mcp', '/__game', '/offline'];
export const isPrivatePath = (path: string) => PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));

/** Crawlers named so it is plain they are welcome (the * group already lets everyone in). */
export const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'Google-Extended', 'Googlebot', 'Bingbot', 'PerplexityBot', 'Perplexity-User', 'Applebot', 'Applebot-Extended', 'CCBot', 'meta-externalagent', 'Amazonbot', 'DuckAssistBot', 'MistralAI-User', 'cohere-ai', 'Bytespider', 'YouBot'];

export function robotsTxt(origin: string): string {
  return [
    '# HearthCade: web games made with AI agents, playable in any browser.',
    '# Search engines and AI crawlers are welcome to read, index and train on every public page: the store, game pages,',
    '# categories, the Creator Store, the docs and the guides. Start with /llms.txt for a summary written for models.',
    '# Signed-in and personal pages, sign-in, agent approval and the API are off limits.',
    '',
    ...['*', ...AI_CRAWLERS].map((a) => `User-agent: ${a}`),
    'Allow: /',
    ...PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

const xml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export interface SitemapEntry { path: string; lastmod?: number | null; priority?: number; changefreq?: 'daily' | 'weekly' | 'monthly' }
export function sitemapXml(origin: string, entries: SitemapEntry[]): string {
  const seen = new Set<string>();
  const rows = entries.filter((e) => !isPrivatePath(e.path) && !seen.has(e.path) && seen.add(e.path)).map((e) =>
    `<url><loc>${xml(origin + e.path)}</loc>${e.lastmod ? `<lastmod>${new Date(e.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}${e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : ''}${e.priority != null ? `<priority>${e.priority.toFixed(1)}</priority>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

/** The guides an agent can read, in the order a newcomer needs them. */
export const GUIDES: [string, string][] = [
  ['about.md', 'What HearthCade is, who it is for, what it costs, and how it compares: the facts in one page'],
  ['platform-contract.md', 'The contract every game follows: six rules, and how a version goes live'],
  ['services.md', 'Platform services: saves, leaderboards, multiplayer rooms, server code, and what is not provided'],
  ['standards.md', 'Game standards: covers, the store listing, safe areas and what the platform draws over a game'],
  ['game-metadata.md', 'Store metadata: genre, tags, languages, players, content rating, accessibility'],
  ['troubleshooting.md', 'Versions, release requirements and fixing a refused version'],
  ['saves.md', 'Per-player saves and stats'],
  ['multiplayer.md', 'Multiplayer rooms'],
  ['matches.md', 'Server-run matches and matchmaking'],
  ['storage.md', 'Game storage limits and how to stay inside them'],
  ['test-bots.md', 'Preview test bots for multiplayer games'],
];

export interface LlmsGame { slug: string; title: string; tagline: string | null; genre: string | null; price_cents: number; author: string; plays: number }
export interface LlmsFacts { brand: string; origin: string; games: number; creators: number; licenseTermCents: number; licenseTermDays: number; licenseLifetimeCents: number; feePercent: number; feeOpenPercent: number }
const usd = (c: number) => (c > 0 ? `$${(c / 100).toFixed(c % 100 ? 2 : 0)}` : 'free');

export function llmsTxt(f: LlmsFacts, top: LlmsGame[]): string {
  const o = f.origin, b = f.brand;
  return `# ${b}

> ${b} (${o}) is a web game platform and marketplace where anyone publishes browser games made with their own AI agent (Claude, ChatGPT, Codex, Claude Code, Cursor, OpenCode or any MCP client), and players play them free or buy them, in any browser, on phones, tablets and computers, with no download.

People use ${b} to publish games made with an AI agent, to host HTML5, WebGL and WebAssembly games with saves, leaderboards and multiplayer built in, to let an AI coding agent deploy and sell a game, and to find new browser games to play. It has ${f.games} live games from ${f.creators} creators.

Key facts:

- Web games only: HTML, JavaScript, CSS and WebAssembly. Engines that export to the web (Three.js, Phaser, PlayCanvas, Babylon.js, Godot Web, Unity WebGL) work.
- Creators publish through an MCP server at ${o}/mcp (OAuth 2.1 sign-in, no API keys; device sign-in for agents without a browser). The agent uploads files, deploys a preview, and the platform plays every version in a real browser before it can go live.
- Hosted services for games: per-player saves, stats, leaderboards, multiplayer rooms, server-run matches with matchmaking, server code, friends and invites.
- Every game runs on every device: the platform's runtime adds touch controls, fullscreen, sound unlocking and Safari fixes to every game.
- Six languages: English, 简体中文, 繁體中文, 日本語, 한국어, Español. Store listings are shown in the player's language.
- Players sign in with a code sent to their email or with a passkey; free games, paid games, free trials, refunds within a day of buying.
- Creators: a creator license is ${usd(f.licenseTermCents)} for ${f.licenseTermDays} days or ${usd(f.licenseLifetimeCents)} for life (one-time payments). The platform keeps ${f.feePercent}% of a sale (${f.feeOpenPercent}% when the game shares its build skill for free); payouts go through Stripe Connect.
- Copies of other creators' games are refused automatically; adult content is allowed only when declared, and is labelled 18+.

## Docs

${GUIDES.map(([file, what]) => `- [${file.replace(/\.md$/, '')}](${o}/guides/${file}): ${what}`).join('\n')}
- [Docs page](${o}/docs): connecting an agent, step by step
- [For creators](${o}/create): what the platform does for creators
- [Full text of the guides](${o}/llms-full.txt)

## Store

- [Store](${o}/): today's picks, trending, new and top-rated games
- [Categories](${o}/categories): every genre and tag
- [Browse](${o}/browse): search and filter every game
- [Creator Store](${o}/creator-store): build skills, agent skills that show how a live game was made

## Games

${top.map((g) => `- [${g.title}](${o}/g/${encodeURIComponent(g.slug)})${g.tagline ? `: ${g.tagline}` : ''} (${[g.genre, g.price_cents > 0 ? usd(g.price_cents) : 'free', `by ${g.author}`].filter(Boolean).join(', ')})`).join('\n') || '- No games are live yet.'}

## Optional

- [Terms](${o}/legal/terms), [Privacy](${o}/legal/privacy), [Refunds](${o}/legal/refunds)
- [Sitemap](${o}/sitemap.xml)
`;
}

// ---- the HTML the server sends: meta tags, JSON-LD and a summary for crawlers that do not run scripts ---------------
const h = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON for a <script> tag: nothing in it can close the tag. */
const ld = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export interface PageMeta { title: string; description: string; path: string; image?: string | null; type?: 'website' | 'video.game' | 'article'; jsonld?: unknown[]; noscript?: string; noindex?: boolean }

/** Puts the page's meta into the app's index.html (its <title>, description and the tags after them). */
export function injectMeta(html: string, origin: string, m: PageMeta): string {
  const url = origin + m.path, desc = m.description.replace(/\s+/g, ' ').trim().slice(0, 300);
  const tags = m.noindex
    ? `<meta name="robots" content="noindex, nofollow">`
    : [`<link rel="canonical" href="${h(url)}">`, `<meta property="og:type" content="${m.type || 'website'}">`, `<meta property="og:url" content="${h(url)}">`,
      `<meta property="og:title" content="${h(m.title)}">`, `<meta property="og:description" content="${h(desc)}">`, `<meta property="og:site_name" content="HearthCade">`,
      m.image ? `<meta property="og:image" content="${h(m.image)}">` : '', `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}">`,
      `<link rel="alternate" type="text/plain" title="Summary for language models" href="${h(origin)}/llms.txt">`,
      ...(m.jsonld || []).map((j) => `<script type="application/ld+json">${ld(j)}</script>`)].filter(Boolean).join('\n');
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${h(m.title)}</title>`).replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${h(desc)}">`);
  out = out.replace('</head>', `${tags}\n</head>`);
  if (m.noscript && !m.noindex) out = out.replace('<div id="root"></div>', `<div id="root"></div><noscript>${m.noscript}</noscript>`);
  return out;
}

export function siteJsonLd(origin: string, brand: string, operator: { name: string; url: string }) {
  return [
    { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${origin}/#website`, name: brand, url: origin + '/', inLanguage: ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es'],
      description: 'A web game platform and marketplace for browser games made with AI agents. Play free and paid games in any browser; publish your own through MCP.',
      potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${origin}/browse?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
      publisher: { '@id': `${origin}/#org` } },
    { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${origin}/#org`, name: brand, url: origin + '/', logo: `${origin}/icons/icon-512.png`, parentOrganization: { '@type': 'Organization', name: operator.name, url: operator.url } },
  ];
}

export interface GameRow { slug: string; title: string; tagline: string | null; description: string | null; genre: string | null; tags: string[]; price_cents: number; author: string; rating_sum: number; rating_count: number; cover: string | null; age: number | null; published_at: number | null; updated_at: number | null; plays: number; multiplayer: boolean }
export function gamePage(origin: string, brand: string, g: GameRow): PageMeta {
  const url = `${origin}/g/${encodeURIComponent(g.slug)}`, desc = g.tagline || (g.description || '').slice(0, 200) || `${g.title}, a web game on ${brand}.`;
  const rating = g.rating_count > 0 ? Math.round((g.rating_sum / g.rating_count) * 10) / 10 : null;
  const game: Record<string, unknown> = {
    '@context': 'https://schema.org', '@type': 'VideoGame', '@id': url, name: g.title, url, description: g.description || desc,
    ...(g.cover ? { image: g.cover } : {}), genre: g.genre || undefined, keywords: g.tags.join(', ') || undefined,
    gamePlatform: ['Web browser', 'iOS', 'Android', 'Windows', 'macOS', 'Linux'], applicationCategory: 'Game', operatingSystem: 'Any (runs in a web browser)',
    playMode: g.multiplayer ? ['SinglePlayer', 'MultiPlayer'] : 'SinglePlayer', author: { '@type': 'Person', name: g.author },
    publisher: { '@id': `${origin}/#org` }, ...(g.age ? { contentRating: `${g.age}+` } : {}), ...(g.published_at ? { datePublished: new Date(g.published_at).toISOString().slice(0, 10) } : {}),
    offers: { '@type': 'Offer', price: (g.price_cents / 100).toFixed(2), priceCurrency: 'USD', availability: 'https://schema.org/InStock', url },
    ...(rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: rating, ratingCount: g.rating_count, bestRating: 5, worstRating: 1 } } : {}),
    isPartOf: { '@id': `${origin}/#website` },
  };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: brand, item: origin + '/' },
    ...(g.genre ? [{ '@type': 'ListItem', position: 2, name: g.genre, item: `${origin}/c/${encodeURIComponent(g.genre)}` }] : []),
    { '@type': 'ListItem', position: g.genre ? 3 : 2, name: g.title, item: url },
  ] };
  const facts = [g.genre, g.tags.slice(0, 6).join(', '), g.price_cents > 0 ? `$${(g.price_cents / 100).toFixed(2)}` : 'Free', `by ${g.author}`, rating ? `rated ${rating}/5 by ${g.rating_count}` : ''].filter(Boolean).join(' · ');
  return {
    title: `${g.title}: ${g.price_cents > 0 ? 'play' : 'play free'} in your browser | ${brand}`, description: desc, path: `/g/${encodeURIComponent(g.slug)}`, image: g.cover, type: 'video.game',
    jsonld: [game, crumbs],
    noscript: `<article><h1>${h(g.title)}</h1>${g.tagline ? `<p>${h(g.tagline)}</p>` : ''}<p>${h(facts)}</p>${g.description ? `<p>${h(g.description)}</p>` : ''}<p>A web game on <a href="${h(origin)}/">${h(brand)}</a>. It runs in the browser on phones, tablets and computers, with no download.</p></article>`,
  };
}

export function homePage(origin: string, brand: string, games: { slug: string; title: string; tagline: string | null }[]): PageMeta {
  return {
    title: `${brand}: play and publish web games made with AI agents`,
    description: `Play free and paid browser games on any device, and publish your own: ${brand} hosts web games built with Claude, ChatGPT, Codex, Cursor or any MCP agent, verifies each version in a real browser and sells it in its marketplace.`,
    path: '/',
    noscript: `<h1>${h(brand)}</h1><p>A web game platform and marketplace for games made with AI agents. Play in any browser; publish your own with your agent through MCP. Read <a href="${h(origin)}/llms.txt">the summary</a> or <a href="${h(origin)}/docs">the docs</a>.</p>${games.length ? `<h2>Games</h2><ul>${games.map((g) => `<li><a href="${h(origin)}/g/${h(encodeURIComponent(g.slug))}">${h(g.title)}</a>${g.tagline ? `: ${h(g.tagline)}` : ''}</li>`).join('')}</ul>` : ''}`,
  };
}

/** A creator's public profile (/creator/<id>): their name, their live games and a ProfilePage for search engines. */
export function creatorPage(origin: string, brand: string, c: { id: string; name: string; joined_at: number; followers: number; games: { slug: string; title: string }[] }): PageMeta {
  const path = `/creator/${encodeURIComponent(c.id)}`, n = c.games.length;
  return {
    title: `${c.name}, game creator on ${brand}`,
    description: n ? `Play ${n === 1 ? 'the web game' : `${n} web games`} by ${c.name} on ${brand}: ${c.games.slice(0, 5).map((g) => g.title).join(', ')}. Follow ${c.name} to hear when a new one comes out.`
      : `${c.name} makes web games on ${brand}. Follow ${c.name} to hear when their first game comes out.`,
    path, type: 'website',
    jsonld: [{ '@context': 'https://schema.org', '@type': 'ProfilePage', url: origin + path, dateCreated: new Date(c.joined_at).toISOString(),
      mainEntity: { '@type': 'Person', name: c.name, url: origin + path, interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: c.followers } } }],
    noscript: `<h1>${h(c.name)}</h1><p>Game creator on ${h(brand)}.</p>${n ? `<h2>Games</h2><ul>${c.games.map((g) => `<li><a href="${h(origin)}/g/${h(encodeURIComponent(g.slug))}">${h(g.title)}</a></li>`).join('')}</ul>` : ''}`,
  };
}

/** The other public pages: a title and description each, so a shared or crawled link says what it is. */
export function staticPage(origin: string, brand: string, path: string): PageMeta | null {
  const p: Record<string, [string, string]> = {
    '/browse': [`Browse web games | ${brand}`, 'Search and filter every live game by genre, tag, price and rating. All of them run in the browser.'],
    '/categories': [`Game categories | ${brand}`, 'Every genre and tag in the store: action, puzzle, strategy, multiplayer, cozy, pixel art and more.'],
    '/create': [`Publish web games with your AI agent | ${brand}`, `Connect Claude, ChatGPT, Codex, Cursor or any MCP agent to ${brand}: it uploads your game, the platform verifies it in a real browser, and you publish to a marketplace in six languages.`],
    '/creator-store': [`Creator Store: build skills | ${brand}`, 'Agent skills written by the agents that built live games: how each game was made, free or for sale.'],
    '/download': [`Get the app | ${brand}`, `${brand} for Windows, macOS and Linux, and on the Home Screen of phones and tablets. Free, always up to date with the site.`],
    '/docs': [`Docs: connect your agent | ${brand}`, `How to connect an AI agent to ${brand} over MCP, deploy a preview, pass verification and publish. Guides in Markdown for agents.`],
    '/legal/terms': [`Terms | ${brand}`, `The terms of use of ${brand}.`],
    '/legal/privacy': [`Privacy | ${brand}`, `How ${brand} handles personal data.`],
    '/legal/cookies': [`Cookies | ${brand}`, `The cookies ${brand} uses.`],
    '/legal/refunds': [`Refunds | ${brand}`, `How refunds of games work on ${brand}.`],
  };
  const hit = p[path];
  return hit ? { title: hit[0], description: hit[1], path } : null;
}
