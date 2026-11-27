// Collaboration rules (src/collab-core.ts): roles and permissions, branch names, main's protection, whether a change
// request can merge, the three-way tree merge, and the diff and diff3 text merge, fuzzed against a reference.
// The live, concurrent side (invites, branches, merges racing each other) is tests/collab-live.mjs against a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./ts-hook.mjs', import.meta.url);
const C = await import('../src/collab-core.ts');
const { atLeast, can, PERMS, branchName, parseProtection, updateProtection, DEFAULT_PROTECTION, mayPushMain, mergeability, mergeTrees, diffHunks, merge3Text, hasConflictMarkers, mayManage, inviteOpen, looksLikeEmail, normEmail } = C;

// a seeded random source so a failure can be replayed
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n) => Math.floor(rnd() * n);

test('roles rank like GitHub: read < write < maintain < admin < owner', () => {
  const order = ['read', 'write', 'maintain', 'admin', 'owner'];
  for (const [i, a] of order.entries()) for (const [j, b] of order.entries()) assert.equal(atLeast(a, b), i >= j, `${a} ≥ ${b}`);
  assert.equal(atLeast(null, 'read'), false);
  assert.equal(atLeast(undefined, 'read'), false);
  assert.equal(atLeast('nonsense', 'read'), false);
  // the money and the project itself are the owner's alone
  for (const a of ['pricing', 'delete_project', 'grant_admin', 'earnings']) { assert.equal(PERMS[a], 'owner'); assert.equal(can('admin', a), false); assert.equal(can('owner', a), true); }
  assert.equal(can('write', 'push_main'), false);
  assert.equal(can('write', 'review'), true);
  assert.equal(can('read', 'review'), false);
  assert.equal(can('maintain', 'merge'), true);
  assert.equal(can('maintain', 'publish'), false);
  assert.equal(can('admin', 'publish'), true);
});

test('branch names', () => {
  for (const ok of ['ab', 'boss-fight', 'anna/menus', 'v1.2', 'x_y', 'a'.repeat(48), 'Boss-Fight']) assert.ok(branchName(ok).ok, ok);
  assert.equal(branchName('  Boss-Fight ').name, 'boss-fight');
  for (const bad of ['', 'a', 'a'.repeat(49), 'main', 'MAIN', 'head', 'master', 'live', 'preview', 'workspace', 'origin', '-x', 'x-', '/x', 'x/', 'a//b', 'a..b', 'a/.b', 'a./b', 'x.lock', 'a b', 'a~b', 'a:b', 'ä-b', '../etc', null, undefined])
    assert.equal(branchName(bad).ok, false, String(bad));
});

test('emails', () => {
  assert.equal(normEmail('  Ann@Example.COM '), 'ann@example.com');
  assert.ok(looksLikeEmail('a@b.co'));
  for (const bad of ['', 'a', 'a@b', '@b.co', 'a@.co', 'a b@c.de', 'a@b.c']) assert.equal(looksLikeEmail(bad), false, bad);
});

test('protection: parsed defensively, updated strictly', () => {
  assert.deepEqual(parseProtection(null), DEFAULT_PROTECTION);
  assert.deepEqual(parseProtection('not json'), DEFAULT_PROTECTION);
  assert.deepEqual(parseProtection('{"required_approvals":9,"main_writers":"write","allow_bypass":"yes"}'), { ...DEFAULT_PROTECTION, required_approvals: 5 });
  assert.equal(parseProtection({ required_approvals: -3 }).required_approvals, 0);
  const u = updateProtection(DEFAULT_PROTECTION, { required_approvals: 2, main_writers: 'admin', dismiss_stale: false });
  assert.ok(u.ok); assert.deepEqual(u.value, { ...DEFAULT_PROTECTION, required_approvals: 2, main_writers: 'admin', dismiss_stale: false });
  for (const bad of [{ required_approvals: 6 }, { required_approvals: 1.5 }, { required_approvals: '2' }, { require_verified: 1 }, { main_writers: 'write' }, { branch: 'x' }, { __proto__: 1, x: 2 }])
    assert.equal(updateProtection(DEFAULT_PROTECTION, bad).ok, false, JSON.stringify(bad));
  // the owner may always change main; write never may, whatever the setting
  for (const mw of ['maintain', 'admin', 'owner']) {
    const p = { ...DEFAULT_PROTECTION, main_writers: mw };
    assert.equal(mayPushMain('owner', p), true);
    assert.equal(mayPushMain('write', p), false);
    assert.equal(mayPushMain('read', p), false);
    assert.equal(mayPushMain(null, p), false);
    assert.equal(mayPushMain('maintain', p), mw === 'maintain');
    assert.equal(mayPushMain('admin', p), mw !== 'owner');
  }
});

