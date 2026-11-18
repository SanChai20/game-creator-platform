// The game Worker never serves the game's server code as a file, however the path is spelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, isServerPath, signPlayToken } from '../src/runtime/game-worker.js';

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
  const ok = await handle(new Request('https://g.example/assets/a.png', { headers: { cookie: 'gcp_t=' + tok } }), env, {});
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
  mkdirSync(join(dir, 'server'));
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
  mkdirSync(join(dir, 'server'));
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
