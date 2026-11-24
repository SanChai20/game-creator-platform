// Two agents on one account, against a running local Worker (npx wrangler dev, DEV_MAIL=1): agent A deploys, agent B
// pulls that exact version, both change it, B's deploy on the stale base is refused with what A changed, B compares,
// checks out the newer version and deploys on top of it.   node tests/version-sync-live.mjs   (BASE, default localhost:8787)
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';

const BASE = process.env.BASE || 'http://localhost:8787';
const run = randomBytes(3).toString('hex'), email = `sync-${run}@example.com`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (m) => console.log(`  ✓ ${String(++step).padStart(2)} ${m}`);

function client() {
  const jar = new Map();
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body && !extra.raw ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(extra.headers || {}) }, body: body ? (extra.raw ? body : JSON.stringify(body)) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, x) => call('POST', p, b, x) };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
async function lastMail(to, re) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${BASE}/api/dev/mail?to=${encodeURIComponent(to)}`); const j = await r.json();
    const m = (j.mail || []).filter((x) => re.test(x.text)).pop(); if (m) return m; await sleep(100);
  }
  throw new Error(`no email to ${to}`);
}

/** An MCP connection for this account, as one agent app on one machine would have. */
async function agent(cl, name) {
  const reg = must(await cl.post('/oauth/register', { client_name: name, redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), 201);
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'games', state: 'x', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
  const consent = await cl.get('/authorize?' + q);
  const handle = consent.text.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  const approve = await cl.post('/authorize?' + q, new URLSearchParams({ handle, decision: 'approve' }).toString(), { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const code = new URL(approve.headers.get('location')).searchParams.get('code');
  const tok = must(await cl.post('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9999/cb', client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }).toString(), { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
  let id = 0;
  return async (tool, args = {}, expectError = false) => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }) });
    const j = await r.json(), x = j.result;
    if (expectError === null && x.isError) return { error: x.content[0].text };
    if (expectError !== null) assert.equal(!!x.isError, expectError, `${tool}: ${x.content[0].text.slice(0, 600)}`);
    try { return JSON.parse(x.content[0].text); } catch { return x.content[0].text; }
  };
}

const page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sync</title><canvas id="c" width="320" height="200"></canvas>
<script src="src/game.js"></script>`;
const game = (speed, colour) => `const c = document.getElementById('c'), g = c.getContext('2d');
let x = 0;
const speed = ${speed};
const colour = '${colour}';
function frame() { x = (x + speed) % 320; g.fillStyle = '#000'; g.fillRect(0, 0, 320, 200); g.fillStyle = colour; g.fillRect(x, 90, 20, 20); requestAnimationFrame(frame); }
addEventListener('keydown', () => { x = 0; });
frame();
GCP.ready();
`;

/** Waits for a version's deploy and check to finish (pass or fail), as an agent does before its next deploy. */
async function settle(call, project, version) {
  for (let i = 0; i < 20; i++) { const r = await call('list_versions', { project, version, wait_seconds: 30 }); if (!/queued|deploying|verifying/.test(r.status || r.verification || '')) return r; }
  throw new Error(`version ${version} never finished`);
}