test('who manages whom', () => {
  assert.ok(mayManage('owner', null, 'admin').ok);
  assert.ok(mayManage('owner', 'admin', null).ok);
  assert.ok(mayManage('admin', null, 'maintain').ok);
  assert.ok(mayManage('admin', 'write', 'read').ok);
  assert.equal(mayManage('admin', null, 'admin').ok, false);
  assert.equal(mayManage('admin', 'admin', 'read').ok, false);
  assert.equal(mayManage('admin', 'admin', null).ok, false);
  assert.equal(mayManage('maintain', null, 'read').ok, false);
  assert.equal(mayManage('write', 'read', null).ok, false);
  assert.equal(mayManage(null, null, 'read').ok, false);
  for (const a of ['owner', 'admin']) { assert.equal(mayManage(a, 'owner', 'read').ok, false); assert.equal(mayManage(a, 'read', 'owner').ok, false); }
});

test('invitations are open while pending and unexpired', () => {
  assert.ok(inviteOpen({ status: 'pending', expires_at: 2000 }, 1000));
  assert.equal(inviteOpen({ status: 'pending', expires_at: 1000 }, 1000), false);
  for (const s of ['accepted', 'declined', 'revoked', 'expired']) assert.equal(inviteOpen({ status: s, expires_at: 9e12 }, 1), false);
});

const state = (o = {}) => ({ status: 'open', author_id: 'ann', head: 3, head_status: 'verified', head_eligible: true, workspace_ahead: false, behind: 0, conflicts: [], reviews: [], ...o });
const rv = (user_id, verdict, version = 3, created_at = 1, dismissed = 0) => ({ user_id, verdict, version, created_at, dismissed });
const ids = (m) => m.blockers.map((b) => b.id).sort();

test('mergeability follows GitHub\'s required reviews', () => {
  const P = DEFAULT_PROTECTION;
  assert.deepEqual(ids(mergeability(state(), P)), ['approvals']);
  assert.ok(mergeability(state({ reviews: [rv('bea', 'approve')] }), P).mergeable);
  // the author's own approval never counts
  assert.deepEqual(ids(mergeability(state({ reviews: [rv('ann', 'approve')] }), P)), ['approvals']);
  // a stale approval (an older version) does not count when dismiss_stale is on, and does when it is off
  assert.deepEqual(ids(mergeability(state({ reviews: [rv('bea', 'approve', 2)] }), P)), ['approvals']);
  assert.ok(mergeability(state({ reviews: [rv('bea', 'approve', 2)] }), { ...P, dismiss_stale: false }).mergeable);
  // a request for changes blocks until the same reviewer approves; a later comment does not lift it
  const ch = [rv('bea', 'request_changes', 3, 1), rv('cal', 'approve', 3, 2)];
  assert.deepEqual(ids(mergeability(state({ reviews: ch }), P)), ['changes_requested']);
  assert.deepEqual(ids(mergeability(state({ reviews: [...ch, rv('bea', 'comment', 3, 3)] }), P)), ['changes_requested']);
  assert.ok(mergeability(state({ reviews: [...ch, rv('bea', 'approve', 3, 3)] }), P).mergeable);
  // a dismissed review is gone, and the reviewer's previous verdict does not come back
  assert.ok(mergeability(state({ reviews: [rv('bea', 'request_changes', 3, 1, 1), rv('cal', 'approve', 3, 2)] }), P).mergeable);
  // the order of the rows does not matter, only created_at
  assert.ok(mergeability(state({ reviews: [rv('bea', 'approve', 3, 3), rv('bea', 'request_changes', 3, 1)] }), P).mergeable);
  // two approvals needed
  assert.deepEqual(ids(mergeability(state({ reviews: [rv('bea', 'approve')] }), { ...P, required_approvals: 2 })), ['approvals']);
  assert.ok(mergeability(state({ reviews: [rv('bea', 'approve'), rv('cal', 'approve')] }), { ...P, required_approvals: 2 }).mergeable);
  // a zero-approval project still needs a verified version without conflicts
  const Z = { ...P, required_approvals: 0 };
  assert.ok(mergeability(state(), Z).mergeable);
  assert.deepEqual(ids(mergeability(state({ head: null, head_status: null, head_eligible: false }), Z)), ['no_version']);
  assert.deepEqual(ids(mergeability(state({ head_status: 'failed', head_eligible: false }), Z)), ['verification']);
  assert.ok(mergeability(state({ head_status: 'failed', head_eligible: false }), { ...Z, require_verified: false }).mergeable);
  assert.deepEqual(ids(mergeability(state({ conflicts: ['src/a.js'] }), Z)), ['conflicts']);
  assert.deepEqual(ids(mergeability(state({ status: 'merged' }), Z)), ['not_open']);
  // warnings never block
  const w = mergeability(state({ workspace_ahead: true, behind: 2 }), Z);
  assert.ok(w.mergeable); assert.equal(w.warnings.length, 2);
});

