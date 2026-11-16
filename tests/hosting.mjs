// Game hosting is one interface over standard Workers and Workers for Platforms (src/hosting.ts, src/dispatch.ts,
// src/runtime/outbound-worker.js): names, tags, upload metadata, addresses, routing, limits and the outbound policy
// must work the same for both, so the move to a dispatch namespace is a configuration change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gameLimits, gameUrlFor, hostId, hostKind, hostingProblems, matchGameRequest, metadataLimits, outboundParams, parseHostId,
  parseScriptName, scriptBindings, scriptMetadata, scriptName, scriptsPath, scriptTags,
} from '../src/hosting.ts';
import { dispatchGame, dispatchOptions } from '../src/dispatch.ts';
import outbound, { outboundDecision } from '../src/runtime/outbound-worker.js';

const cfg = (o = {}) => ({ DEPLOY_DRIVER: 'cloudflare', ...o });

test('script names are the same in every host and round-trip', () => {
  assert.equal(scriptName('abc123', 'live'), 'gcp-abc123-live');
  assert.deepEqual(parseScriptName('gcp-abc123-preview'), { pid: 'abc123', env: 'preview' });
  for (const bad of ['gcp-ABC123-live', 'gcp-abc-live', 'gcp-abc123-prod', 'x-gcp-abc123-live', 'gcp-abc123-live.evil', ''])
    assert.equal(parseScriptName(bad), null, bad);
  assert.ok(scriptName('a'.repeat(16), 'preview').length <= 63);
});

test('drivers map to hosts', () => {
  assert.equal(hostKind(cfg()), 'workers');
  assert.equal(hostKind(cfg({ DEPLOY_DRIVER: 'dispatch' })), 'dispatch');
  assert.equal(hostKind(cfg({ DEPLOY_DRIVER: 'local' })), 'local');
  assert.equal(hostId(cfg({ DEPLOY_DRIVER: 'dispatch', DISPATCH_NAMESPACE: 'gcp-games' })), 'dispatch:gcp-games');
  assert.deepEqual(parseHostId('dispatch:gcp-games'), { kind: 'dispatch', namespace: 'gcp-games' });
  assert.deepEqual(parseHostId(null), { kind: 'workers' });
  assert.deepEqual(parseHostId('workers:play.example.com'), { kind: 'workers', routeHost: 'play.example.com' });   // rows written before the hosting columns existed
  assert.equal(scriptsPath({ kind: 'workers' }), '/workers/scripts');
  assert.equal(scriptsPath({ kind: 'dispatch', namespace: 'gcp-games' }), '/workers/dispatch/namespaces/gcp-games/scripts');
  assert.throws(() => scriptsPath({ kind: 'dispatch' }));
  assert.deepEqual(hostingProblems(cfg()), []);
  assert.equal(hostingProblems(cfg({ DEPLOY_DRIVER: 'dispatch' })).length, 3);
  assert.deepEqual(hostingProblems(cfg({ DEPLOY_DRIVER: 'dispatch', DISPATCH_NAMESPACE: 'n', GAME_HOST: 'play.example.com', DISPATCHER: {} })), []);
});

test('tags fit Workers for Platforms rules', () => {
  const tags = scriptTags({ pid: 'abc123', owner: 'u_Ab,c&d', env: 'live', server: true });
  assert.ok(tags.length <= 8);
  assert.ok(tags.every((t) => !/[,&\s]/.test(t) && t.length > 0), tags.join(' '));
  assert.ok(tags.includes('project-abc123') && tags.includes('owner-u_Abcd') && tags.includes('gcp-live') && tags.includes('server-code'));
});

