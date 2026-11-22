// The release gate (src/release-gate.ts): every platform requirement is checked on the server before a version goes
// live, for every path that leads there, with readable reasons, admin waivers only where a verifier can be wrong, and
// rollbacks of versions that were live before kept working. Real migrations, in-memory SQLite, an in-memory bucket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { releaseGate, gateError, gateText, currentChecks, waive, unwaive, noteWaivers, recordGate, storedGate, RULES, RULESET, REQUIRED_CHECKS } = await import('../src/release-gate.ts');
const { SETTING_DEFS } = await import('../src/settings.ts');

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const batch = async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; };
  return { prepare: (q) => stmt(q), batch, sql };
}
function bucket() {
  const m = new Map();
  return {
    m,
    put: (key, text, uploaded = 1000) => m.set(key, { text, size: new TextEncoder().encode(text).length, uploaded: new Date(uploaded) }),
    async get(key) { const o = m.get(key); return o ? { text: async () => o.text, body: o.text } : null; },
    async list({ prefix = '' } = {}) { return { objects: [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size, uploaded: o.uploaded })), truncated: false }; },
  };
}

const defaults = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.v]));
const S = { ...defaults, metadata_required: false };
const ok = (id) => ({ id, ok: true, label: id, detail: '' });
const FULL = { ok: true, browser: 'cloudflare-browser-rendering', devices: [], checks: [...REQUIRED_CHECKS, 'renders', 'input', 'responds', 'original', 'is_game', 'content'].map(ok), originality: {} };
const FILES = [{ path: 'index.html', size: 5, sha: 'x' }];

function world({ report = FULL, status = 'verified', project = {}, user = {}, version = {} } = {}) {
  const DB = d1(), FILESB = bucket();
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, creator, creator_plan, status, created_at) VALUES ('u1', 'm@x', 'Maker', '', ?, 'lifetime', ?, 0)").run(user.creator ?? 1, user.status ?? 'active');
  const p = { id: 'g1', owner_id: 'u1', slug: 'bloom', title: 'Bloom', status: 'draft', live_version: null, open_implementation: 0, tags: '["fantasy","cozy"]', ...project };
  DB.sql.prepare('INSERT INTO projects (id, owner_id, slug, title, status, live_version, open_implementation, tags, removed_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)').run(p.id, p.owner_id, p.slug, p.title, p.status, p.live_version, p.open_implementation, p.tags, p.removed_reason ?? null);
  const v = { project_id: 'g1', n: 3, manifest: '{}', files: JSON.stringify(FILES), file_count: 1, bytes: 5, status, report: JSON.stringify(report), human_ok: 0, created_at: 2000, published_at: null, ...version };
  DB.sql.prepare('INSERT INTO versions (project_id, n, manifest, files, file_count, bytes, status, report, human_ok, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(v.project_id, v.n, v.manifest, v.files, v.file_count, v.bytes, v.status, v.report, v.human_ok, v.created_at, v.published_at);
  FILESB.put('v/g1/3/index.html', '<p>x</p>'.slice(0, 5));
  const env = { DB, FILES: FILESB };
  const row = DB.sql.prepare('SELECT * FROM projects WHERE id = ?').get('g1'), ver = DB.sql.prepare('SELECT * FROM versions WHERE project_id = ? AND n = 3').get('g1');
  return { env, p: row, v: ver, DB, FILESB };
}
const gate = (w, mode = 'publish', extra = {}) => releaseGate(w.env, w.p, w.v, { mode, deps: { settings: { ...S, ...(extra.s || {}) }, originality: extra.originality || (async () => null) }, openImplementation: extra.openImplementation });
const statusOf = (g, id) => g.rules.find((r) => r.id === id)?.status;

test('a current, verified version with nothing missing meets every rule, and the outcome names its ruleset', async () => {
  const w = world(), g = await gate(w);
  assert.equal(g.ok, true, gateText(g));
  assert.equal(g.ruleset, RULESET);
  assert.deepEqual(g.rules.map((r) => r.id), RULES.map((r) => r.id));
  await recordGate(w.env, g);
  const stored = storedGate(w.DB.sql.prepare('SELECT gate FROM versions WHERE n = 3').get());
  assert.equal(stored.ok, true);
});

test('an agent told to skip a check cannot: a report without the capture check is not current', async () => {
  const w = world({ report: { ...FULL, checks: FULL.checks.filter((c) => c.id !== 'capture') } }), g = await gate(w);
  assert.equal(g.ok, false);
  assert.equal(statusOf(g, 'current_checks'), 'fail');
  const e = gateError(g);
  assert.equal(e.code, 'verification_outdated');
  assert.match(e.message, /capture/);
  assert.match(e.message, /What to do: Call deploy_preview again/);
  assert.equal(statusOf(g, 'original'), 'skipped', 'the expensive comparison waits until the rest holds');
});

