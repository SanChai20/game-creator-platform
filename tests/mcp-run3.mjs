// What the third end-to-end agent run (Haiku 5.5, MCP test run 3) found, each held in place: list_projects shows the
// genre apart from the tags, a publish refusal says when build fields were declared after the version was deployed,
// game_data says when a key it did not find is in the other environment, and a missing argument names its allowed values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { explainFrozenMeta, gateText } = await import('../src/release-gate.ts');
const { missingArgs } = await import('../src/mcp/schema.ts');
const { missingToPublish } = await import('../web/src/tags.ts');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts');
const entry = (name) => { const i = tools.indexOf(`name: '${name}'`); assert.ok(i > 0, name); const j = tools.indexOf("\n    name: '", i + 10); return tools.slice(i, j > 0 ? j : undefined); };

test('#1 list_projects splits the genre out of the stored tags, with and without project', () => {
  const lp = entry('list_projects');
  assert.doesNotMatch(lp, /tags: JSON\.parse\(/, 'never the raw stored list, where the genre lives');
  // the list (own and shared projects) and one project
  assert.equal((lp.match(/tagAnswer\(/g) || []).length, 3);
});

const metaFailure = (missing) => ({ id: 'metadata', title: 'Store metadata', status: 'fail', waivable: false, missing, reason: `Version 1 cannot be published until its store metadata is complete. Missing: ${missing.join('; ')}.`, fix: 'game_metadata …' });
const full = { declared: ['languages', 'players', 'content'] };

test('#2 the publish refusal says build fields declared since the version apply from the next deploy', () => {
  const missing = missingToPublish({ declared: [] }, false, ['arcade', '2d', 'retro']);
  assert.deepEqual(missing.map((m) => m.split(' ')[0]), ['requirements', 'languages', 'players', 'content']);
  const f = metaFailure(missing);
  const declared = explainFrozenMeta(f, 1, missingToPublish(full, true, ['arcade', '2d', 'retro']));
  assert.deepEqual(declared, ['requirements', 'languages', 'players', 'content']);
  assert.match(f.reason, /declared now, but after version 1 was deployed/);
  assert.match(f.reason, /apply from the next deploy_preview/);
  assert.match(f.fix, /^Call deploy_preview \{project\}/);
  const g = { ok: false, ruleset: 'x', version: 1, failures: [f] };
  assert.match(gateText(g), /after version 1 was deployed.*What to do: Call deploy_preview/s);
});

test('#2 a field still missing in the workspace is named as still to declare', () => {
  const f = metaFailure(missingToPublish({ declared: [] }, false, ['arcade', '2d', 'retro']));
  const declared = explainFrozenMeta(f, 4, missingToPublish({ declared: ['languages', 'players'] }, true, ['arcade', '2d', 'retro']));
  assert.deepEqual(declared, ['requirements', 'languages', 'players']);
  assert.match(f.fix, /^Declare the rest first \(content/);
});

test('#2 nothing changes when the workspace has not declared them either, or for other rules', () => {
  const m = missingToPublish({ declared: [] }, false, ['arcade', '2d']), f = metaFailure(m), before = { ...f };
  assert.deepEqual(explainFrozenMeta(f, 1, m), []);
  assert.deepEqual(f, before);
  assert.deepEqual(explainFrozenMeta({ id: 'verified', missing: ['x'] }, 1, []), []);
  assert.deepEqual(explainFrozenMeta(undefined, 1, []), []);
  const pub = tools.slice(tools.indexOf('const gate = await releaseGate(c.env, p, v'));
  assert.ok(pub.indexOf('explainFrozenMeta(') < pub.indexOf('if (a.dry_run)'), 'dry runs explain it too');
});

test('#3 game_data hints at the other environment when env was left out and nothing was found', () => {
  const gd = entry('game_data');
  assert.match(gd, /if \(a\.env !== undefined\) return \{\};/, 'only when env was defaulted');
  assert.match(gd, /exists: !!r, \.\.\.\(r \? \{\} : await otherHint\('key'\)\)/);
  assert.match(gd, /deleted: \(r\.meta\.changes \|\| 0\) > 0, \.\.\.\(r\.meta\.changes \? \{\} : await otherHint\('key'\)\)/);
  assert.match(gd, /rows\.results\.length \? \{\} : await otherHint\('keys'\)/);
  assert.match(gd, /Pass env: "\$\{other\}"/);
});

test('#4 a missing required argument names its allowed values', () => {
  const schema = { properties: { project: { type: 'string' }, action: { type: 'string', enum: ['get', 'write'] } }, required: ['project', 'action'] };
  assert.equal(missingArgs(schema, { project: 'p', action: 'get' }), null);
  assert.equal(missingArgs(schema, { project: 'p' }), 'Missing required argument: action (one of: get, write).');
  assert.equal(missingArgs(schema, { action: '' }), 'Missing required arguments: project, action (one of: get, write).');
  assert.match(read('src/mcp/server.ts'), /const missing = missingArgs\(tool\.inputSchema as any, args\);/);
});
