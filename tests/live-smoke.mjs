// Smoke test for a deployed platform: signs up a throwaway creator, connects over OAuth like an agent would,
// builds each starter template through MCP, deploys the previews as real Workers and waits for browser verification.
//   BASE=https://<site> node tests/live-smoke.mjs [template ...]
// It never touches the admin claim. State is written to SMOKE_STATE (default ./smoke-state.json) for clean-up.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.BASE; if (!BASE) throw new Error('Set BASE to the site origin.');
const run = randomBytes(3).toString('hex'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const templates = process.argv.slice(2).length ? process.argv.slice(2) : ['blank', 'three-blank', 'canvas2d-arcade', 'three-explorer'];
function client() {
  const jar = new Map();
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body && !extra.raw ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(extra.headers || {}) }, body: extra.raw ? body : body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, x) => call('POST', p, b, x) };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
const form = { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } };

const A = client(), email = `smoke-${run}@example.com`, password = randomBytes(12).toString('base64url');
must(await A.post('/api/auth/signup', { email, name: 'Smoke ' + run, password }));
const reg = must(await A.post('/oauth/register', { client_name: 'Smoke test agent', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), 201);
const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'games', state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
const consent = await A.get('/authorize?' + q); assert.equal(consent.status, 200, consent.text.slice(0, 300));
const handle = consent.text.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const approve = await A.post('/authorize?' + q, new URLSearchParams({ handle, decision: 'approve' }).toString(), form); assert.equal(approve.status, 302, approve.text.slice(0, 300));
const tok = must(await A.post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: new URL(approve.headers.get('location')).searchParams.get('code'), redirect_uri: 'http://127.0.0.1:9999/cb', client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }).toString(), form));
console.log(`signed up ${email}; OAuth token issued, expires in ${tok.expires_in}s`);

let id = 0;
const tool = async (name, args = {}) => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(r.status, 200, `${name} -> ${r.status}`); const j = await r.json(); assert.ok(!j.error, JSON.stringify(j.error));
  const text = j.result.content[0].text; if (j.result.isError) throw new Error(`${name}: ${text.slice(0, 600)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const state = { base: BASE, email, password, token: tok.access_token, projects: {} };
const save = () => writeFileSync(process.env.SMOKE_STATE || 'smoke-state.json', JSON.stringify(state, null, 1));
let failed = 0;
for (const t of templates) {
  const p = await tool('create_project', { title: `${t} ${run}`, template: t, tagline: 'Smoke test', tags: ['test'] });
  state.projects[t] = p.project; save();
  const c = await tool('check_project', { project: p.project }); assert.equal(c.ok, true, c.errors.join('\n'));
  const t0 = Date.now(); let d = await tool('deploy_preview', { project: p.project, note: 'smoke' });
  for (let i = 0; i < 90 && ['queued', 'deploying', 'verifying'].includes(d.status); i++) { await sleep(3000); d = await tool('get_version', { project: p.project, version: d.version }); }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (d.status === 'verified') console.log(`  ✓ ${t}: verified in ${secs}s (${d.report.metrics.loadMs} ms load, ${d.report.metrics.fps} fps, ${d.report.metrics.colors} colours, ${d.report.playthrough ? `play-through ${d.report.playthrough.steps.length} steps in ${d.report.playthrough.ms} ms` : "no play-through"})  ${d.screenshot}`);
  else { failed++; console.log(`  ✗ ${t}: ${d.status} after ${secs}s\n${JSON.stringify(d.report || d, null, 1).slice(0, 2500)}`); }
}
save();
process.exit(failed ? 1 : 0);