test('capture findings are advice: they never hold a release back', async () => {
  const report = { ...FULL, checks: FULL.checks.map((c) => (c.id === 'capture' ? { ...c, detail: 'Advice: it registers no GCP.test.onCapture.', soft: true } : c)) };
  const w = world({ report });
  assert.notEqual(statusOf(await gate(w), 'current_checks'), 'fail');
  assert.equal(currentChecks(w.v, S).ok, true);
});

test('the phone and tablet pass must have run for a game that lists phones or tablets', async () => {
  const report = { ...FULL }; delete report.devices;
  const w = world({ report });
  assert.equal(currentChecks(w.v, S).ok, false);
  assert.equal(currentChecks({ ...w.v, manifest: JSON.stringify({ compat: { requirements: { devices: ['desktop'] } } }) }, S).ok, true);
  assert.equal(currentChecks(w.v, { ...S, verify_devices: '' }).ok, true, 'not while the platform has the device pass off');
});

test('failed verification: a waiver can cover a check a verifier gets wrong, never content, conduct or boot', async () => {
  const slow = world({ status: 'failed', report: { ...FULL, ok: false, checks: FULL.checks.map((c) => (c.id === 'renders' ? { ...c, ok: false, detail: '4 frames in 9s' } : c)) } });
  let g = await gate(slow);
  const v = g.rules.find((r) => r.id === 'verified');
  assert.equal(v.status, 'fail'); assert.equal(v.waivable, true); assert.match(v.reason, /4 frames in 9s/);
  await waive(slow.env, { id: 'admin1' }, slow.p, 3, 'verified', 'Heavy scene; plays at 60 fps on a real GPU.', 3);
  g = await gate(slow);
  assert.equal(statusOf(g, 'verified'), 'waived');
  assert.equal(g.ok, true, gateText(g));
  await noteWaivers(slow.env, g, 'pipeline');
  assert.ok(slow.DB.sql.prepare("SELECT 1 FROM events WHERE kind = 'release_waived'").get(), 'the exception is on record');

  for (const id of ['content', 'conduct', 'boots', 'original', 'is_game']) {
    const w = world({ status: 'failed', report: { ...FULL, ok: false, checks: FULL.checks.map((c) => (c.id === id ? { ...c, ok: false } : c)) } });
    await waive(w.env, { id: 'admin1' }, w.p, 3, 'verified', 'Trying to wave it through anyway.', 3);
    const r = (await gate(w)).rules.find((x) => x.id === 'verified');
    assert.equal(r.status, 'fail', `${id} stands`); assert.equal(r.waivable, false);
  }
});

test('waivers: only waivable rules, a reason, bounded days; expired and removed ones do not count', async () => {
  const w = world({ report: { ...FULL, checks: FULL.checks.filter((c) => c.id !== 'capture') } });
  await assert.rejects(waive(w.env, { id: 'a' }, w.p, 3, 'original', 'It is fine, really.', 3), /cannot be waived/);
  await assert.rejects(waive(w.env, { id: 'a' }, w.p, 3, 'files_intact', 'It is fine, really.', 3), /cannot be waived/);
  await assert.rejects(waive(w.env, { id: 'a' }, w.p, 3, 'current_checks', 'short', 3), /at least 10/);
  await assert.rejects(waive(w.env, { id: 'a' }, w.p, 3, 'current_checks', 'A long enough reason.', 90), /1 to 30/);
  await assert.rejects(waive(w.env, { id: 'a' }, w.p, 3, 'nope', 'A long enough reason.', 3), /No rule/);
  await waive(w.env, { id: 'a' }, w.p, 3, 'current_checks', 'A long enough reason.', 3);
  assert.equal((await gate(w)).ok, true);
  w.DB.sql.exec('UPDATE release_waivers SET expires_at = 1');
  assert.equal((await gate(w)).ok, false, 'expired');
  await waive(w.env, { id: 'a' }, w.p, 3, 'current_checks', 'A long enough reason.', 3);
  assert.equal(await unwaive(w.env, { id: 'a' }, w.p, 3, 'current_checks'), true);
  assert.equal((await gate(w)).ok, false, 'removed');
  // a waiver is for one version only
  w.DB.sql.exec("INSERT INTO release_waivers (project_id, version, rule, reason, created_by, created_at, expires_at) VALUES ('g1', 2, 'current_checks', 'another version', 'a', 0, 9e15)");
  assert.equal((await gate(w)).ok, false);
});