test('upload metadata: same script and bindings for both hosts, limits where each host takes them', () => {
  const bindings = scriptBindings({ PREFIX: 'p/', PLAY_KEY: 'secret' }, 'gcp-games');
  assert.deepEqual(bindings, [
    { type: 'r2_bucket', name: 'FILES', bucket_name: 'gcp-games' },
    { type: 'plain_text', name: 'PREFIX', text: 'p/' },
    { type: 'secret_text', name: 'PLAY_KEY', text: 'secret' },
  ]);
  const limits = gameLimits({ game_cpu_ms: 50, game_subrequests: 100 });
  const w = scriptMetadata('workers', { bindings, tags: ['gcp-game'], limits });
  const d = scriptMetadata('dispatch', { bindings, tags: ['gcp-game'], limits });
  assert.deepEqual(w.limits, { cpu_ms: 50, subrequests: 100 });
  assert.equal(d.limits, undefined);   // per request, through dispatcher.get
  for (const m of [w, d]) {
    assert.equal(m.main_module, 'game-worker.js');
    assert.ok(m.compatibility_flags.includes('disallow_importable_env'));
    assert.deepEqual(m.bindings, bindings);
  }
  assert.deepEqual(scriptMetadata('workers', { bindings, tags: [], limits: gameLimits({}) }).limits, undefined);
});

test('limits: 0 means the plan default, values are clamped to what Cloudflare accepts', () => {
  assert.deepEqual(gameLimits({ game_cpu_ms: 0, game_subrequests: 0 }), {});
  assert.deepEqual(gameLimits({ game_cpu_ms: 999999, game_subrequests: 1e9 }), { cpuMs: 300000, subRequests: 10000000 });
  assert.equal(metadataLimits({}), undefined);
});

test('addresses for each host', () => {
  const o = { origin: 'https://platform.test', subdomain: 'acct' };
  const at = (env) => gameUrlFor(env, parseHostId(hostId(env)), 'gcp-abc123-live', o);
  assert.equal(at(cfg()), 'https://gcp-abc123-live.acct.workers.dev/');
  const routed = cfg({ GAME_HOST: 'play.example.com', GAME_ZONE_ID: 'z' });
  assert.equal(hostId(routed), 'workers:play.example.com');   // a different host id, so the rollout puts every game on its route first
  assert.equal(at(routed), 'https://gcp-abc123-live.play.example.com/');
  assert.equal(at(cfg({ GAME_HOST: 'play.example.com' })), 'https://gcp-abc123-live.acct.workers.dev/');   // no zone: no routes
  // the address a routed standard Worker had is the one the dispatch Worker answers on: nothing changes for players
  assert.equal(at({ ...routed, DEPLOY_DRIVER: 'dispatch', DISPATCH_NAMESPACE: 'n' }), at(routed));
  // a row written while games were routed keeps its address even after the configuration changed
  assert.equal(gameUrlFor(cfg(), parseHostId('workers:play.example.com'), 'gcp-abc123-live', o), 'https://gcp-abc123-live.play.example.com/');
  assert.throws(() => at(cfg({ DEPLOY_DRIVER: 'dispatch' })), /GAME_HOST/);
  assert.equal(gameUrlFor(cfg({ DEPLOY_DRIVER: 'local' }), { kind: 'local' }, 'gcp-abc123-preview', o), 'https://platform.test/__game/abc123/preview/');
  assert.equal(at(cfg({ GAME_HOST: 'https://Play.Example.com/', DEPLOY_DRIVER: 'dispatch' })), 'https://gcp-abc123-live.play.example.com/');
});

test('routing a request to its game', () => {
  const d = cfg({ DEPLOY_DRIVER: 'dispatch', GAME_HOST: 'play.example.com' });
  assert.deepEqual(matchGameRequest(d, new URL('https://gcp-abc123-live.play.example.com/index.html')), { script: 'gcp-abc123-live', pid: 'abc123', env: 'live', base: '', via: 'host' });
  assert.deepEqual(matchGameRequest(d, new URL('https://evil.play.example.com/')), { script: null });
  assert.deepEqual(matchGameRequest(d, new URL('https://a.gcp-abc123-live.play.example.com/')), { script: null });
  assert.equal(matchGameRequest(d, new URL('https://platform.example.com/')), null);
  assert.equal(matchGameRequest(d, new URL('https://platform.example.com/__game/abc123/live/')), null);   // only the local driver
  const l = cfg({ DEPLOY_DRIVER: 'local' });
  assert.deepEqual(matchGameRequest(l, new URL('http://localhost:8787/__game/abc123/preview/a/b.png')), { script: 'gcp-abc123-preview', pid: 'abc123', env: 'preview', base: '/__game/abc123/preview', via: 'path' });
  assert.equal(matchGameRequest(l, new URL('http://localhost:8787/__game/ABC/preview/')), null);
});