test('only approvals and a failed verification can be bypassed', () => {
  const P = DEFAULT_PROTECTION;
  assert.ok(mergeability(state(), P).bypassable);
  assert.ok(mergeability(state({ head_status: 'failed', head_eligible: false, reviews: [rv('bea', 'request_changes')] }), P).bypassable);
  assert.equal(mergeability(state(), { ...P, allow_bypass: false }).bypassable, false);
  for (const o of [{ conflicts: ['a'] }, { status: 'closed' }, { head: null, head_eligible: false }, { head_status: 'verifying', head_eligible: false }])
    assert.equal(mergeability(state(o), P).bypassable, false, JSON.stringify(o));
  assert.equal(mergeability(state({ reviews: [rv('bea', 'approve')] }), P).bypassable, false, 'nothing to bypass');
});

const sig = (path, sha) => ({ path, size: sha.length, sha });
test('three-way tree merge', () => {
  const base = [sig('a', '1'), sig('b', '1'), sig('c', '1'), sig('d', '1'), sig('e', '1')];
  const ours = [sig('a', '2'), sig('b', '1'), sig('c', '2'), sig('d', '2'), sig('n', '1'), sig('m', '1')];       // e deleted
  const theirs = [sig('a', '1'), sig('b', '2'), sig('c', '3'), sig('e', '2'), sig('n', '1'), sig('m', '2')];      // d deleted
  const r = mergeTrees(base, ours, theirs);
  const pick = Object.fromEntries(r.picks.map((p) => [p.path, p.from === 'deleted' ? 'deleted' : `${p.from}:${p.sig.sha}`]));
  assert.deepEqual(pick, { a: 'ours:2', b: 'theirs:2', n: 'ours:1' });
  assert.deepEqual(r.both.map((x) => [x.path, x.kind]), [['c', 'both_changed'], ['m', 'both_added']]);
  assert.deepEqual(r.conflicts.map((x) => [x.path, x.kind]), [['d', 'changed_deleted'], ['e', 'deleted_changed']]);
  // both deleted, one deleted an unchanged file
  const r2 = mergeTrees([sig('x', '1'), sig('y', '1')], [sig('y', '1')], []);
  assert.deepEqual(r2.picks.map((p) => [p.path, p.from]), [['x', 'deleted'], ['y', 'deleted']]);
  assert.equal(r2.conflicts.length + r2.both.length, 0);
});