test('files changed after verification can never go live', async () => {
  const w = world();
  w.FILESB.put('v/g1/3/index.html', 'rewritten later', 2000 + 3600 * 1000);
  let g = await gate(w);
  assert.equal(statusOf(g, 'files_intact'), 'fail');
  assert.equal(g.rules.find((r) => r.id === 'files_intact').waivable, false);
  const w2 = world(); w2.FILESB.m.clear();
  g = await gate(w2);
  assert.match(g.rules.find((r) => r.id === 'files_intact').reason, /index\.html: missing/);
  const w3 = world(); w3.FILESB.put('v/g1/3/extra.js', 'x');
  assert.match((await gate(w3)).rules.find((r) => r.id === 'files_intact').reason, /not part of its version/);
});

test('rollback and putting a game back online: only versions that were live, held to the rules that still matter', async () => {
  // an old live version verified before the capture check existed still rolls back; a never-live one does not
  const old = world({ report: { ...FULL, checks: FULL.checks.filter((c) => c.id !== 'capture') }, version: { published_at: 5 }, project: { status: 'live', live_version: 4 } });
  assert.equal((await gate(old, 'rollback')).ok, true, gateText(await gate(old, 'rollback')));
  assert.equal(statusOf(await gate(old, 'rollback'), 'current_checks'), 'skipped');
  const never = world({ project: { status: 'live', live_version: 4 } });
  assert.equal(statusOf(await gate(never, 'rollback'), 'release_kind'), 'fail');
  const off = world({ version: { published_at: 5 }, project: { status: 'offline', live_version: 3 } });
  assert.equal((await gate(off, 'restore')).ok, true);
  const offOther = world({ version: { published_at: 5 }, project: { status: 'offline', live_version: 2 } });
  assert.equal(statusOf(await gate(offOther, 'restore'), 'release_kind'), 'fail');
  // the copy comparison still runs for every kind of release
  const copy = await gate(off, 'restore', { originality: async () => 'Version 3 matches "Other" by another creator.' });
  assert.equal(statusOf(copy, 'original'), 'fail');
});

test('account, license, removal, storage, build skill and metadata are each enforced with their own code', async () => {
  const codes = async (w, extra) => (await gate(w, 'publish', extra)).failures.map((f) => f.code);
  assert.deepEqual(await codes(world({ project: { status: 'removed', removed_reason: 'spam' } })), ['removed']);
  assert.deepEqual(await codes(world({ user: { status: 'suspended' } })), ['account_suspended']);
  assert.deepEqual(await codes(world({ user: { creator: 0 } })), ['license_required']);
  assert.deepEqual(await codes(world({ user: { creator: 0 } }), { s: { creator_fee_required: false } }), []);
  assert.deepEqual(await codes(world({ version: { bytes: 900 * 1024 * 1024 } })), ['storage_full']);
  assert.deepEqual(await codes(world({ project: { open_implementation: 1 } })), ['skill_missing']);
  assert.deepEqual(await codes(world(), { openImplementation: true }), ['skill_missing'], 'turning sharing on in the same call');
  assert.deepEqual(await codes(world({ project: { open_implementation: 1 } }), { openImplementation: false }), []);
  const meta = await gate(world({ project: { tags: '[]' } }), 'publish', { s: { metadata_required: true } });
  assert.deepEqual(meta.failures.map((f) => f.code), ['metadata_incomplete']);
  assert.ok(meta.failures[0].missing.length > 0);
  // every failure is listed at once, numbered, with the first one's code for agents that read codes
  const many = await gate(world({ project: { open_implementation: 1, tags: '[]' }, version: { bytes: 900 * 1024 * 1024 } }), 'publish', { s: { metadata_required: true } });
  const e = gateError(many);
  assert.equal(e.code, 'metadata_incomplete');
  assert.match(e.message, /3 platform requirements are not met/);
  assert.match(e.message, /1\. .*\n2\. .*\n3\. /s);
});

test('a version the browser could not run: everything else is checked before the review is asked for', async () => {
  const w = world({ status: 'failed', report: { ok: false, gpuLimited: true, checks: [] }, version: { human_ok: 1 } });
  const g = await gate(w, 'publish', { originality: async () => 'copy' });
  assert.equal(g.rules.find((r) => r.id === 'verified').review, 'needed');
  assert.equal(statusOf(g, 'original'), 'fail', 'originality ran: the review only sees a version that is otherwise ready');
  w.DB.sql.exec("UPDATE versions SET review = 'approved'");
  const approved = await releaseGate(w.env, w.p, w.DB.sql.prepare('SELECT * FROM versions WHERE n = 3').get(), { mode: 'publish', deps: { settings: S, originality: async () => null } });
  assert.equal(approved.ok, true, gateText(approved));
});

