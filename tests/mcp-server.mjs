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

test('arguments are repaired where clients and smaller models send them differently, and only there', async () => {
  const { normalizeArgs, signature } = await import('../src/mcp/schema.ts');
  const schema = { properties: { project: { type: 'string' }, dry_run: { type: 'boolean' }, version: { type: 'integer' }, files: { type: 'array' }, sale: { type: ['object', 'null'] }, note: { type: 'string' } }, required: ['project'] };
  assert.deepEqual(normalizeArgs(schema, '{"project":"a","version":"3"}'), { project: 'a', version: 3 }, 'arguments sent as a JSON string');
  assert.deepEqual(normalizeArgs(schema, { arguments: { project: 'a' } }), { project: 'a' }, 'arguments wrapped once more');
  assert.deepEqual(normalizeArgs(schema, { input: '{"project":"a"}' }), { project: 'a' });
  assert.deepEqual(normalizeArgs(schema, { project_id: 'a' }), { project: 'a' }, 'project_id for project');
  assert.deepEqual(normalizeArgs(schema, { projectId: 'a', dry_run: 'TRUE' }), { project: 'a', dry_run: true });
  assert.deepEqual(normalizeArgs(schema, { project: 'a', dry_run: 'false' }), { project: 'a', dry_run: false }, '"false" is false, never a truthy string');
  assert.deepEqual(normalizeArgs(schema, { project: 'a', files: '[{"path":"index.html"}]', sale: '{"days":2}' }), { project: 'a', files: [{ path: 'index.html' }], sale: { days: 2 } }, 'an array or object sent as JSON text');
  assert.deepEqual(normalizeArgs(schema, { project: 'a', note: 'true', dry_run: 'yes' }), { project: 'a', note: 'true', dry_run: 'yes' }, 'strings stay strings; anything unclear is left for the check');
  assert.deepEqual(normalizeArgs(schema, null), {});
  assert.match(checkArgs(schema, normalizeArgs(schema, { project: 'a', dry_run: 'yes' })), /dry_run must be boolean/);
  const sig = signature(schema);
  assert.match(sig, /project: string, dry_run\?: boolean/);
  assert.ok(sig.length < 300, 'a refusal names the arguments in a line, not the whole schema');
  const server = read('src/mcp/server.ts');
  assert.match(server, /normalizeArgs\(tool\.inputSchema as any, params\?\.arguments\)/);
  assert.doesNotMatch(server, /Expected: \$\{JSON\.stringify\(tool\.inputSchema/, 'refusals do not dump the whole schema');
});

test('publish never writes the title into the tagline', () => {
  // a tagline equal to the title is hidden by the store, and becomes a field every listing translation then needs
  assert.doesNotMatch(entryFn('publishVersion'), /tagline: p\.title/);
});

test('get_started presents the game standards as advice', () => {
  const s = entry('get_started');
  assert.doesNotMatch(s, /fix every warning/);
  assert.match(s, /Design recommendations and best practice, not requirements/);
});

test('get_started keeps platform requirements and design recommendations apart', () => {
  const s = entry('get_started');
  assert.match(s, /platform_requirements: \{/);
  assert.match(s, /design_recommendations: SPLIT\.recommendations/);
  assert.match(s, /Be playable on computers, tablets and phones/);
});

test('tools/list does not carry the tag list twice', () => {
  const m = tools.match(/const TAGS_SCHEMA = [^\n]+/)[0];
  assert.match(m, /enum: \[\.\.\.TAGS\]/);
  assert.doesNotMatch(m, /l\.join\(', '\)/, 'the description names the groups, the enum holds the tags');
});

function entryFn(name) { const i = tools.indexOf(`async function ${name}(`); assert.ok(i > 0, name); return tools.slice(i, tools.indexOf('\n}\n', i)); }
