// Working on one game from more than one machine: what changed between two versions, a deploy on a stale base refused
// with what came in between, line diffs, and the tools that carry it (pull_version, checkout_version, diff_versions).
// tests/version-sync-live.mjs runs the whole two-agent flow against a local Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { diffFiles, diffLine, isSame, checkBase, textDiff } = await import('../src/version-sync.ts');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts'), projects = read('src/projects.ts');
const entry = (name) => { const i = tools.indexOf(`name: '${name}'`); assert.ok(i > 0, name); const j = tools.indexOf("\n    name: '", i + 10); return tools.slice(i, j > 0 ? j : undefined); };
const f = (path, sha, size = 10) => ({ path, sha, size });

test('files are compared by hash: added, removed, changed, unchanged', () => {
  const d = diffFiles([f('index.html', 'a'), f('src/game.js', 'b'), f('old.png', 'c')], [f('index.html', 'a'), f('src/game.js', 'B', 12), f('new.png', 'd')]);
  assert.deepEqual(d.changed, [{ path: 'src/game.js', bytes_before: 10, bytes_after: 12 }]);
  assert.deepEqual(d.added.map((x) => x.path), ['new.png']);
  assert.deepEqual(d.removed.map((x) => x.path), ['old.png']);
  assert.equal(d.unchanged, 1);
  assert.equal(diffLine(d), '1 changed (src/game.js), 1 added (new.png), 1 removed (old.png)');
  assert.ok(isSame(diffFiles([f('a', '1')], [f('a', '1')])));
  assert.equal(diffLine(diffFiles([], [])), 'no file changed');
});

test('a deploy whose base is the newest version goes ahead; a stale base names what came in between', () => {
  assert.deepEqual(checkBase(4, 4, []), { ok: true });
  assert.deepEqual(checkBase(0, 0, []), { ok: true }, 'the first deploy, base 0');
  const v = checkBase(2, 4, [{ n: 3, actor: 'Codex (ci)', note: 'boss fight', created_at: 0 }, { n: 4, actor: 'Claude Code' }]);
  assert.equal(v.ok, false); assert.equal(v.code, 'stale_base'); assert.equal(v.newest, 4);
  assert.match(v.message, /start from version 2, but 2 newer versions were deployed since: version 3 by Codex \(ci\)/);
  assert.match(v.message, /"boss fight"/); assert.match(v.message, /version 4 by Claude Code/);
  for (const bad of [5, -1, 1.5, NaN]) assert.equal(checkBase(bad, 4, []).code, 'unknown_base', String(bad));
});

test('line diffs: the changed lines with context, deletions before additions, big inputs refused', () => {
  const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const r = textDiff(a, a.replace('line 5', 'line FIVE').replace('line 30\n', ''), 'src/x.js');
  assert.match(r.diff, /^--- a\/src\/x\.js\n\+\+\+ b\/src\/x\.js\n@@ -3,7 \+3,7 @@\n line 2\n line 3\n line 4\n-line 5\n\+line FIVE\n line 6/);
  assert.match(r.diff, /\n-line 30\n/);
  assert.equal((r.diff.match(/^@@/gm) || []).length, 2, 'two hunks far apart');
  assert.equal(r.truncated, false);
  assert.equal(textDiff('x\n'.repeat(3000), 'y\n'.repeat(3000), 'big.js', { maxCells: 1000 }), null);
  assert.equal(textDiff('same', 'same', 's.js').diff, '--- a/s.js\n+++ b/s.js');
  const long = textDiff(Array.from({ length: 900 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 900 }, (_, i) => `b${i}`).join('\n'), 'l.js', { maxLines: 50 });
  assert.equal(long.truncated, true); assert.equal(long.diff.split('\n').length, 50);
});

test('deploy_preview refuses a stale base_version, and takes the number only while the base is still the newest', () => {
  const d = entry('deploy_preview');
  assert.match(d, /base_version: \{ type: 'integer'/); assert.match(d, /force: \{ type: 'boolean'/); assert.match(d, /by: \{ type: 'string'/);
  assert.match(d, /checkBase\(base, line\.newest, await versionsAfter/);
  assert.match(d, /verdict\.code === 'unknown_base' \|\| a\.force !== true\)\) return await baseConflict/);
  assert.match(d, /snapshot\(c\.env, p, check\.manifest, String\(a\.note \|\| ''\), \{ base, actor: by, expectNewest, ws: t\.ws, branch: bid \}\)/);
  assert.match(d, /if \(!v\) \{/, 'losing the race is a conflict too');
  // the number is taken in one batch with the row, and only while main's (or the branch's) newest is still the base
  assert.match(projects, /COALESCE\(\(SELECT MAX\(n\) FROM versions WHERE project_id = \?1 AND branch IS NULL\), 0\) = \?5/);
  assert.match(projects, /COALESCE\(\(SELECT head_version FROM branches WHERE id = \?4\), 0\) = \?5/);
  assert.match(projects, /FROM projects WHERE id = \?1 AND alloc_token = \?2/);
  assert.match(projects, /UPDATE projects SET ws_base = next_version - 1 WHERE id = \?1 AND alloc_token = \?2/);
  assert.match(tools, /conflict: 'newer_version'/);
});

test('pull_version, checkout_version and diff_versions are read-only, guarded and bounded as they say', () => {
  assert.match(entry('pull_version'), /annotations: \{ readOnlyHint: true \}/);
  assert.match(entry('pull_version'), /INSERT INTO downloads/);
  assert.match(entry('pull_version'), /PULL_INLINE\.bytes/);
  assert.match(entry('checkout_version'), /annotations: \{ destructiveHint: true \}/);
  assert.match(entry('checkout_version'), /if \(unsaved && a\.force !== true\)/);
  assert.match(entry('diff_versions'), /annotations: \{ readOnlyHint: true \}/);
  assert.match(entry('diff_versions'), /DIFF_LIMITS\.file_bytes/);
  const up = read('src/routes/upload.ts');
  assert.match(up, /FROM downloads WHERE token_hash = \?/);
  assert.match(up, /accessProject\(env, user, g\.project_id, 'read'\)/, 'a download needs a role on the project');
  assert.match(read('src/index.ts'), /DELETE FROM downloads WHERE expires_at < \?/);
  assert.match(read('src/version-store.ts'), /new ZipPassThrough\(f\.path\)/, 'the zip is streamed, not built in memory');
});