test('every way to go live passes through the gate, and the pipeline checks it last', () => {
  const pipeline = read('src/pipeline.ts'), tools = read('src/mcp/tools.ts'), admin = read('src/routes/admin.ts'), api = read('src/routes/api.ts');
  const run = pipeline.slice(pipeline.indexOf('async function runPublish'));
  assert.ok(run.indexOf('releaseGate(') > 0 && run.indexOf('releaseGate(') < run.indexOf('deployGame('), 'the pipeline checks before it deploys or switches');
  assert.match(run, /if \(!gate\.ok\) \{[^}]*publish_failed[^}]*return; \}/);
  assert.doesNotMatch(tools, /publishGate\(/, 'the publish tool no longer keeps its own partial list');
  assert.match(tools, /releaseGate\(c\.env, p, v, \{ mode: rollback \? 'rollback' : 'publish'/);
  // every publish job names its kind of release; nothing else writes a live version
  for (const src of [tools, admin, api]) for (const m of src.matchAll(/enqueue\([^;]*kind: 'publish'[^;]*\)/g)) assert.match(m[0], /mode: /, m[0]);
  for (const f of readdirSync(new URL('../src/', import.meta.url), { recursive: true }).filter((f) => /\.(ts|js)$/.test(f))) {
    const s = read('src/' + f);
    if (f !== 'go-live.ts') assert.doesNotMatch(s, /UPDATE projects SET status = 'live'/, `${f} must go through switchLive`);
  }
});

test('a close duplication match never waits for a person: the AI decides and the gate has no review rule for it', async () => {
  const w = world({ report: { ...FULL, originality: { matches: [] } } });
  const g = await gate(w);
  assert.equal(g.rules.some((r) => r.id === 'original_review'), false);
  assert.equal(g.ok, true);
});

test('a game played in several platform languages lists itself in each of them before it goes live', async () => {
  const langs = (supported) => ({ v: 1, languages: { default: 'en', supported: supported.map((code) => ({ code, interface: true, audio: false, subtitles: false })), follows_platform: true, notes: '' }, declared: true, detected: { default: 'en', supported: [], follows_platform: false, notes: '' }, evidence: {} });
  const manifest = (supported) => JSON.stringify({ meta: { v: 1, meta: { players: { min: 1, max: 1, modes: ['single'] }, content: {} }, declared: ['languages', 'players', 'content'], detected: { multiplayer: false, progress: {}, evidence: {} }, rating: { age: 3, reasons: [] }, languages: langs(supported) }, compat: { declared: true, requirements: {}, detected: {} } });
  const project = { title: 'Bloom', tagline: 'Grow a garden', description: 'Pick a garden.' };
  const withListing = (i18n, extra = {}) => { const w = world({ version: { manifest: manifest(['en', 'zh-hans', 'ja']) }, ...extra }); w.DB.sql.prepare('UPDATE projects SET tagline = ?, description = ?, listing_i18n = ? WHERE id = ?').run(project.tagline, project.description, JSON.stringify(i18n), 'g1'); w.p = w.DB.sql.prepare('SELECT * FROM projects WHERE id = ?').get('g1'); return w; };
  const short = await gate(withListing({ zh: { title: '花园', tagline: '种花', description: '选一座花园。' } }), 'publish', { s: { metadata_required: true } });
  const r = short.rules.find((x) => x.id === 'listing_languages');
  assert.equal(r.status, 'fail');
  assert.equal(r.code, 'listing_untranslated');
  assert.match(r.reason, /Japanese \(ja\): title, tagline, description/);
  assert.match(r.fix, /listing_translations/);
  assert.equal(r.waivable, true);
  const full = await gate(withListing({ zh: { title: '花园', tagline: '种花', description: '选一座花园。' }, ja: { title: '庭', tagline: '花を育てる', description: '庭を選ぼう。' } }), 'publish', { s: { metadata_required: true } });
  assert.equal(statusOf(full, 'listing_languages'), 'pass');
  // a game in one language needs nothing more, and a rollback is never held to it
  const one = world({ version: { manifest: manifest(['en']) } });
  assert.equal(statusOf(await gate(one, 'publish', { s: { metadata_required: true } }), 'listing_languages'), 'pass');
  assert.equal(statusOf(await gate(withListing({}, { version: { manifest: manifest(['en', 'ja']), published_at: 1 } }), 'rollback', { s: { metadata_required: true } }), 'listing_languages'), 'skipped');
});
