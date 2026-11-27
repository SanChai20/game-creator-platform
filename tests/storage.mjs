// Per-game storage: the budget, which changes are refused, the warning agents relay to developers, and that every way in
// (MCP tools, the upload URL, deploy, publish) goes through the same check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MB, WARN_AT, breakdown, budgetOf, checkChange, kindOf, storageStatus } from '../src/storage-rules.ts';
import { platformServices } from '../src/mcp/services.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const S = { bundle_max_bytes: 50 * MB, bundle_max_files: 300, file_max_bytes: 20 * MB };
const files = [{ path: 'index.html', size: 1000 }, { path: 'a.glb', size: 30 * MB }, { path: 'b.ogg', size: 15 * MB }];

test('a game uses the platform default unless it has its own storage', () => {
  assert.deepEqual(budgetOf({}, S), { bytes: 50 * MB, files: 300, file: 20 * MB, source: 'default' });
  assert.equal(budgetOf({ storage_bytes: null }, S).source, 'default');
  assert.equal(budgetOf({ storage_bytes: 120 * MB }, S).bytes, 120 * MB);
  assert.equal(budgetOf({ storage_bytes: 10 * MB }, S).bytes, 10 * MB, 'an admin can also lower one game');
});

test('changes that fit pass; growth past the storage is refused', () => {
  const b = budgetOf({}, S);
  assert.equal(checkChange(files, [{ path: 'c.png', size: 4 * MB }], [], b), null);
  const r = checkChange(files, [{ path: 'c.png', size: 6 * MB }], [], b);
  assert.equal(r.kind, 'bytes');
  assert.match(r.message, /over its 50 MB of storage/);
  assert.equal(checkChange(files, [{ path: 'big.glb', size: 21 * MB }], [], b).kind, 'file');
});

test('a call is judged as a whole: replacing and deleting make room', () => {
  const b = budgetOf({}, S);
  assert.equal(checkChange(files, [{ path: 'b.ogg', size: 19 * MB }], [], b), null, 'replacing a file counts only the new size');
  assert.equal(checkChange(files, [{ path: 'c.glb', size: 20 * MB }], ['a.glb'], b), null, 'deleting in the same call frees space');
});

test('a game already over its storage can always shrink', () => {
  const b = budgetOf({ storage_bytes: 20 * MB }, S);
  assert.equal(checkChange(files, [{ path: 'b.ogg', size: 5 * MB }], [], b), null);
  assert.equal(checkChange(files, [], ['a.glb'], b), null);
  assert.equal(checkChange(files, [{ path: 'x.png', size: 1 }], [], b).kind, 'bytes');
});

test('the file count is enforced', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ path: `f${i}.js`, size: 1 }));
  assert.equal(checkChange(many, [{ path: 'one-more.js', size: 1 }], [], budgetOf({}, S)).kind, 'files');
  assert.equal(checkChange(many, [{ path: 'f1.js', size: 2 }], [], budgetOf({}, S)), null);
});

test('answers warn from 80% used and when over', () => {
  const b = budgetOf({}, S);
  assert.equal(storageStatus(10 * MB, b, true).warning, undefined);
  const near = storageStatus(Math.ceil(50 * MB * WARN_AT), b, true);
  assert.equal(near.percent_used, 80);
  assert.match(near.warning, /Tell the developer/);
  const over = storageStatus(60 * MB, b, true);
  assert.match(over.warning, /Over storage/);
  assert.match(over.warning, /game_storage/);
  assert.doesNotMatch(storageStatus(60 * MB, b, false).warning, /action: "request"/, 'no request hint when requests are closed');
});

test('the breakdown shows what uses the space', () => {
  assert.equal(kindOf('m/tree.glb'), 'models');
  assert.equal(kindOf('t/bark.ktx2'), 'textures and images');
  assert.equal(kindOf('game.wasm'), 'engine data (wasm, pck, data)');
  const b = breakdown(files);
  assert.equal(b.by_kind[0].kind, 'models');
  assert.equal(b.largest[0].path, 'a.glb');
});

test('every way in goes through the storage check', () => {
  const projects = read('src/projects.ts'), tools = read('src/mcp/tools.ts'), upload = read('src/routes/upload.ts');
  assert.match(projects, /if \(!budgetChecked\) assertFits\(/, 'putFile checks unless the caller checked the whole change');
  assert.match(projects, /overBudget\(s, p, bytes, files\.length\)/, 'deploy_preview static checks');
  assert.match(tools, /assertFits\(s, p, before,/, 'upload_files checks the whole call');
  assert.match(tools, /assertFits\(s, p, existing,/, 'zip import checks before unpacking');
  assert.match(read('src/release-gate.ts'), /overBudget\(s, p, v\.bytes, v\.file_count\)/, 'publish (the release gate)');
  for (const m of tools.matchAll(/putFile\([^)]*\)/g)) if (!/'gcp\.json'/.test(m[0])) assert.match(m[0], /, true(, [\w.]+)?\)$/, `${m[0]} skips the check only after checking`);
  assert.match(upload, /putFile\(c\.env, project, path, buf, false, t\.ws\)/);
});

test('agents are told: get_started, the tool, the catalog and the guides', () => {
  const tools = read('src/mcp/tools.ts');
  assert.match(tools, /name: 'game_storage'/);
  assert.match(tools, /tell_the_developer/);
  assert.match(tools, /topic: 'storage', file: 'storage'/);
  const svc = platformServices({ ...S, storage_requests_open: true, storage_max_bytes: 200 * MB, storage_auto_approve_bytes: 0, room_max_peers: 16, projects_per_user: 50, verify_ready_timeout_s: 30, allow_server_code: true, paid_games_enabled: true, require_login_to_play: true }, '').find((s) => s.id === 'storage');
  assert.equal(svc.limits.storage_per_game, '50 MB');
  assert.ok(svc.mcp_tools.includes('game_storage'));
  const guide = read('web/public/guides/storage.md');
  for (const w of ['CORS', 'GCP.ready()', 'game_storage', 'storage_full']) assert.ok(guide.includes(w), `storage guide mentions ${w}`);
  assert.match(read('web/public/guides/platform-contract.md'), /Fit the game's storage/);
});
