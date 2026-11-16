// The services catalog agents read (platform_services, gcp://services, the services guide) must stay true to the code:
// every public part of the SDK is listed under some service, every tool it names exists, every guide it points at exists,
// and the limits it reports come from the settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOT_PROVIDED, platformServices } from '../src/mcp/services.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// The settings defaults, read from the source so this test needs no Worker.
const defaults = Object.fromEntries([...read('src/settings.ts').matchAll(/^\s{2}(\w+): \{ v: (true|false|[\d* ]+|'[^']*'),/gm)].map(([, k, v]) => [k, Function(`return ${v}`)()]));
const services = platformServices(defaults, 'https://example.test');
const tools = new Set([...read('src/mcp/tools.ts').matchAll(/^\s{4}name: '(\w+)'/gm)].map((m) => m[1]));
const guides = new Set([...read('src/mcp/tools.ts').matchAll(/\{ topic: '([\w-]+)', file: '([\w-]+)'/g)].map((m) => m[1]));

test('the catalog reads the settings it reports', () => {
  assert.ok(Object.keys(defaults).length > 40, 'settings parse');
  const rooms = services.find((s) => s.id === 'multiplayer');
  assert.equal(rooms.limits.players_per_room, defaults.room_max_peers);
  assert.equal(services.find((s) => s.id === 'hosting').limits.files_per_bundle, defaults.bundle_max_files);
  assert.equal(services.find((s) => s.id === 'server_code').status, 'available');
  assert.equal(platformServices({ ...defaults, allow_server_code: false, paid_games_enabled: false }, '').find((s) => s.id === 'server_code').status, 'disabled');
});

test('every service is complete and has a unique id', () => {
  const ids = services.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of services) {
    assert.ok(s.what.length > 30 && s.how_it_works.length > 30, s.id);
    assert.ok(s.use_for.length && s.guidelines.length, s.id);
    assert.ok(s.sdk.length || s.mcp_tools.length || s.http?.length, `${s.id} says how to reach it`);
  }
  assert.ok(NOT_PROVIDED.length >= 10 && NOT_PROVIDED.every((m) => m.instead.length > 20));
});

test('every tool and guide the catalog names exists', () => {
  assert.ok(tools.has('platform_services') && tools.size >= 19);
  for (const s of services) {
    for (const t of s.mcp_tools) assert.ok(tools.has(t), `${s.id} names unknown tool ${t}`);
    if (s.guide) assert.ok(guides.has(s.guide), `${s.id} points at unknown guide ${s.guide}`);
  }
});

test('every public member of window.GCP is listed under a service', () => {
  const sdk = read('web/public/sdk/gcp.js');
  const body = sdk.slice(sdk.indexOf('var GCP = window.GCP = {'));
  const top = new Set(['env', 'gameId', 'version', 'player', 'standalone', ...[...body.matchAll(/^\s{4}(\w+): /gm)].map((m) => m[1])]);
  const nested = [...body.matchAll(/^\s{6}(\w+): function/gm)].map((m) => m[1]);
  const listed = services.flatMap((s) => s.sdk).join(' ');
  for (const k of top) assert.ok(listed.includes(`GCP.${k}`), `GCP.${k} is not in the catalog`);
  for (const k of nested) assert.ok(new RegExp(`\\.${k}\\b`).test(listed), `GCP.*.${k} is not in the catalog`);
});

test('the services guide covers every service and is served as a platform guide', () => {
  const md = read('web/public/guides/services.md');
  assert.ok(guides.has('services'));
  for (const s of services) assert.ok(md.includes(`| ${s.name} |`), `the guide's catalog table misses ${s.name}`);
  for (const m of NOT_PROVIDED) assert.ok(md.includes(`| ${m.need} |`), `the guide's not-provided table misses "${m.need}"`);
});
