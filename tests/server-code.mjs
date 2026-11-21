// The game Worker never serves the game's server code as a file, however the path is spelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fontPreloads, handle, isServerPath, signPlayToken } from '../src/runtime/game-worker.js';

test('every spelling of a server/ path is recognised', () => {
  for (const p of ['/server/index.js', '/server/', '/server', '//server/index.js', '/./server/a.js', '/x/../server/a.js', '/server/sub/b.js', 'server/index.js'])
    assert.equal(isServerPath(p), true, p);
  for (const p of ['/index.html', '/servers/a.js', '/my-server/a.js', '/src/server.js', '/Server/a.js', '/assets/server/x.png'.replace('assets/', 'assets-')])
    assert.equal(isServerPath(p), false, p);
});

test('the Worker answers 404 for server code and never reads it from storage', async () => {
  const reads = [];
  const env = { PREFIX: 'v/', GAME_ID: 'abc123', ENV: 'live', PLAY_KEY: 'k', PLATFORM: 'https://p', FILES: { get: async (k) => { reads.push(k); return { body: 'export default {}', size: 17, httpEtag: '"e"', httpMetadata: {} }; } } };
  for (const path of ['/server/index.js', '//server/secret.js', '/x/../server/secret.js', '/%73erver/secret.js', '/server%2Fsecret.js']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await handle(new Request('https://g.example' + path, { method }), env, {});
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  }
  assert.deepEqual(reads, []);
  // other files are served to a player with a play session, and to nobody else
  assert.equal((await handle(new Request('https://g.example/assets/a.png'), env, {})).status, 401);
  const tok = await signPlayToken({ g: 'abc123', e: 'live', u: 'u1', n: 'P', s: 'pl_1', x: Math.floor(Date.now() / 1000) + 600 }, 'k');
  // over HTTPS only the __Host- cookie counts: a plain gcp_t planted by a sibling game on the same domain is ignored
  assert.equal((await handle(new Request('https://g.example/assets/a.png', { headers: { cookie: 'gcp_t=' + tok } }), env, {})).status, 401);
  const ok = await handle(new Request('https://g.example/assets/a.png', { headers: { cookie: '__Host-gcp_t=' + tok } }), env, {});
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control'), /^private/);
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
});

test('a game with server code: /api/* runs it (with its imports and the player), its files are never served', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gcp-srv-'));
  copyFileSync(new URL('../src/runtime/game-worker.js', import.meta.url), join(dir, 'game-worker.js'));
  copyFileSync(new URL('../src/runtime/gcp-intrinsics.js', import.meta.url), join(dir, 'gcp-intrinsics.js'));
  copyFileSync(new URL('../src/runtime/match-core.js', import.meta.url), join(dir, 'match-core.js'));
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server/match.js'), 'export default null;\n');
  writeFileSync(join(dir, 'server/secret.js'), "export const KEY = 'sk_live_test_0123456789';\n");
  writeFileSync(join(dir, 'server/index.js'), "import { KEY } from './secret.js';\nexport default { async fetch(request, env) { return Response.json({ n: KEY.length, player: env.player, game: env.GAME.id }); } };\n");
  const mod = await import(join(dir, 'game-worker.js'));
  const env = { PREFIX: 'v/', GAME_ID: 'abc123', SLUG: 's', VERSION: '1', ENV: 'live', PLAY_KEY: 'k', PLATFORM: 'https://p', FILES: { get: async () => ({ body: 'export default {}', size: 17, httpEtag: '"e"', httpMetadata: {} }) } };
  const tok = await mod.signPlayToken({ g: 'abc123', e: 'live', u: 'guest_abc', n: 'Guest', k: 'player', s: 'ps', x: Math.floor(Date.now() / 1000) + 60 }, 'k');
  const r = await mod.handle(new Request('https://g.example/api/hello', { headers: { 'x-gcp-token': tok } }), env, {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { n: 23, player: { id: 'guest_abc', name: 'Guest', guest: true }, game: 'abc123' });
  assert.equal((await mod.handle(new Request('https://g.example/server/secret.js'), env, {})).status, 404);
  assert.equal((await mod.handle(new Request('https://g.example/server/index.js', { method: 'HEAD' }), env, {})).status, 404);
});