test('tree merge fuzz: every path is decided exactly once, and symmetric', () => {
  for (let n = 0; n < 2000; n++) {
    const gen = () => { const out = []; for (const p of ['a', 'b', 'c', 'd', 'e']) if (rnd() < 0.7) out.push(sig(p, String(ri(3)))); return out; };
    const b = gen(), o = gen(), t = gen();
    const r = mergeTrees(b, o, t), s = mergeTrees(b, t, o);
    const all = [...r.picks.map((x) => x.path), ...r.both.map((x) => x.path), ...r.conflicts.map((x) => x.path)].sort();
    const want = [...new Set([...b, ...o, ...t].map((f) => f.path))].sort().filter((p) => b.some((f) => f.path === p) || o.some((f) => f.path === p) || t.some((f) => f.path === p));
    // a path none of the three lists... cannot exist; one that only base had and both sides deleted is a 'deleted' pick
    assert.deepEqual(all, want);
    assert.deepEqual(r.both.map((x) => x.path), s.both.map((x) => x.path));
    assert.deepEqual(r.conflicts.map((x) => x.path), s.conflicts.map((x) => x.path));
    // a side that changed nothing yields the other side exactly
    const keep = mergeTrees(b, b, t);
    assert.equal(keep.both.length + keep.conflicts.length, 0);
    const res = keep.picks.filter((p) => p.from !== 'deleted').map((p) => `${p.path}:${p.sig.sha}`).sort();
    assert.deepEqual(res, t.map((f) => `${f.path}:${f.sha}`).sort());
  }
});

// a reference LCS length by dynamic programming, to check the diff is minimal
const lcs = (a, b) => { const d = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1)); for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]); return d[a.length][b.length]; };
const apply = (a, b, hunks) => { const out = []; let pos = 0; for (const h of hunks) { out.push(...a.slice(pos, h.a0), ...b.slice(h.b0, h.b1)); pos = h.a1; } out.push(...a.slice(pos)); return out; };
const randLines = (n, alpha = 4) => Array.from({ length: n }, () => 'abcdefgh'[ri(alpha)]);

test('diff fuzz: hunks rebuild the target, are ordered and apart, and the edit is minimal', () => {
  for (let n = 0; n < 3000; n++) {
    const a = randLines(ri(14)), b = rnd() < 0.3 ? a.map((x) => (rnd() < 0.2 ? 'z' : x)) : randLines(ri(14));
    const h = diffHunks(a, b);
    assert.deepEqual(apply(a, b, h), b, JSON.stringify({ a, b, h }));
    for (let i = 0; i < h.length; i++) {
      assert.ok(h[i].a0 <= h[i].a1 && h[i].b0 <= h[i].b1 && (h[i].a1 > h[i].a0 || h[i].b1 > h[i].b0), 'non-empty hunk');
      if (i) assert.ok(h[i].a0 > h[i - 1].a1 && h[i].b0 > h[i - 1].b1, 'hunks are apart by a common line');
    }
    const edits = h.reduce((s, x) => s + (x.a1 - x.a0) + (x.b1 - x.b0), 0);
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b), 'minimal');
  }
  assert.deepEqual(diffHunks([], []), []);
  assert.equal(diffHunks(randLines(300, 8), randLines(300, 8), 5), null, 'gives up past maxD');
});