const route = { script: 'gcp-abc123-live', pid: 'abc123', env: 'live', base: '', via: 'host' };
const S = { game_cpu_ms: 40, game_subrequests: 0, game_blocked_hosts: 'evil.test, *.bad.test' };

test('dispatch passes the limits, and outbound params only when an outbound Worker is bound', () => {
  assert.deepEqual(dispatchOptions({}, S, route, 'https://p.test'), { limits: { cpuMs: 40 } });
  assert.deepEqual(dispatchOptions({ GAME_OUTBOUND: '1' }, { ...S, game_cpu_ms: 0 }, route, 'https://p.test'), {
    outbound: { gcp: { game: 'abc123', env: 'live', script: 'gcp-abc123-live', platform: 'https://p.test', blocked: ['evil.test', 'bad.test'] } },
  });
  assert.deepEqual(outboundParams(route, 'https://p.test', '').blocked, []);
});

test('dispatch: success passes through; missing Worker is 404; a limit is a 503 that says so', async () => {
  const calls = [];
  const ns = (impl) => ({ get: (name, args, opts) => { calls.push({ name, opts }); return { fetch: impl }; } });
  const ok = await dispatchGame(new Request('https://gcp-abc123-live.play.example.com/'), {}, ns(async () => new Response('hi')), S, route, 'https://p.test');
  assert.equal(await ok.text(), 'hi');
  assert.deepEqual(calls[0], { name: 'gcp-abc123-live', opts: { limits: { cpuMs: 40 } } });
  const gone = await dispatchGame(new Request('https://x/'), {}, { get: () => { throw new Error('Worker not found.'); } }, S, route, '');
  assert.equal(gone.status, 404);
  const cpu = await dispatchGame(new Request('https://x/api/run'), {}, ns(async () => { throw new Error('Worker exceeded CPU time limit.'); }), S, route, '');
  assert.equal(cpu.status, 503);
  assert.equal((await cpu.json()).code, 'limit_exceeded');
  const crash = await dispatchGame(new Request('https://x/'), {}, ns(async () => { throw new Error('boom'); }), S, route, '');
  assert.equal(crash.status, 502);
  const none = await dispatchGame(new Request('https://evil.play.example.com/'), {}, ns(async () => new Response('no')), S, { script: null }, '');
  assert.equal(none.status, 404);
});

test('outbound policy: blocked hosts, and only the runtime paths of the platform', () => {
  const p = { game: 'abc123', env: 'live', platform: 'https://p.test', blocked: ['evil.test', 'bad.test'] };
  assert.equal(outboundDecision('https://api.example.com/x', p).allow, true);
  assert.equal(outboundDecision('https://evil.test/x', p).allow, false);
  assert.equal(outboundDecision('https://a.b.bad.test/x', p).allow, false);
  assert.equal(outboundDecision('https://notbad.test/x', p).allow, true);
  assert.deepEqual(outboundDecision('https://p.test/api/rt/server-store', p), { allow: true, platform: true });
  assert.equal(outboundDecision('https://p.test/api/admin/settings', p).allow, false);
  assert.equal(outboundDecision('https://p.test/authorize', p).allow, false);
  assert.equal(outboundDecision('not a url', p).allow, false);
});

test('outbound Worker: refuses blocked calls, stamps the real game on platform calls', async () => {
  const sent = [], real = globalThis.fetch;
  globalThis.fetch = async (r) => { sent.push(r); return new Response('ok'); };
  try {
    const env = { gcp: { game: 'abc123', env: 'live', platform: 'https://p.test', blocked: ['evil.test'] } };
    assert.equal((await outbound.fetch(new Request('https://evil.test/'), env)).status, 403);
    await outbound.fetch(new Request('https://p.test/api/rt/server-store', { method: 'POST', headers: { 'x-gcp-game': 'someoneelse' }, body: '{}' }), env);
    assert.equal(sent[0].headers.get('x-gcp-game'), 'abc123');
    await outbound.fetch(new Request('https://api.example.com/'), env);
    assert.equal(sent.length, 2);
  } finally { globalThis.fetch = real; }
});
