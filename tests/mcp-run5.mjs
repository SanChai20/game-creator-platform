// What the fifth end-to-end agent run (Haiku 5.5, MCP test run 5) found, each held in place: there was no way to delete a
// project, so an account at its project limit could not make room; a game that declared landscape after its last deploy
// was published with that older version and the store said both orientations, with nothing in the answer saying why; and
// the "responds" check failed a game that sits on a still title screen and undoes what a click did (memory cards turning
// back over) before the last picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { respondsBy } = await import('../src/verify-core.js');
const { requirementsDrift, parseRequirements, emptyRequirements } = await import('../web/src/compat.ts');
const { deleteVerdict } = await import('../src/project-delete.ts');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts');
const entry = (name) => { const i = tools.indexOf(`name: '${name}'`); assert.ok(i > 0, name); const j = tools.indexOf("\n    name: '", i + 10); return tools.slice(i, j > 0 ? j : undefined); };

// ---- #1 delete a project
const facts = (o = {}) => ({ status: 'offline', slug: 'mcp-run4-test-stars', id: '6krw9tgd6i', purchases: 0, skillPurchases: 0, otherPlayers: 0, priceCents: 0, ...o });

test('#1 a live game cannot be deleted: take it offline first', () => {
  const v = deleteVerdict(facts({ status: 'live' }), 'mcp-run4-test-stars');
  assert.equal(v.ok, false); assert.equal(v.code, 'live'); assert.match(v.fix, /offline/);
});

test('#1 a game or build skill anyone bought cannot be deleted, even with confirm', () => {
  assert.equal(deleteVerdict(facts({ purchases: 1 }), 'mcp-run4-test-stars').code, 'bought');
  assert.equal(deleteVerdict(facts({ skillPurchases: 2 }), '6krw9tgd6i').code, 'bought');
  assert.equal(deleteVerdict(facts({ status: 'removed' }), 'mcp-run4-test-stars').code, 'removed');
});

test('#1 delete needs the exact address or id as confirm', () => {
  assert.equal(deleteVerdict(facts(), undefined).confirmed, false);
  assert.equal(deleteVerdict(facts(), 'yes').confirmed, false);
  assert.equal(deleteVerdict(facts(), 'MCP-RUN4-TEST-STARS').confirmed, false);
  assert.equal(deleteVerdict(facts(), ' mcp-run4-test-stars ').confirmed, true);
  assert.equal(deleteVerdict(facts(), '6krw9tgd6i').confirmed, true);
  assert.equal(deleteVerdict(facts({ status: 'draft' }), undefined).confirm_with, 'mcp-run4-test-stars');
});

test('#1 other players and a price are said before deleting, never silently', () => {
  const v = deleteVerdict(facts({ otherPlayers: 3, priceCents: 1900 }), undefined);
  assert.equal(v.ok, true);
  assert.match(v.warnings.join(' '), /3 player\(s\) other than you/);
  assert.match(v.warnings.join(' '), /price set, but nobody has bought it/);
});