test('diff3: clean merges, identical changes, conflicts with markers', () => {
  const L = (...x) => x.join('\n');
  const base = L('one', 'two', 'three', 'four', 'five', 'six', 'seven');
  const ours = L('ONE', 'two', 'three', 'four', 'five', 'six', 'seven');
  const theirs = L('one', 'two', 'three', 'four', 'five', 'six', 'SEVEN');
  assert.deepEqual(merge3Text(base, ours, theirs), { text: L('ONE', 'two', 'three', 'four', 'five', 'six', 'SEVEN'), conflicts: 0, regions: [] });
  // the same change on both sides is not a conflict
  assert.equal(merge3Text(base, ours, ours).conflicts, 0);
  const both = L('one', 'TWO', 'three', 'four', 'five', 'six', 'seven');
  // the same line changed differently
  // overlapping changes that agree on part conflict only on the rest (git's zealous merge trims what both sides share)
  const z = merge3Text(base, L('ONE', 'TWO', 'three', 'four', 'five', 'six', 'seven'), L('one', 'TWO', 'three', 'four', 'five', 'six', 'SEVEN'));
  assert.equal(z.conflicts, 1);
  assert.equal(z.text, L('<<<<<<< main', 'ONE', '=======', 'one', '>>>>>>> branch', 'TWO', 'three', 'four', 'five', 'six', 'SEVEN'));
  const m = merge3Text(base, both, L('one', '2', 'three', 'four', 'five', 'six', 'seven'));
  assert.equal(m.conflicts, 1);
  assert.equal(m.text, L('one', '<<<<<<< main', 'TWO', '=======', '2', '>>>>>>> branch', 'three', 'four', 'five', 'six', 'seven'));
  assert.ok(hasConflictMarkers(m.text));
  // adjacent lines are one conflict, as in git
  assert.equal(merge3Text(base, ours, L('one', 'TWO', 'three', 'four', 'five', 'six', 'seven')).conflicts, 1);
  // insertions at the same place differ: conflict; a deletion and an edit of the same line: conflict
  assert.equal(merge3Text(base, L(base, 'x'), L(base, 'y')).conflicts, 1);
  assert.equal(merge3Text(base, L('one', 'three', 'four', 'five', 'six', 'seven'), both).conflicts, 1);
  // labels
  assert.match(merge3Text('a', 'b', 'c', { ours: 'main', theirs: 'bea/bg' }).text, /^<<<<<<< main\nb\n=======\nc\n>>>>>>> bea\/bg$/);
  // CRLF files keep their line ends
  const crlf = merge3Text('a\r\nb\r\nc\r\nd\r\ne', 'A\r\nb\r\nc\r\nd\r\ne', 'a\r\nb\r\nc\r\nd\r\nE');
  assert.equal(crlf.text, 'A\r\nb\r\nc\r\nd\r\nE');
});

test('conflict markers are found only as git writes them', () => {
  assert.ok(hasConflictMarkers('x\n<<<<<<< main\na\n=======\nb\n>>>>>>> branch\ny'));
  assert.equal(hasConflictMarkers('// <<<<<<< in a comment ======= >>>>>>> '), false);
  assert.equal(hasConflictMarkers('<<<<<<< main\na\n'), false);
  assert.equal(hasConflictMarkers('const s = "=======";'), false);
});

test('diff3 fuzz: properties of a correct merge', () => {
  for (let n = 0; n < 4000; n++) {
    const base = randLines(ri(12), 5);
    const mut = (x) => { const y = [...x]; for (let k = ri(4); k > 0; k--) { const at = ri(y.length + 1), op = ri(3); if (op === 0) y.splice(at, 0, 'xyz'[ri(3)]); else if (op === 1) y.splice(at, 1); else y[Math.min(at, y.length - 1)] = 'pq'[ri(2)]; } return y.filter((v) => v !== undefined); };
    const B = base.join('\n'), O = mut(base).join('\n'), T = mut(base).join('\n');
    const m = merge3Text(B, O, T), s = merge3Text(B, T, O);
    const ctx = JSON.stringify({ B, O, T, m: m.text });
    assert.ok(m && s, ctx);
    // symmetric: swapping the sides swaps the conflict regions and nothing else
    assert.equal(m.conflicts, s.conflicts, ctx);
    if (m.conflicts === 0) assert.equal(m.text, s.text, ctx);
    assert.equal(m.regions.length, m.conflicts);
    assert.equal(hasConflictMarkers(m.text), m.conflicts > 0, ctx);
    // a side that changed nothing yields the other side
    assert.equal(merge3Text(B, B, T).text, T);
    assert.equal(merge3Text(B, O, B).text, O);
    // a clean merge keeps every change of each side: diffing the result against a side shows only the other side's change
    if (m.conflicts === 0) {
      const r = m.text.split('\n'), o = O.split('\n'), t = T.split('\n'), b = B.split('\n');
      // what both sides kept unchanged from base stays
      const keptBy = (side) => { const h = diffHunks(b, side), keep = new Set(b.map((_, i) => i)); for (const x of h) for (let i = x.a0; i < x.a1; i++) keep.delete(i); return keep; };
      const ko = keptBy(o), kt = keptBy(t), rh = diffHunks(b, r);
      const kr = new Set(b.map((_, i) => i)); for (const x of rh) for (let i = x.a0; i < x.a1; i++) kr.delete(i);
      // a base line removed by either side is not in the result's kept base lines
      for (let i = 0; i < b.length; i++) if (!ko.has(i) || !kt.has(i)) assert.ok(!kr.has(i) || b.filter((v) => v === b[i]).length > 1, `${ctx} base line ${i} removed by a side survived`);
      // merging the result with either side against that side changes nothing more
      assert.equal(merge3Text(O, r.join('\n'), O).text, r.join('\n'));
    }
  }
});

