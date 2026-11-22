// The MCP server as an agent meets it: tools/list annotations say what each tool does to the account, arguments are held
// to the schema (own keys only), and every guide an answer or a served guide points an agent at is one it can open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { checkArgs, listed } = await import('../src/mcp/schema.ts');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts');
const topics = new Set([...tools.matchAll(/\{ topic: '([\w-]+)', file: '([\w-]+)'/g)].map((m) => m[1]));
/** One tool's entry in TOOLS, from its name to the next tool's. */
const entry = (name) => { const i = tools.indexOf(`name: '${name}'`); assert.ok(i > 0, name); const j = tools.indexOf("\n    name: '", i + 10); return tools.slice(i, j > 0 ? j : undefined); };

test('tools/list keeps each tool\'s own idempotent and destructive hints', () => {
  const t = (annotations) => listed({ name: 'x', title: 'X', description: '', inputSchema: {}, annotations }).annotations;
  assert.equal(t({ idempotentHint: true }).idempotentHint, true, 'declared idempotent');
  assert.equal(t({ readOnlyHint: true }).idempotentHint, true, 'read-only is idempotent');
  assert.equal(t(undefined).idempotentHint, false);
  assert.equal(t({ destructiveHint: true }).destructiveHint, true);
  assert.equal(t({ readOnlyHint: true, destructiveHint: true }).destructiveHint, false, 'read-only is never destructive');
  for (const n of ['game_metadata', 'compatibility']) assert.match(entry(n), /annotations: \{ idempotentHint: true \}/, n);
  for (const n of ['unpublish', 'game_data', 'game_room']) assert.match(entry(n), /annotations: \{ destructiveHint: true \}/, n);
  assert.match(read('src/mcp/server.ts'), /tools: TOOLS\.map\(listed\)/);
});

test('arguments are checked against the schema\'s own properties', () => {
  const schema = { properties: { project: { type: 'string' }, dry_run: { type: 'boolean' }, version: { type: 'integer' } } };
  assert.equal(checkArgs(schema, { project: 'a', version: 3 }), null);
  assert.equal(checkArgs(schema, { project: 'a', version: '3' }), null, 'a number in a string is accepted');
  assert.match(checkArgs(schema, { project: 'a', constructor: 1 }), /Unknown argument: constructor/);
  assert.match(checkArgs(schema, { project: 'a', toString: 'x' }), /Unknown argument: toString/);
  assert.match(checkArgs(schema, { dry_run: 'true' }), /dry_run must be boolean/);
});

test('every get_started topic an agent is pointed at exists', () => {
  const served = [...tools.matchAll(/\{ topic: '[\w-]+', file: '([\w-]+)'/g)].map((m) => `web/public/guides/${m[1]}.md`);
  const sources = ['src/mcp/tools.ts', 'src/mcp/services.ts', 'src/mcp/server.ts', ...readdirSync(new URL('../src', import.meta.url)).filter((f) => /\.(ts|js)$/.test(f)).map((f) => `src/${f}`), ...served, 'web/public/guides/services.md'];
  for (const f of sources) {
    const s = read(f);
    for (const m of s.matchAll(/get_started \{topic: \\?["']([\w-]+)\\?["']/g)) assert.ok(topics.has(m[1]), `${f} points at get_started topic "${m[1]}", which does not exist`);
    assert.doesNotMatch(s, /get_started guides "/, `${f} names get_started guides that are not served through MCP`);
  }
  // the description lists every topic
  assert.match(entry('get_started'), /Pass topic to read one platform guide in full: \$\{PLATFORM_GUIDES\.map/, 'get_started\'s description lists every topic');
});

test('deploy_preview answers inside a 60 second client timeout', () => {
  const wait = Number(tools.match(/export const DEPLOY_WAIT_MS = (\d+);/)[1]);
  assert.ok(wait <= 50000, 'a call that outlives the client looks like a failure and gets retried');
  for (const m of tools.matchAll(/waitVersion\([^)]*, (\w+)\)/g)) assert.ok(m[1] === 'DEPLOY_WAIT_MS' || Number(m[1]) <= 50000, `a wait of ${m[1]}`);
});

test('no answer tells agents to ship Ogg-only sound', () => {
  for (const f of ['src/mcp/services.ts', 'src/storage-rules.ts', 'web/public/guides/storage.md']) assert.doesNotMatch(read(f), /Opus\/OGG audio|Opus or OGG audio/, f);
});