test('#1 delete_project is a soft delete in the MCP and the console, and frees the project limit', () => {
  const d = entry('delete_project');
  assert.match(d, /destructiveHint: true/);
  assert.match(d, /deleteProject\(c\.env, c\.user, p, a\.confirm, c\.client\)/);
  const core = read('src/project-delete.ts');
  assert.match(core, /SET status = 'removed', removed_reason = 'Deleted by the creator', deleted_at = \?/);
  assert.match(core, /status NOT IN \('live', 'removed'\)/);
  assert.match(core, /undeployGame\(env, p\.id, e\)/);
  // the limit and the lists leave removed projects out, so a deleted one frees its place
  assert.match(read('src/projects.ts'), /COUNT\(\*\) AS n FROM projects WHERE owner_id = \? AND status != 'removed'/);
  assert.match(entry('list_projects'), /status != 'removed'/);
  assert.ok(existsSync(new URL('../migrations/0045_project_delete.sql', import.meta.url)));
  const api = read('src/routes/api.ts');
  assert.match(api, /api\.post\('\/console\/projects\/:id\/delete'/);
  assert.match(read('web/src/pages/Project.tsx'), /\/console\/projects\/\$\{id\}\/delete/);
  assert.match(read('src/routes/admin.ts'), /removed_reason = NULL, deleted_at = NULL/);
});

// ---- #3 orientation declared after the last deploy
test('#3 a declaration the version does not carry is named field by field', () => {
  const version = { ...emptyRequirements(), input: ['keyboard', 'mouse', 'touch'] };
  const declared = parseRequirements({ graphics: 'canvas', input: ['touch', 'keyboard', 'mouse'], devices: ['desktop', 'tablet', 'mobile'], orientation: 'landscape' }).value;
  assert.deepEqual(requirementsDrift(declared, version), [{ field: 'orientation', declared: 'landscape', version: 'both' }]);
  assert.deepEqual(requirementsDrift(parseRequirements({ orientation: 'both' }).value, version), []);
  assert.deepEqual(requirementsDrift({}, version), []);
});

test('#3 publish, its dry run and the declare calls say when the version predates the declaration', () => {
  const pub = tools.slice(tools.indexOf('async function publishVersion'), tools.indexOf('export const TOOLS'));
  assert.match(pub, /const drift = rollback \? \{\} : await declaredNotInVersion\(c, p, v\)/);
  assert.match(pub, /if \(a\.dry_run\) return \{ \.\.\.drift,/);
  assert.match(pub, /return \{ live, version: v\.n, \.\.\.drift,/);
  assert.match(tools, /not_in_this_version:/);
  assert.match(entry('game_metadata'), /declaredNotInVersion\(c, p, await newestVersion\(c, p\)\)/);
  assert.match(entry('compatibility'), /declaredNotInVersion\(c, p, await newestVersion\(c, p\)\)/);
});

// ---- #2 responds: a still title screen that reacts to the player
const S = (o) => JSON.stringify(o);
test('#2 a change seen only in the middle of the input counts (cards turned back over by the end)', () => {
  assert.deepEqual(respondsBy({ moved: 0.05 }), { ok: true, by: 'picture' });
  const src = read('src/verify-core.js');
  assert.match(src, /midInput\.push\(await quickShot\(\)\)/);
  assert.match(src, /for \(const a of before\) for \(const b of after\) moved = Math\.max\(moved, pixelChange\(a, b\)\)/);
});

test('#2 the game\'s own state changed by input counts; a timer ticking by itself does not', () => {
  assert.equal(respondsBy({ state: { idle: [S({ state: 'title', moves: 0 }), S({ state: 'title', moves: 0 })], input: [S({ state: 'title', moves: 0 }), S({ state: 'play', moves: 1 })] } }).by, 'state');
  assert.equal(respondsBy({ state: { idle: [S({ t: 1 }), S({ t: 2 })], input: [S({ t: 3 }), S({ t: 4 })] } }).ok, false);
  assert.equal(respondsBy({ state: { idle: [S({ t: 1, sel: 0 }), S({ t: 2, sel: 0 })], input: [S({ t: 3, sel: 0 }), S({ t: 4, sel: 2 })] } }).ok, true);
});

test('#2 a sound started by input counts only when none starts with nothing pressed', () => {
  assert.deepEqual(respondsBy({ audio: { idle: 0, input: 2 } }), { ok: true, by: 'sound', starts: 2 });
  assert.equal(respondsBy({ audio: { idle: 1, input: 4 } }).ok, false);
});

test('#2 a still picture that ignores the player still fails', () => {
  assert.deepEqual(respondsBy({ moved: 0.001, dom: 0, state: { idle: [S({ a: 1 }), S({ a: 1 })], input: [S({ a: 1 }), S({ a: 1 })] }, audio: { idle: 0, input: 0 } }), { ok: false, by: '' });
  assert.deepEqual(respondsBy(), { ok: false, by: '' });
});