test('diff3 on separated edits always combines both', () => {
  for (let n = 0; n < 1500; n++) {
    const base = Array.from({ length: 20 + ri(20) }, (_, i) => `line ${i}`);
    const cut = 3 + ri(base.length - 8);       // ours edits strictly before cut-1, theirs strictly after cut+1
    const o = [...base], t = [...base];
    const ia = ri(cut - 1), ib = cut + 2 + ri(base.length - cut - 2);
    o[ia] = 'OURS'; t[ib] = 'THEIRS';
    if (rnd() < 0.5) t.splice(ib + 1, 0, 'ADDED');
    const m = merge3Text(base.join('\n'), o.join('\n'), t.join('\n'));
    assert.equal(m.conflicts, 0);
    const want = [...base]; want[ia] = 'OURS'; want[ib] = 'THEIRS'; if (t.includes('ADDED')) want.splice(ib + 1, 0, 'ADDED');
    assert.equal(m.text, want.join('\n'));
  }
});

test('big texts merge within time', () => {
  const base = Array.from({ length: 20000 }, (_, i) => `const v${i} = ${i};`);
  const o = [...base], t = [...base];
  for (let i = 0; i < 200; i++) { o[i * 97] = `// ours ${i}`; t[i * 97 + 40] = `// theirs ${i}`; }
  const t0 = Date.now(), m = merge3Text(base.join('\n'), o.join('\n'), t.join('\n'));
  assert.equal(m.conflicts, 0);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test('every MCP tool has a least role, and a tool without one is refused to collaborators', () => {
  const scope = readFileSync(new URL('../src/mcp/scope.ts', import.meta.url), 'utf8');
  const block = scope.slice(scope.indexOf('export const TOOL_ROLES'), scope.indexOf('};', scope.indexOf('export const TOOL_ROLES')));
  const roles = new Map([...block.matchAll(/(\w+): '(read|write|maintain|admin|owner)'/g)].map((m) => [m[1], m[2]]));
  // fail closed: an unlisted tool needs the owner
  assert.match(scope, /TOOL_ROLES\[c\.tool\] \?\? 'owner'/);
  const src = readFileSync(new URL('../src/mcp/tools.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/mcp/collab-tools.ts', import.meta.url), 'utf8');
  const tools = [...src.matchAll(/^\s{2,4}name: '([a-z_]+)',/gm)].map((m) => m[1]);
  assert.ok(tools.length > 20, `found ${tools.length} tools`);
  const unlisted = tools.filter((t) => !roles.has(t));
  // the tools left out take no project (the first four) or stay the owner's on purpose (stats, feedback, bots, deleting):
  // a new tool lands here until someone decides what role it needs
  assert.deepEqual(unlisted.sort(), ['create_project', 'creator_feedback', 'delete_project', 'find_implementations', 'get_implementation', 'get_started', 'get_stats', 'platform_services', 'preview_bots'].sort());
  // workspace tools enter at read and check write on the branch or main themselves (wsTarget)
  assert.match(src, /name: 'upload_files'[\s\S]*?wsTarget\(c, p, a\.branch, 'write'\)/);
  for (const t of ['collaborators', 'branches', 'change_requests', 'list_files', 'upload_files', 'deploy_preview']) assert.ok(roles.has(t), t);
  assert.equal(roles.get('list_files'), 'read');
  assert.equal(roles.get('publish'), 'admin');
});
