// Project-scoped MCP authorization (src/mcp/scope.ts, src/mcp/tools.ts, src/mcp/server.ts, src/debug.ts, src/routes/device.ts):
// users can authorize an agent for all projects or only a selected subset of projects. Scoped grants strictly isolate
// every project tool, list_projects, create_project, get_started, get_implementation, and debug session closing, and
// device OAuth persists & forwards the selected projectIds through token issuance. Real SQLite + all migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';
import { Hono } from 'hono';

const shim = 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}');
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'cloudflare:workers' ? { url: ${JSON.stringify(shim)}, shortCircuit: true } : n(s, c); }`));
register('./ts-hook.mjs', import.meta.url);
const {
  normalizeProjectIds, parseStoredProjectIds, isProjectAllowed,
  resolveAllowedProjects, listSelectableProjects, scopedProject, assertCanCreateProject,
} = await import('../src/mcp/scope.ts');
const { handleMcp } = await import('../src/mcp/server.ts');
const { closeDebug } = await import('../src/debug.ts');
const { deviceApi, deviceOAuth, DEVICE_GRANT } = await import('../src/routes/device.ts');

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
  const batch = async (list) => {
    sql.exec('BEGIN');
    try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  };
  return { prepare: (q) => stmt(q), batch, sql };
}

function fakeR2() {
  const map = new Map();
  return {
    async list({ prefix = '' } = {}) {
      const objects = [];
      for (const [key, val] of map.entries()) if (key.startsWith(prefix)) objects.push({ key, size: val.length, uploaded: new Date() });
      return { objects, truncated: false };
    },
    async get(key) {
      const val = map.get(key);
      if (val == null) return null;
      return { text: async () => val, arrayBuffer: async () => new TextEncoder().encode(val).buffer, size: val.length };
    },
    async put(key, val) { map.set(key, typeof val === 'string' ? val : String(val)); },
    async delete(key) { map.delete(key); },
  };
}

function world() {
  const DB = d1();
  const R2 = fakeR2();
  const t = Date.now();
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES (?, ?, ?, '', ?, 'active', ?)").run('u_owner', 'owner@x.test', 'Owner', 'user', t);
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES (?, ?, ?, '', ?, 'active', ?)").run('u_admin', 'admin@x.test', 'Admin', 'admin', t);
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, role, status, created_at) VALUES (?, ?, ?, '', ?, 'active', ?)").run('u_other', 'other@x.test', 'Other', 'user', t);

  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, created_at, updated_at) VALUES ('p1', 'u_owner', 'alpha-game', 'Alpha Game', 'live', 0, 0, ?, ?)").run(t, t + 300);
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, created_at, updated_at) VALUES ('p2', 'u_owner', 'beta-game', 'Beta Game', 'draft', 0, 0, ?, ?)").run(t, t + 200);
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, created_at, updated_at) VALUES ('p3', 'u_owner', 'removed-game', 'Removed Game', 'removed', 0, 0, ?, ?)").run(t, t + 100);
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, price_cents, open_implementation, created_at, updated_at) VALUES ('p_other', 'u_other', 'other-game', 'Other Game', 'draft', 0, 0, ?, ?)").run(t, t + 50);

  return { DB, R2, ASSETS: { fetch: async () => new Response('ok') }, KV: null };
}

async function mcpCall(env, props, name, args = {}) {
  const req = new Request('https://hearthcade.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await handleMcp(req, env, props, 'https://hearthcade.com');
  assert.equal(res.status, 200);
  const body = await res.json();
  const result = body.result;
  const text = result.content?.[0]?.text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain text error */ }
  return { isError: !!result.isError, text, parsed };
}

test('normalizeProjectIds, parseStoredProjectIds, isProjectAllowed, assertCanCreateProject', () => {
  assert.equal(normalizeProjectIds(undefined), null);
  assert.equal(normalizeProjectIds(null), null);
  assert.deepEqual(normalizeProjectIds([]), []);
  assert.deepEqual(normalizeProjectIds([' p1 ', 'p2', 'p1', '', '   ']), ['p1', 'p2']);

  assert.equal(parseStoredProjectIds(null), null);
  assert.equal(parseStoredProjectIds(''), null);
  assert.deepEqual(parseStoredProjectIds('not-json'), [], 'corrupt stored project_ids fails closed to empty allowlist');
  assert.deepEqual(parseStoredProjectIds('["p1","p2","p1"]'), ['p1', 'p2']);

  assert.equal(isProjectAllowed(null, 'any'), true);
  assert.equal(isProjectAllowed(['p1'], 'p1'), true);
  assert.equal(isProjectAllowed(['p1'], 'p2'), false);
  assert.equal(isProjectAllowed([], 'p1'), false);

  assert.doesNotThrow(() => assertCanCreateProject(null));
  assert.throws(() => assertCanCreateProject(['p1']), (e) => e.status === 403 && e.code === 'forbidden');
});

test('resolveAllowedProjects and listSelectableProjects validate ownership and status', async () => {
  const env = world();
  const selectable = await listSelectableProjects(env, 'u_owner');
  assert.deepEqual(selectable.map((p) => p.id), ['p1', 'p2'], 'removed projects excluded and sorted by updated_at DESC');

  assert.deepEqual(await resolveAllowedProjects(env, 'u_owner', ['p1', 'p2', 'p1']), ['p1', 'p2']);
  await assert.rejects(() => resolveAllowedProjects(env, 'u_owner', []), (e) => e.status === 400);
  await assert.rejects(() => resolveAllowedProjects(env, 'u_owner', ['p3']), (e) => e.status === 403, 'removed project rejected');
  await assert.rejects(() => resolveAllowedProjects(env, 'u_owner', ['p_other']), (e) => e.status === 403, 'other user project rejected');
  await assert.rejects(() => resolveAllowedProjects(env, 'u_owner', ['p1', 'p_other']), (e) => e.status === 403, 'partial mismatch rejected');
});

test('scopedProject enforces project allowlist and blocks admin bypass when scoped', async () => {
  const env = world();
  const owner = env.DB.sql.prepare("SELECT * FROM users WHERE id = 'u_owner'").get();
  const admin = env.DB.sql.prepare("SELECT * FROM users WHERE id = 'u_admin'").get();

  // Unscoped owner can access both p1 and p2; unscoped admin can access p1 (legacy ownedProject behavior)
  assert.equal((await scopedProject({ env, user: owner, allowedProjects: null }, 'p1')).id, 'p1');
  assert.equal((await scopedProject({ env, user: owner, allowedProjects: null }, 'beta-game')).id, 'p2');
  assert.equal((await scopedProject({ env, user: admin, allowedProjects: null }, 'p1')).id, 'p1');

  // Scoped owner can access p1 (by id or slug), cannot access p2
  assert.equal((await scopedProject({ env, user: owner, allowedProjects: ['p1'] }, 'p1')).id, 'p1');
  assert.equal((await scopedProject({ env, user: owner, allowedProjects: ['p1'] }, 'alpha-game')).id, 'p1');
  await assert.rejects(
    () => scopedProject({ env, user: owner, allowedProjects: ['p1'] }, 'p2'),
    (e) => e.status === 403 && e.code === 'forbidden',
  );
  await assert.rejects(
    () => scopedProject({ env, user: owner, allowedProjects: ['p1'] }, 'beta-game'),
    (e) => e.status === 403 && e.code === 'forbidden',
  );

  // Scoped admin cannot bypass ownership even if project id were in allowedProjects
  await assert.rejects(
    () => scopedProject({ env, user: admin, allowedProjects: ['p1'] }, 'p1'),
    (e) => e.status === 403 && e.code === 'forbidden',
  );
});

test('handleMcp enforces project scope across list_projects, create_project, list_files, get_started, and get_implementation', async () => {
  const env = world();
  const scoped = { userId: 'u_owner', client: 'TestAgent', projectIds: ['p1'] };
  const all = { userId: 'u_owner', client: 'TestAgent', projectIds: null };

  // list_projects: scoped sees only p1, unscoped sees p1 and p2
  const rListScoped = await mcpCall(env, scoped, 'list_projects', {});
  assert.equal(rListScoped.isError, false);
  assert.deepEqual(rListScoped.parsed.projects.map((p) => p.id), ['p1']);

  const rListAll = await mcpCall(env, all, 'list_projects', {});
  assert.equal(rListAll.isError, false);
  assert.deepEqual(rListAll.parsed.projects.map((p) => p.id), ['p1', 'p2']);

  // create_project: blocked when scoped
  const rCreate = await mcpCall(env, scoped, 'create_project', { title: 'New One' });
  assert.equal(rCreate.isError, true);
  assert.match(rCreate.text, /selected projects/i);

  // list_projects({project}) & list_files: allowed for p1, denied for p2
  const rGetOk = await mcpCall(env, scoped, 'list_projects', { project: 'p1' });
  assert.equal(rGetOk.isError, false);
  assert.equal(rGetOk.parsed.project, 'p1');

  const rGetDeny = await mcpCall(env, scoped, 'list_projects', { project: 'p2' });
  assert.equal(rGetDeny.isError, true);
  assert.match(rGetDeny.text, /does not have access to project/i);

  const rFilesOk = await mcpCall(env, scoped, 'list_files', { project: 'p1' });
  assert.equal(rFilesOk.isError, false);
  const rFilesDeny = await mcpCall(env, scoped, 'list_files', { project: 'beta-game' });
  assert.equal(rFilesDeny.isError, true);
  assert.match(rFilesDeny.text, /does not have access to project/i);

  // get_started (account): reports project_access and omits account-wide earnings when scoped
  const rStartScoped = await mcpCall(env, scoped, 'get_started', {});
  assert.equal(rStartScoped.isError, false);
  assert.equal(rStartScoped.parsed.account.project_access.scope, 'selected');
  assert.equal(rStartScoped.parsed.account.project_access.can_create_projects, false);
  assert.deepEqual(rStartScoped.parsed.account.project_access.project_ids, ['p1']);
  assert.equal('earnings' in rStartScoped.parsed.account, false, 'account-wide earnings hidden from project-scoped agent');

  const rStartAll = await mcpCall(env, all, 'get_started', {});
  assert.equal(rStartAll.isError, false);
  assert.equal(rStartAll.parsed.account.project_access.scope, 'all');
  assert.equal(rStartAll.parsed.account.project_access.can_create_projects, true);
  assert.equal('earnings' in rStartAll.parsed.account, true);

  // get_implementation: strips owner privilege for out-of-scope private project p2
  const rImplDeny = await mcpCall(env, scoped, 'get_implementation', { game: 'beta-game' });
  assert.equal(rImplDeny.isError, true);
});

test('closeDebug enforces projectId isolation so a scoped agent cannot close another project session', async () => {
  const env = { ...world(), BROWSER: {} };
  const owner = env.DB.sql.prepare("SELECT * FROM users WHERE id = 'u_owner'").get();
  const t = Date.now();
  env.DB.sql.prepare("INSERT INTO debug_sessions (id, user_id, project_id, version, browser_id, play_sid, viewport, created_at, last_at, expires_at) VALUES ('ds_p2', 'u_owner', 'p2', 1, 'br_1', 'vf_1', '{}', ?, ?, ?)").run(t, t, t + 60000);

  const wrong = await closeDebug(env, owner, 'ds_p2', 'p1');
  assert.equal(wrong.closed, false);
  assert.equal(env.DB.sql.prepare("SELECT closed_at FROM debug_sessions WHERE id = 'ds_p2'").get().closed_at, null);

  const right = await closeDebug(env, owner, 'ds_p2', 'p2');
  assert.equal(right.closed, true);
  assert.notEqual(env.DB.sql.prepare("SELECT closed_at FROM debug_sessions WHERE id = 'ds_p2'").get().closed_at, null);
});

test('device OAuth stores selected project_ids and forwards them into grant metadata and props', async () => {
  const env = world();
  const owner = env.DB.sql.prepare("SELECT * FROM users WHERE id = 'u_owner'").get();
  const captured = [];
  env.OAUTH_PROVIDER = {
    async createClient() { return { clientId: 'cid_1' }; },
    async completeAuthorization(opts) { captured.push(opts); return { redirectTo: 'https://hearthcade.com/oauth/code?code=authcode123' }; },
  };
  const exchange = async () => new Response(JSON.stringify({ access_token: 'tok_abc', refresh_token: 'ref_abc', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  const execCtx = { waitUntil() {}, passThroughOnException() {} };

  const app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, e.status || 500));
  app.use('*', async (c, next) => { c.set('origin', 'https://hearthcade.com'); c.set('user', owner); await next(); });
  app.route('/oauth/device', deviceOAuth(exchange));
  app.route('/api/device', deviceApi);

  // 1. Agent starts device authorization
  const startRes = await app.fetch(new Request('https://hearthcade.com/oauth/device', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'CLI Agent' }),
  }), env, execCtx);
  assert.equal(startRes.status, 200);
  const start = await startRes.json();

  // 2. User loads /api/device/:code and sees selectable projects
  const infoRes = await app.fetch(new Request(`https://hearthcade.com/api/device/${start.user_code}`), env, execCtx);
  assert.equal(infoRes.status, 200);
  const info = await infoRes.json();
  assert.deepEqual(info.projects.map((p) => p.id), ['p1', 'p2']);

  // 3. Rejects empty selection or unowned project
  const badEmpty = await app.fetch(new Request(`https://hearthcade.com/api/device/${start.user_code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', project_scope: 'selected', project_ids: [] }),
  }), env, execCtx);
  assert.equal(badEmpty.status, 400);

  const badOther = await app.fetch(new Request(`https://hearthcade.com/api/device/${start.user_code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', project_scope: 'selected', project_ids: ['p_other'] }),
  }), env, execCtx);
  assert.equal(badOther.status, 403);

  // 4. Approves with specific project p1
  const okRes = await app.fetch(new Request(`https://hearthcade.com/api/device/${start.user_code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', project_scope: 'selected', project_ids: ['p1'] }),
  }), env, execCtx);
  assert.equal(okRes.status, 200);
  const okJson = await okRes.json();
  assert.equal(okJson.project_scope, 'selected');
  assert.deepEqual(okJson.project_ids, ['p1']);

  // 5. Agent polls token endpoint and receives scoped grant
  const tokRes = await app.fetch(new Request('https://hearthcade.com/oauth/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: start.device_code }),
  }), env, execCtx);
  assert.equal(tokRes.status, 200);
  const tokJson = await tokRes.json();
  assert.equal(tokJson.project_scope, 'selected');
  assert.deepEqual(tokJson.project_ids, ['p1']);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].metadata.projectIds, ['p1']);
  assert.deepEqual(captured[0].props.projectIds, ['p1']);

  // 6. All-projects approval keeps projectIds unset
  const start2 = await (await app.fetch(new Request('https://hearthcade.com/oauth/device', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Full Agent' }),
  }), env, execCtx)).json();
  const ok2 = await app.fetch(new Request(`https://hearthcade.com/api/device/${start2.user_code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', project_scope: 'all' }),
  }), env, execCtx);
  assert.equal(ok2.status, 200);
  const tok2 = await (await app.fetch(new Request('https://hearthcade.com/oauth/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: start2.device_code }),
  }), env, execCtx)).json();
  assert.equal(tok2.project_scope, 'all');
  assert.equal(captured[1].metadata.projectIds, undefined);
  assert.equal(captured[1].props.projectIds, undefined);
});