test('a crash in server code answers 500 marked as the server code\'s, with where it came from in a preview', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gcp-srv-'));
  copyFileSync(new URL('../src/runtime/game-worker.js', import.meta.url), join(dir, 'game-worker.js'));
  copyFileSync(new URL('../src/runtime/gcp-intrinsics.js', import.meta.url), join(dir, 'gcp-intrinsics.js'));
  copyFileSync(new URL('../src/runtime/match-core.js', import.meta.url), join(dir, 'match-core.js'));
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server/match.js'), 'export default null;\n');
  writeFileSync(join(dir, 'server/index.js'), "export default { async fetch() { const world = null; return Response.json(world.cells); } };\n");
  const mod = await import(join(dir, 'game-worker.js'));
  const env = (ENV) => ({ PREFIX: 'v/', GAME_ID: 'abc123', SLUG: 's', VERSION: '1', ENV, PLAY_KEY: 'k', PLATFORM: 'https://p', FILES: { get: async () => null } });
  const r = await mod.handle(new Request('https://g.example/api/world'), env('preview'), {});
  assert.equal(r.status, 500);
  assert.equal(r.headers.get('x-gcp-server-error'), '1');
  const j = await r.json();
  assert.match(j.message, /null/);
  assert.ok(j.stack.some((l) => l.includes('server/index.js')));
  const live = await (await mod.handle(new Request('https://g.example/api/world'), env('live'), {})).json();
  assert.equal(live.stack, undefined);   // players of the live game never see where the creator's code failed
});

// ---- the runtime's env is out of the game's reach -------------------------------------------------------------------
async function runtimeWith(serverSrc, matchSrc = 'export default null;\n') {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gcp-srv-'));
  for (const f of ['game-worker.js', 'gcp-intrinsics.js', 'match-core.js']) copyFileSync(new URL('../src/runtime/' + f, import.meta.url), join(dir, f));
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server/match.js'), matchSrc);
  writeFileSync(join(dir, 'server/index.js'), serverSrc);
  return import(join(dir, 'game-worker.js'));
}

test('server code cannot reach the runtime env or the keys through Object.prototype getters or patched crypto', async () => {
  // what a hostile game tried in the security review: a getter on Object.prototype for a property the runtime reads on
  // its env, and a replaced crypto.subtle.importKey that sees the raw key bytes
  const mod = await runtimeWith(`
const seen = globalThis.__seen = { envs: [], keys: [] };
for (const name of ['__testFetch', 'FILES', 'MATCH', 'STORE_KEY', 'PLAY_KEY']) {
  Object.defineProperty(Object.prototype, name, { configurable: true, get() { if (this && this.PLAY_KEY !== undefined && this !== Object.prototype) seen.envs.push(Object.keys(this)); return undefined; } });
}
const s = crypto.subtle, orig = s.importKey;
Object.defineProperty(s, 'importKey', { configurable: true, value: function (fmt, data, ...rest) { seen.keys.push(new TextDecoder().decode(data)); return orig.call(s, fmt, data, ...rest); } });
const origParse = JSON.parse; JSON.parse = function (t, r) { seen.keys.push('parse:' + String(t).slice(0, 40)); return origParse(t, r); };
export default { async fetch(request, env) { await env.store.get('x').catch(() => {}); return Response.json({ ok: true }); } };
`, 'export default { init() { return {}; }, tick(s) { return s; } };\n');
  const env = { PREFIX: 'v/', GAME_ID: 'abc123', SLUG: 's', VERSION: '1', ENV: 'preview', PLAY_KEY: 'SECRET-PLAY', STORE_KEY: 'SECRET-STORE', PLATFORM: 'http://127.0.0.1:9' };
  const tok = await mod.signPlayToken({ g: 'abc123', e: 'preview', u: 'u1', n: 'P', k: 'player', s: 'ps', x: Math.floor(Date.now() / 1000) + 60 }, 'SECRET-PLAY');
  try {
    const r = await mod.handle(new Request('https://g.example/api/x', { headers: { 'x-gcp-token': tok } }), env, {});
    assert.equal(r.status, 200);
    const m = await mod.handle(new Request('https://g.example/__gcp/match?t=x', { headers: { upgrade: 'websocket' } }), env, {});
    assert.equal(m.status, 501);   // read env.MATCH, found nothing, and ran no getter of the game's while doing so
    await mod.handle(new Request('https://g.example/assets/a.png', { headers: { cookie: '__Host-gcp_t=' + tok } }), env, {}).catch(() => {});
    assert.deepEqual(globalThis.__seen.envs, [], 'no getter of the game ever ran with the runtime env as `this`');
    assert.ok(!globalThis.__seen.keys.some((k) => k.includes('SECRET')), 'the patched importKey and JSON.parse never saw a key');
  } finally {
    for (const name of ['__testFetch', 'FILES', 'MATCH', 'STORE_KEY', 'PLAY_KEY']) delete Object.prototype[name];
  }
});

