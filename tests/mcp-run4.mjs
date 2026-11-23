// What the fourth end-to-end agent run (Haiku 5.5, MCP test run 4) found, each held in place: upload_files refuses an
// edit or file with keys it does not know (and reads old/new as old_string/new_string), the input check reads
// GCP.test.onState field by field so a ticking timer does not hide the player's input and the report names it, and no
// call waits longer than a client or proxy safely holds a call open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { checkItem } = await import('../src/mcp/schema.ts');
const { stateReaction, stateLeaves } = await import('../src/verify-core.js');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts');
const entry = (name) => { const i = tools.indexOf(`name: '${name}'`); assert.ok(i > 0, name); const j = tools.indexOf("\n    name: '", i + 10); return tools.slice(i, j > 0 ? j : undefined); };
const EDIT = { properties: { path: {}, old_string: {}, new_string: {}, replace_all: {} }, required: ['path', 'old_string', 'new_string'] };
const ALIASES = { old: 'old_string', new: 'new_string', old_str: 'old_string', new_str: 'new_string', file: 'path' };

test('#1 an edit with old/new is read as old_string/new_string', () => {
  const r = checkItem('edits[0]', { path: 'a.js', old: 'x = 1', new: 'x = 2' }, EDIT, ALIASES);
  assert.deepEqual(r, { item: { path: 'a.js', old_string: 'x = 1', new_string: 'x = 2' } });
});

test('#1 an unknown key in an edit refuses the call and names the accepted keys', () => {
  const r = checkItem('edits[1]', { path: 'a.js', before: 'x', after: 'y' }, EDIT, ALIASES);
  assert.match(r.error, /^edits\[1\]: unknown keys before, after\. Each item accepts: path, old_string, new_string, replace_all\.$/);
  assert.match(checkItem('edits[0]', { path: 'a.js', old_string: 'x' }, EDIT, ALIASES).error, /missing new_string/);
  assert.match(checkItem('edits[0]', { path: 'a.js', old: 'x', old_string: 'x', new_string: 'y' }, EDIT, ALIASES).error, /both old and old_string/);
  assert.match(checkItem('edits[0]', 'old=x', EDIT, ALIASES).error, /must be an object/);
});

test('#1 upload_files holds files and edits to their item schemas before anything else', () => {
  const up = entry('upload_files');
  assert.match(up, /items\('files', FILE_ALIASES\), edits: any\[\] = items\('edits', EDIT_ALIASES\)/);
  assert.match(up, /items: UPLOAD_ITEMS\.edits/);
  assert.match(tools, /old: 'old_string', new: 'new_string'/);
});

const S = (o) => JSON.stringify(o);
test('#2 a timer that ticks by itself does not hide the field input changed', () => {
  const r = stateReaction([
    { idle: [S({ timeLeft: 30, basket: 50 }), S({ timeLeft: 29, basket: 50 })], input: [S({ timeLeft: 29, basket: 50 }), S({ timeLeft: 28, basket: 88 })] },
    { idle: [S({ timeLeft: 27, basket: 88 }), S({ timeLeft: 26, basket: 88 })], input: [S({ timeLeft: 26, basket: 88 }), S({ timeLeft: 25, basket: 88 })] },
  ]);
  assert.deepEqual(r.selfFields, ['timeLeft']);
  assert.deepEqual(r.inputFields, ['basket']);
  assert.equal(r.stateInput, 1);
});

test('#2 state that only changes by itself counts for nothing, and names the fields', () => {
  const r = stateReaction([{ idle: [S({ t: 1, fx: { a: 1 } }), S({ t: 2, fx: { a: 2 } })], input: [S({ t: 2, fx: { a: 2 } }), S({ t: 3, fx: { a: 3 } })] }]);
  assert.deepEqual(r.selfFields, ['t', 'fx.a']);
  assert.deepEqual(r.inputFields, []);
  assert.equal(r.stateInput, 0);
});

test('#2 state that is not an object is compared whole, as before', () => {
  assert.deepEqual(stateReaction([{ idle: ['"a"', '"a"'], input: ['"a"', '"b"'] }]), { stateIdle: 0, stateInput: 1, selfFields: [], inputFields: [] });
  assert.deepEqual(stateReaction([]), { stateIdle: 0, stateInput: 0, selfFields: [], inputFields: [] });
  assert.deepEqual(stateLeaves(S({ p: [1, { x: 2 }] })), { 'p[0]': '1', 'p[1].x': '2' });
  assert.deepEqual(stateLeaves(S(S({ b: 1 }))), { b: '1' }, 'the SDK hands over JSON text, read() encodes it again');
});

test('#2 the input check uses it, and its failure names the fields that changed by themselves', () => {
  const v = read('src/verify-core.js');
  assert.match(v, /const \{ stateIdle, stateInput, selfFields, inputFields \} = stateReaction\(stateRounds\);/);
  assert.match(v, /In GCP\.test\.onState, \$\{selfFields\.slice\(0, 6\)\.join\(', '\)\} changed with nothing pressed/);
  assert.match(v, /changed by \$\{selfFields\.length > 1 \? 'themselves' : 'itself'\} and nothing else in onState changed with input/);
});

test('#3 no call waits longer than a proxy holds a call open, and a longer ask says so', () => {
  const m = tools.match(/export const MAX_WAIT_S = (\d+);/);
  assert.ok(Number(m[1]) <= 55, `MAX_WAIT_S ${m[1]}`);
  assert.ok(Number(tools.match(/export const DEPLOY_WAIT_MS = (\d+);/)[1]) <= Number(m[1]) * 1000);
  assert.match(entry('deploy_preview'), /\.\.\.waitNote\(a\.wait_seconds\)/);
  assert.match(entry('list_versions'), /\.\.\.waitNote\(a\.wait_seconds\)/);
  assert.match(tools, /\.\.\.waitNote\(wait\)/, 'retry_version too');
  assert.match(tools, /the deploy goes on without this call/);
});