async function main() {
  console.log(`version sync against ${BASE}`);
  const cl = client();
  must(await cl.post('/api/auth/signup', { email, name: 'Sync ' + run }));
  const t = (await lastMail(email, /\/verify\?token=/)).text.match(/\/verify\?token=([\w-]+)/)[1];
  must(await cl.post('/api/auth/signup/confirm', { token: t }));
  const A = await agent(cl, 'Agent A'), B = await agent(cl, 'Agent B');
  ok('one account, two agent connections');

  const { project } = await A('create_project', { title: `Sync ${run}` });
  await A('upload_files', { project, files: [{ path: 'index.html', content: page() }, { path: 'src/game.js', content: game(2, '#f80') }, { path: 'art/dot.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }] });
  const d1 = await A('deploy_preview', { project, note: 'first', base_version: 0, by: 'laptop', wait_seconds: 1 });
  assert.equal(d1.deployed, true, JSON.stringify(d1).slice(0, 500));
  await settle(A, project, 1);
  ok(`agent A deploys version 1 (${d1.version ?? 1})`);

  // B pulls exactly that version
  const pull = await B('pull_version', { project, paths: ['src/game.js'] });
  assert.equal(pull.version, 1); assert.equal(pull.base_version, 1); assert.equal(pull.by, 'Agent A (laptop)');
  assert.equal(pull.file_count, 3); assert.match(pull.contents['src/game.js'], /const speed = 2;/);
  const zipRes = await fetch(pull.zip_url); assert.equal(zipRes.status, 200); assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  const files = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['art/dot.svg', 'index.html', 'src/game.js']);
  for (const f of pull.files) assert.equal(createHash('sha256').update(files[f.path]).digest('hex').slice(0, 32), f.sha, f.path);
  const one = await fetch(pull.file_url + encodeURIComponent('src/game.js')); assert.equal(await one.text(), strFromU8(files['src/game.js']));
  assert.equal((await fetch(pull.file_url + 'nope.js')).status, 404);
  assert.equal((await fetch(`${BASE}/api/download/not-a-token`)).status, 401);
  ok('agent B pulls version 1: zip and single files match every hash, text inline, who deployed it');

  // A deploys version 2 on base 1
  await A('upload_files', { project, edits: [{ path: 'src/game.js', old_string: 'const speed = 2;', new_string: 'const speed = 5;' }] });
  const d2 = await A('deploy_preview', { project, note: 'faster', base_version: 1, by: 'laptop', wait_seconds: 1 });
  assert.equal(d2.deployed, true, JSON.stringify(d2).slice(0, 500));
  await settle(A, project, 2);
  ok('agent A deploys version 2 on base 1');

  // B, still on base 1, uploads its own change and deploys: refused, with what A changed
  await B('upload_files', { project, files: [{ path: 'src/game.js', content: strFromU8(files['src/game.js']).replace("'#f80'", "'#0cf'") }] });
  const conflict = await B('deploy_preview', { project, note: 'blue', base_version: 1, by: 'desktop', wait_seconds: 1 });
  assert.equal(conflict.deployed, false); assert.equal(conflict.conflict, 'newer_version');
  assert.equal(conflict.newest_version, 2); assert.equal(conflict.newer_versions[0].by, 'Agent A (laptop)');
  assert.deepEqual(conflict.changed_since_your_base.changed, ['src/game.js']);
  assert.match(conflict.next, /base_version: 2/);
  assert.equal((await B('list_versions', { project })).versions.length, 2, 'nothing was deployed');
  const bad = await B('deploy_preview', { project, base_version: 9, wait_seconds: 1 });
  assert.equal(bad.conflict, 'unknown_base');
  ok('agent B deploying on stale base 1 is refused, naming version 2 by Agent A and the file it changed');

  const diff = await B('diff_versions', { project, from: 1, to: 2 });
  assert.equal(diff.changed.length, 1); assert.match(diff.changed[0].diff, /^-const speed = 2;$/m); assert.match(diff.changed[0].diff, /^\+const speed = 5;$/m);
  const wdiff = await B('diff_versions', { project, to: 'workspace' });
  assert.equal(wdiff.from, 'version 2'); assert.match(wdiff.changed[0].diff, /#0cf/);
  ok('diff_versions: line diff between versions, and between a version and the workspace');

  // checkout refuses to discard B's unsaved upload, then B takes version 2 and re-applies its change
  const refused = await B('checkout_version', { project, version: 2 });
  assert.equal(refused.checked_out, false); assert.deepEqual(refused.unsaved.changed, ['src/game.js']);
  const co = await B('checkout_version', { project, version: 2, force: true });
  assert.equal(co.checked_out, 2); assert.deepEqual(co.written, ['src/game.js']);
  const lf = await B('list_files', { project });
  assert.equal(lf.workspace.based_on_version, 2); assert.match(lf.workspace.changed_since_base, /nothing/);
  await B('upload_files', { project, edits: [{ path: 'src/game.js', old_string: "'#f80'", new_string: "'#0cf'" }] });
  const d3 = await B('deploy_preview', { project, note: 'blue on top of faster', base_version: 2, by: 'desktop', wait_seconds: 1 });
  assert.equal(d3.deployed, true, JSON.stringify(d3).slice(0, 500));
  await settle(B, project, 3);
  const pulled3 = await A('pull_version', { project, paths: ['src/game.js'] });
  assert.equal(pulled3.version, 3); assert.match(pulled3.contents['src/game.js'], /speed = 5;[\s\S]*#0cf/);
  ok('checkout guards unsaved work; agent B checks out 2, merges and deploys 3, which has both changes');

  // an older version checked out, then the versions list
  const back = await A('checkout_version', { project, version: 1 });
  assert.equal(back.checked_out, 1); assert.equal(back.base_version, 3); assert.match(back.next, /leaves out/);
  const lv = await A('list_versions', { project });
  const v3 = lv.versions.find((v) => v.version === 3);
  assert.equal(v3.by, 'Agent B (desktop)'); assert.equal(v3.based_on, 2); assert.equal(lv.newest_version, 3);
  assert.equal(lv.workspace.based_on_version, 1); assert.match(lv.workspace.newer_version, /Version 3 is newer/);
  const ws = await A('pull_version', { project, workspace: true });
  assert.equal(ws.base_version, 1); assert.match(ws.pulled, /workspace/);
  ok('older checkout says what deploying it leaves out; list_versions shows who and what each version was built on');

  // two deploys on the same base at once: only one gets a version
  await sleep(1500);
  const both = await Promise.all([A('deploy_preview', { project, base_version: 3, wait_seconds: 1 }, null), B('deploy_preview', { project, base_version: 3, wait_seconds: 1 }, null)].map((p) => p.catch((e) => ({ error: String(e.message) }))));
  console.log('    concurrent:', both.map((r) => r.deployed === true ? 'deployed' : r.conflict || r.error?.slice(0, 120)).join(' | '));
  assert.equal(both.filter((r) => r.deployed === true).length <= 1, true);
  ok('two deploys on one base at the same moment: at most one makes a version');
  console.log('all good');
}
main().catch((e) => { console.error(e); process.exit(1); });