test('a deployed game Worker has no bucket: files come from the platform with the game\'s store key, ranges included', async () => {
  const mod = await runtimeWith('export default null;\n');
  const calls = [];
  const env = { PREFIX: 'v/abc123/3/', GAME_ID: 'abc123', SLUG: 's', TITLE: 'T', VERSION: '3', ENV: 'live', PLAY_KEY: 'k', STORE_KEY: 'sk', PLATFORM: 'https://p', MANIFEST: '{}',
    __testFetch: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      if (String(url).endsWith('/missing.png')) return new Response('nope', { status: 404 });
      if (init.headers.range) return new Response('BC', { status: 206, headers: { etag: '"e"', 'x-gcp-size': '4', 'content-range': 'bytes 1-2/4', 'x-gcp-type': 'image/png' } });
      if (init.headers['if-none-match'] === '"e"') return new Response(null, { status: 304, headers: { etag: '"e"', 'x-gcp-size': '4' } });
      if (String(url).endsWith('/index.html')) return new Response('<!doctype html><head></head>hi', { headers: { etag: '"h"', 'x-gcp-size': '30' } });
      return new Response('ABCD', { headers: { etag: '"e"', 'x-gcp-size': '4', 'x-gcp-type': 'image/png' } });
    } };
  const tok = await mod.signPlayToken({ g: 'abc123', e: 'live', u: 'u1', n: 'P', k: 'player', s: 'ps', x: Math.floor(Date.now() / 1000) + 600 }, 'k');
  const get = (path, headers = {}) => mod.handle(new Request('https://g.example' + path, { headers: { cookie: '__Host-gcp_t=' + tok, ...headers } }), env, {});
  const full = await get('/a b/c.png');
  assert.equal(full.status, 200); assert.equal(await full.text(), 'ABCD'); assert.equal(full.headers.get('etag'), '"e"');
  assert.equal(calls[0].url, 'https://p/api/rt/file/3/a%20b/c.png');
  assert.deepEqual([calls[0].headers['x-gcp-game'], calls[0].headers['x-gcp-env'], calls[0].headers['x-gcp-key']], ['abc123', 'live', 'sk']);
  const part = await get('/c.png', { range: 'bytes=1-2' });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 1-2/4'); assert.equal(await part.text(), 'BC');
  assert.equal((await get('/c.png', { 'if-none-match': '"e"' })).status, 304);
  assert.equal((await get('/missing.png')).status, 404);
  const launch = await mod.handle(new Request('https://g.example/?gcp_t=' + tok), env, {});
  assert.equal(launch.status, 302);
  const page = await mod.handle(new Request('https://g.example' + launch.headers.get('location')), env, {});
  assert.equal(page.status, 200); assert.match(await page.text(), /__GCP_CONFIG/);
});

test('the game page starts the version\'s fonts with the page and tells the SDK which they are', async () => {
  const files = JSON.stringify([
    { path: 'index.html', size: 900 }, { path: 'fonts/titan.woff2', size: 10_000 }, { path: 'fonts/fredoka.woff2', size: 29_000 },
    { path: 'fonts/fredoka.ttf', size: 90_000 }, { path: 'fonts/cjk.woff2', size: 4_000_000 }, { path: 'server/f.woff2', size: 100 },
  ]);
  // woff2 only when there is any, small first, no whole CJK face, nothing from server code
  assert.deepEqual(fontPreloads(files), ['fonts/titan.woff2', 'fonts/fredoka.woff2']);
  assert.deepEqual(fontPreloads(JSON.stringify([{ path: 'a/b.ttf', size: 50_000 }])), ['a/b.ttf']);
  assert.deepEqual(fontPreloads('[]'), []);

  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
  const env = { PREFIX: 'v/', GAME_ID: 'abc123', ENV: 'live', PLAY_KEY: 'k', PLATFORM: 'https://p', MANIFEST: '{}', FONTS: JSON.stringify(fontPreloads(files)),
    FILES: { get: async () => ({ text: async () => html, body: html, size: html.length, httpEtag: '"e"', httpMetadata: {} }) } };
  const tok = await signPlayToken({ g: 'abc123', e: 'live', u: 'u1', n: 'P', s: 'pl_1', k: 'verify', x: Math.floor(Date.now() / 1000) + 600 }, 'k');
  const page = await (await handle(new Request(`https://g.example/~t/${tok}/index.html`), env, {})).text();
  const head = page.slice(0, page.indexOf('<meta'));
  assert.ok(head.includes(`<link rel="preload" as="font" href="/~t/${tok}/fonts/titan.woff2" crossorigin data-gcp-font>`), head);
  assert.ok(head.indexOf('data-gcp-font') < head.indexOf('/sdk/gcp.js'), 'the preloads come before the SDK, which looks for them');
  assert.match(head, /"fonts":\["\/~t\/[^"]+\/fonts\/titan\.woff2","\/~t\/[^"]+\/fonts\/fredoka\.woff2"\]/);
  // a version with no fonts gets neither
  const bare = await (await handle(new Request(`https://g.example/~t/${tok}/index.html`), { ...env, FONTS: '[]' }, {})).text();
  assert.ok(!bare.includes('data-gcp-font') && !bare.includes('"fonts"'));
});
