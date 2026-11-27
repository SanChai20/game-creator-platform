// Several people and several agents on one game, against a running local Worker (npx wrangler dev with DEV_MAIL=1 and
// DEPLOY_DRIVER=local, plus scripts/local-verifier.mjs): invitations and roles, protection of main, branches, change
// requests with reviews, three-way merges that combine separate changes, conflicts brought into a branch and resolved,
// and the races: the same invitation accepted twice at once, the same branch created many times at once, the same
// change request merged by several maintainers at once, two change requests merged at once, many agents writing one
// workspace at once (every file's bytes must match its recorded hash), and a removed collaborator's upload URL.
//   node tests/collab-live.mjs          (BASE, default http://127.0.0.1:8787)
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const run = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (m) => console.log(`  ✓ ${String(++step).padStart(2)} ${m}`);
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

function client() {
  const jar = new Map();
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body && !extra.raw ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(extra.headers || {}) }, body: body ? (extra.raw ? body : JSON.stringify(body)) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, x) => call('POST', p, b, x), del: (p) => call('DELETE', p) };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 400)}`); return r.json; };
async function lastMail(to, re) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/dev/mail?to=${encodeURIComponent(to)}`); const j = await r.json();
    const m = (j.mail || []).filter((x) => re.test(x.text)).pop(); if (m) return m; await sleep(100);
  }
  throw new Error(`no email to ${to}`);
}
async function person(name) {
  const cl = client(), email = `collab-${name.toLowerCase()}-${run}@example.com`;
  must(await cl.post('/api/auth/signup', { email, name: `${name} ${run}` }));
  const t = (await lastMail(email, /\/verify\?token=/)).text.match(/\/verify\?token=([\w-]+)/)[1];
  must(await cl.post('/api/auth/signup/confirm', { token: t }));
  const me = must(await cl.get('/api/me'));
  return { cl, email, name, id: me.user?.id || me.id };
}

/** An MCP connection for one account, as one agent app has. Returns call(tool, args) → parsed answer or {error}. */
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
  const call = async (tool, args = {}) => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }) });
    const j = await r.json(), x = j.result;
    if (!x) throw new Error(`${tool}: ${JSON.stringify(j).slice(0, 300)}`);
    if (x.isError) return { error: x.content[0].text };
    try { return JSON.parse(x.content[0].text); } catch { return x.content[0].text; }
  };
  call.ok = async (tool, args) => { const r = await call(tool, args); assert.ok(!r?.error, `${tool} ${JSON.stringify(args).slice(0, 200)}: ${r?.error}`); return r; };
  call.err = async (tool, args, re) => { const r = await call(tool, args); assert.ok(r?.error, `${tool} should have been refused: ${JSON.stringify(r).slice(0, 300)}`); if (re) assert.match(r.error, re); return r.error; };
  return call;
}

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Collab</title><style>html,body{margin:0;height:100%;background:#000}canvas{display:block;width:100vw;height:100vh}</style><canvas id="c" width="320" height="200"></canvas>
<script src="src/game.js"></script>`;
// one setting per line with a line between (git, and this merge, treat changes to adjacent lines as one conflict), so
// two people changing different settings merge cleanly and the same setting conflicts
const game = (o = {}) => {
  const v = { speed: 2, colour: "'#4cf'", size: 120, bg: "'#000'", ...o };
  return `const c = document.getElementById('c'), g = c.getContext('2d');
let x = 0;
const speed = ${v.speed};
// colour
const colour = ${v.colour};
// size
const size = ${v.size};
// background
const bg = ${v.bg};
function frame() { g.fillStyle = bg; g.fillRect(0, 0, 320, 200); g.fillStyle = colour; g.fillRect(x, 40, size, size); requestAnimationFrame(frame); }
// still until played: each key or tap moves the square by speed
const hit = () => { x = (x + speed * 10) % 200; };
addEventListener('keydown', hit); addEventListener('pointerdown', hit); addEventListener('touchstart', hit);
frame();
GCP.ready();
`;
};

async function settle(call, project, version) {
  for (let i = 0; i < 40; i++) { const r = await call('list_versions', { project, version, wait_seconds: 30 }); if (!/queued|deploying|verifying/.test(r.status || r.verification || '')) return r; }
  throw new Error(`version ${version} never finished`);
}
async function pullText(call, project, version, path) {
  const r = await call.ok('pull_version', { project, version, paths: [path] });
  return r.contents[path];
}
const time = async (label, fn) => { const t = Date.now(); const r = await fn(); console.log(`      (${label}: ${Date.now() - t} ms)`); return r; };

async function main() {
  console.log(`collaboration against ${BASE}`);
  const [owner, bea, cal, dee] = await Promise.all(['Owner', 'Bea', 'Cal', 'Dee'].map(person));
  const O = await agent(owner.cl, 'Owner agent'), B = await agent(bea.cl, 'Bea agent'), C = await agent(cal.cl, 'Cal agent'), D = await agent(dee.cl, 'Dee agent');
  ok('four accounts, each with an agent connection');

  // ---- the game, version 1 on main -----------------------------------------------------------------------------------
  const { project } = await O.ok('create_project', { title: `Collab ${run}`, genre: 'arcade' });
  await O.ok('upload_files', { project, files: [{ path: 'index.html', content: page }, { path: 'src/game.js', content: game() }] });
  const d1 = await O.ok('deploy_preview', { project, base_version: 0, note: 'v1' });
  assert.equal(d1.deployed, true);
  const v1 = d1.version; await settle(O, project, v1);
  ok(`owner deployed version ${v1} on main`);

  // ---- invitations and roles ---------------------------------------------------------------------------------------
  await D.err('list_files', { project }, /No project/);
  await D.err('collaborators', { project }, /No project/);
  ok('a stranger cannot see the project (answered as if it did not exist)');

  const inv = await O.ok('collaborators', { project, action: 'invite', email: bea.email, role: 'write' });
  assert.ok(inv.invite.id.startsWith('inv_'));
  await lastMail(bea.email, /invited you to work on/);
  await D.err('collaborators', { action: 'accept', invite: inv.invite.id }, /No such invitation/);
  // the same invitation accepted twice at once joins once
  const both = await Promise.all([B('collaborators', { action: 'accept', invite: inv.invite.id }), B('collaborators', { action: 'accept', invite: inv.invite.id })]);
  assert.equal(both.filter((r) => r.joined).length, 1, JSON.stringify(both));
  assert.equal(both.filter((r) => r.error && /already answered|is accepted/.test(r.error)).length, 1, JSON.stringify(both));
  ok('invitation emailed; a stranger cannot accept it; accepted twice at once, it joins once');

  const invC = await O.ok('collaborators', { project, action: 'invite', email: cal.email, role: 'maintain' });
  // Cal answers in the console
  const mine = must(await cal.cl.get('/api/collab/mine'));
  assert.ok(mine.invitations.some((i) => i.id === invC.invite.id));
  must(await cal.cl.post(`/api/collab/invites/${invC.invite.id}/accept`, {}));
  const invD = await O.ok('collaborators', { project, action: 'invite', email: dee.email, role: 'read' });
  await O.ok('collaborators', { project, action: 'revoke', invite: invD.invite.id });
  await D.err('collaborators', { action: 'accept', invite: invD.invite.id }, /revoked/);
  await O.err('collaborators', { project, action: 'invite', email: bea.email, role: 'read' }, /already a collaborator/);
  await B.err('collaborators', { project, action: 'invite', email: dee.email, role: 'read' }, /owner or an admin/);
  await C.err('collaborators', { project, action: 'invite', email: dee.email, role: 'admin' }, /owner or an admin|Only the owner/);
  ok('Cal joined from the console; a revoked invitation cannot be accepted; writers cannot invite, and only the owner grants admin');

  const lp = await B.ok('list_projects', {});
  assert.ok(lp.shared_with_you.some((x) => x.id === project && x.role === 'write'));
  const team = await B.ok('collaborators', { project });
  assert.equal(team.your_role, 'write'); assert.equal(team.members.length, 3); assert.ok(!team.members[0].email, 'emails are for admins');
  ok('Bea sees the shared project with her role; the team list hides emails from non-admins');

  // ---- what each role may do ----------------------------------------------------------------------------------------
  await B.err('upload_files', { project, files: [{ path: 'x.txt', content: 'x' }] }, /main is protected/);
  await B.err('deploy_preview', { project }, /main is protected/);
  await B.err('update_project', { project, tagline: 'new' }, /needs maintain/);
  await C.err('update_project', { project, price_cents: 499 }, /needs owner/);
  await C.err('publish', { project, version: v1, dry_run: true }, /needs admin/);
  await B.err('delete_project', { project }, /needs owner/);
  await B.err('get_stats', { project }, /needs owner/);
  await C.ok('update_project', { project, tagline: 'Two people made this' });
  ok('writers cannot touch main, the listing or money; maintainers edit the listing but not prices; publish needs admin');

  // ---- branches ----------------------------------------------------------------------------------------------------
  const nameRace = await Promise.all(Array.from({ length: 12 }, () => B('branches', { project, action: 'create', name: 'bea/speed' })));
  assert.equal(nameRace.filter((r) => r.branch).length, 1, JSON.stringify(nameRace.map((r) => r.error || 'ok')));
  assert.ok(nameRace.filter((r) => r.error).every((r) => /already exists/.test(r.error)));
  for (const bad of ['main', 'Bad Name', 'a', 'x..y', '-lead', 'trail/', 'a//b']) await B.err('branches', { project, action: 'create', name: bad });
  ok('the same branch created 12 times at once exists once; reserved and malformed names are refused');

  await C.ok('branches', { project, action: 'create', name: 'cal/colour' });
  const bl = await B.ok('branches', { project });
  assert.equal(bl.branches.length, 2); assert.equal(bl.main.head_version, v1);
  assert.ok(bl.branches.every((b) => b.base_version === v1));
  const bf = await B.ok('list_files', { project, branch: 'bea/speed' });
  assert.equal(bf.branch, 'bea/speed'); assert.equal(bf.files.length, 2);
  ok('both branches fork version 1 and start with its files');

  // Bea changes speed, Cal changes colour: different lines of the same file
  await B.ok('upload_files', { project, branch: 'bea/speed', edits: [{ path: 'src/game.js', old_string: 'const speed = 2;', new_string: 'const speed = 5;' }] });
  await C.ok('upload_files', { project, branch: 'cal/colour', edits: [{ path: 'src/game.js', old_string: "const colour = '#4cf';", new_string: "const colour = '#f84';" }] });
  await B.err('upload_files', { project, branch: 'cal/colour', delete: ['nope.js'] }, /not in the workspace/);
  const mainFiles = await O.ok('list_files', { project });
  assert.equal(mainFiles.files.find((f) => f.path === 'src/game.js').sha, sha(game()), 'main is untouched by branch work');
  ok('each edits its own branch; main stays as it was');

  const db = await B.ok('deploy_preview', { project, branch: 'bea/speed', note: 'faster' });
  assert.equal(db.branch, 'bea/speed');
  const vb = db.version; await settle(B, project, vb);
  const dc = await C.ok('deploy_preview', { project, branch: 'cal/colour', note: 'orange' });
  const vc = dc.version; await settle(C, project, vc);
  const lv = await O.ok('list_versions', { project });
  assert.equal(lv.newest_version, v1, 'main\'s newest is still version 1');
  assert.equal(lv.versions.find((v) => v.version === vb).branch, 'bea/speed');
  // a main deploy based on version 1 is not stale because of branch versions
  await O.ok('deploy_preview', { project, base_version: v1, dry_run: true });
  ok(`branch versions ${vb} and ${vc} deployed and verified; main's newest is still ${v1}`);

  // ---- change request #1: review rules -----------------------------------------------------------------------------
  const cr1 = await B.ok('change_requests', { project, action: 'open', branch: 'bea/speed', title: 'Faster square' });
  assert.equal(cr1.number, 1); assert.equal(cr1.mergeable, false);
  assert.ok(cr1.blockers.some((b) => b.id === 'approvals'));
  await B.err('change_requests', { project, action: 'open', branch: 'bea/speed', title: 'Again' }, /already has an open change request/);
  await B.err('change_requests', { project, action: 'review', number: 1, verdict: 'approve' }, /You opened this change request/);
  await B.err('change_requests', { project, action: 'merge', number: 1 }, /needs maintain/);
  await C.err('change_requests', { project, action: 'merge', number: 1 }, /cannot be merged yet/);
  await C.ok('change_requests', { project, action: 'review', number: 1, verdict: 'request_changes', body: 'Too fast?' });
  await O.ok('change_requests', { project, action: 'review', number: 1, verdict: 'approve' });
  let g1 = await C.ok('change_requests', { project, action: 'get', number: 1 });
  assert.ok(g1.blockers.some((b) => b.id === 'changes_requested'), 'a request for changes blocks even with an approval');
  await C.ok('change_requests', { project, action: 'review', number: 1, verdict: 'approve' });
  g1 = await C.ok('change_requests', { project, action: 'get', number: 1 });
  assert.equal(g1.mergeable, true, JSON.stringify(g1.blockers)); assert.equal(g1.approvals, 2);
  assert.deepEqual(g1.files_changed.changed, ['src/game.js']);
  ok('the author cannot approve; writers cannot merge; a request for changes blocks until that reviewer approves');

  // ---- merges: the same change request merged by three at once ------------------------------------------------------
  const owner2 = await agent(owner.cl, 'Owner second agent');
  const race = await Promise.all([C('change_requests', { project, action: 'merge', number: 1 }), O('change_requests', { project, action: 'merge', number: 1 }), owner2('change_requests', { project, action: 'merge', number: 1 })]);
  const won = race.filter((r) => r.merged);
  assert.equal(won.length, 1, JSON.stringify(race));
  const m1 = won[0];
  assert.ok(race.filter((r) => r.error).every((r) => /being merged|is merged/.test(r.error)), JSON.stringify(race));
  await settle(O, project, m1.version);
  assert.match(await pullText(O, project, m1.version, 'src/game.js'), /const speed = 5;/);
  ok(`#1 merged once although three maintainers pressed merge at once (version ${m1.version})`);

  // ---- change request #2 merges onto the new main: separate lines combine -------------------------------------------
  const cr2 = await C.ok('change_requests', { project, action: 'open', branch: 'cal/colour', title: 'Orange square' });
  assert.ok(cr2.number > cr1.number);
  assert.equal(cr2.merge_preview.clean, true);
  assert.ok(cr2.warnings.some((w) => /main has 1 version/.test(w)));
  await B.ok('change_requests', { project, action: 'review', number: 2, verdict: 'approve' });
  const m2 = await C.ok('change_requests', { project, action: 'merge', number: 2 });
  await settle(O, project, m2.version);
  const merged = await pullText(O, project, m2.version, 'src/game.js');
  assert.match(merged, /const speed = 5;/); assert.match(merged, /const colour = '#f84';/);
  const mv = await O.ok('list_versions', { project });
  assert.equal(mv.newest_version, m2.version);
  assert.equal(mv.versions.find((v) => v.version === m2.version).based_on, m1.version);
  const mainNow = await O.ok('list_files', { project });
  assert.equal(mainNow.files.find((f) => f.path === 'src/game.js').sha, sha(merged), 'main\'s clean workspace followed the merge');
  ok(`#2 three-way merged onto version ${m1.version}: version ${m2.version} has both Bea's speed and Cal's colour, and main's workspace follows`);

  // ---- a conflict: Bea changes the colour line Cal already changed on main -------------------------------------------
  const bs = await B.ok('branches', { project, action: 'status', name: 'bea/speed' });
  assert.equal(bs.base_version, m1.version, 'a merged branch follows the merge');
  await B.ok('upload_files', { project, branch: 'bea/speed', edits: [{ path: 'src/game.js', old_string: "const colour = '#4cf';", new_string: "const colour = '#0f0';" }, { path: 'src/game.js', old_string: 'const size = 120;', new_string: 'const size = 140;' }] });
  const vb2 = (await B.ok('deploy_preview', { project, branch: 'bea/speed', note: 'green and bigger' })).version; await settle(B, project, vb2);
  const cr3 = await B.ok('change_requests', { project, action: 'open', branch: 'bea/speed', title: 'Green, bigger' });
  assert.equal(cr3.merge_preview.clean, false); assert.equal(cr3.merge_preview.conflicts[0].path, 'src/game.js');
  await C.ok('change_requests', { project, action: 'review', number: cr3.number, verdict: 'approve' });
  await C.err('change_requests', { project, action: 'merge', number: cr3.number }, /conflict/);
  await O.err('change_requests', { project, action: 'merge', number: cr3.number, bypass: true }, /conflict/);
  ok('a change to a line main already changed is refused at merge, even with an admin bypass, and nothing is written');

  const up = await B.ok('branches', { project, action: 'update', name: 'bea/speed' });
  assert.deepEqual(up.conflicts, ['src/game.js']);
  const marked = (await B.ok('pull_version', { project, workspace: true, branch: 'bea/speed', paths: ['src/game.js'] })).contents['src/game.js'];
  assert.match(marked, /<<<<<<< bea\/speed \(your branch\)\nconst colour = '#0f0';\n=======\nconst colour = '#f84';\n>>>>>>> main/);
  assert.match(marked, /const size = 140;/); assert.match(marked, /const speed = 5;/);
  const refused = await B.ok('deploy_preview', { project, branch: 'bea/speed' });
  assert.equal(refused.deployed, false); assert.deepEqual(refused.conflicts, ['src/game.js']);
  // resolve by uploading the file without markers
  const fixed = marked.replace(/<<<<<<< [^\n]*\n(const colour = '#0f0';)\n=======\n[^\n]*\n>>>>>>> [^\n]*/, '$1');
  const upl = await B.ok('upload_files', { project, branch: 'bea/speed', files: [{ path: 'src/game.js', content: fixed }] });
  assert.deepEqual(upl.conflicts_resolved, ['src/game.js']);
  const vb3 = (await B.ok('deploy_preview', { project, branch: 'bea/speed', note: 'resolved' })).version; await settle(B, project, vb3);
  let g3 = await C.ok('change_requests', { project, action: 'get', number: cr3.number });
  assert.ok(g3.reviews.some((r) => r.stale), 'the approval of the old version is stale');
  assert.ok(g3.blockers.some((b) => b.id === 'approvals'));
  assert.equal(g3.merge_preview.clean, true);
  await C.ok('change_requests', { project, action: 'review', number: cr3.number, verdict: 'approve' });
  const m3 = await C.ok('change_requests', { project, action: 'merge', number: cr3.number, delete_branch: true });
  await settle(O, project, m3.version);
  const after3 = await pullText(O, project, m3.version, 'src/game.js');
  assert.match(after3, /const colour = '#0f0';/); assert.match(after3, /const size = 140;/); assert.match(after3, /const speed = 5;/);
  assert.equal(m3.branch, 'deleted');
  ok('main brought into the branch with git markers; deploy refused until resolved; uploading the fixed file resolved it; the old approval went stale; merged and the branch deleted');

  // ---- two change requests merged at the same moment ---------------------------------------------------------------
  await O.ok('branches', { project, action: 'protection', required_approvals: 0 });
  await B.ok('branches', { project, action: 'create', name: 'bea/bg' });
  await C.ok('branches', { project, action: 'update', name: 'cal/colour' }).catch(() => {});
  await C.ok('branches', { project, action: 'create', name: 'cal/readme' });
  await B.ok('upload_files', { project, branch: 'bea/bg', edits: [{ path: 'src/game.js', old_string: "const bg = '#000';", new_string: "const bg = '#112';" }] });
  await C.ok('upload_files', { project, branch: 'cal/readme', files: [{ path: 'README.txt', content: 'Made together.\n' }] });
  const [x1, x2] = await Promise.all([B.ok('deploy_preview', { project, branch: 'bea/bg', wait_seconds: 0 }), C.ok('deploy_preview', { project, branch: 'cal/readme', wait_seconds: 0 })]);
  await settle(B, project, x1.version); await settle(C, project, x2.version);
  const [c4, c5] = await Promise.all([B.ok('change_requests', { project, action: 'open', branch: 'bea/bg', title: 'Navy background' }), C.ok('change_requests', { project, action: 'open', branch: 'cal/readme', title: 'Readme' })]);
  assert.notEqual(c4.number, c5.number, 'numbers are unique under concurrency');
  const both2 = await Promise.all([C('change_requests', { project, action: 'merge', number: c4.number }), O('change_requests', { project, action: 'merge', number: c5.number })]);
  let landed = both2.filter((r) => r.merged).length;
  for (const [i, r] of both2.entries()) if (r.error) { assert.match(r.error, /main changed while|being merged/, r.error); const again = await O.ok('change_requests', { project, action: 'merge', number: [c4.number, c5.number][i] }); assert.ok(again.merged); landed++; }
  assert.equal(landed, 2);
  const vs = await O.ok('list_versions', { project });
  const tip = vs.newest_version;
  await settle(O, project, tip);
  const tipGame = await pullText(O, project, tip, 'src/game.js'), tipFiles = (await O.ok('pull_version', { project, version: tip })).files.map((f) => f.path);
  assert.match(tipGame, /const bg = '#112';/); assert.ok(tipFiles.includes('README.txt'));
  // main's line of history is a chain: each merge is based on the main version before it
  const mainLine = vs.versions.filter((v) => v.branch === 'main').sort((a, b) => a.version - b.version);
  for (let i = 1; i < mainLine.length; i++) assert.equal(mainLine[i].based_on, mainLine[i - 1].version, `main version ${mainLine[i].version} is based on ${mainLine[i - 1].version}`);
  ok(`two change requests merged at once: both landed, one after the other, and main's history is a chain (${mainLine.map((v) => v.version).join(' → ')})`);

  // ---- stress: many agents writing one workspace at once -------------------------------------------------------------
  const agents = [B, C, await agent(bea.cl, 'Bea laptop'), await agent(cal.cl, 'Cal CI'), O, owner2];
  await B.ok('branches', { project, action: 'create', name: 'stress' });
  const writes = [];
  for (let i = 0; i < 36; i++) {
    const a = agents[i % agents.length];
    // half the writes hit the same file, so the last writer wins, but bytes and hash must come from the same write
    writes.push(a('upload_files', { project, branch: 'stress', files: [{ path: i % 2 ? 'shared.txt' : `f/${i}.txt`, content: `write ${i} ${'x'.repeat(i * 37)}` }] }));
  }
  const res = await time('36 concurrent uploads from 6 agents', () => Promise.all(writes));
  const busy = res.filter((r) => r.error);
  assert.ok(busy.every((r) => /writing this workspace right now/.test(r.error)), JSON.stringify(busy.slice(0, 2)));
  const listed = await B.ok('list_files', { project, branch: 'stress' });
  const pulled = await B.ok('pull_version', { project, workspace: true, branch: 'stress', paths: listed.files.filter((f) => f.path.endsWith('.txt')).slice(0, 20).map((f) => f.path) });
  for (const [path, text] of Object.entries(pulled.contents)) assert.equal(listed.files.find((f) => f.path === path).sha, sha(text), `${path}: bytes and recorded hash come from different writes`);
  assert.equal(listed.files.filter((f) => /^f\//.test(f.path)).length, res.filter((r, i) => !r.error && i % 2 === 0).length);
  ok(`36 concurrent writes: ${res.length - busy.length} saved, ${busy.length} told to retry, and every file's bytes match its recorded hash`);

  // writes racing a deploy: the version is exactly one consistent state of the workspace
  const racing = [B.ok('deploy_preview', { project, branch: 'stress', wait_seconds: 0 })];
  for (let i = 0; i < 6; i++) racing.push(C('upload_files', { project, branch: 'stress', files: [{ path: 'shared.txt', content: `late ${i}` }] }));
  const rr = await Promise.all(racing);
  const sv = rr[0].version; await settle(B, project, sv);
  const vfiles = await B.ok('pull_version', { project, version: sv, paths: ['shared.txt'] });
  assert.equal(vfiles.files.find((f) => f.path === 'shared.txt').sha, sha(vfiles.contents['shared.txt']), 'the version froze one consistent write');
  ok('uploads racing a deploy: the version holds one consistent state');

  // ---- access ends with membership ---------------------------------------------------------------------------------
  const url = await B.ok('create_upload_url', { project, branch: 'stress' });
  assert.equal((await fetch(`${url.file_url}a.txt`, { method: 'PUT', body: 'ok' })).status, 200);
  await O.ok('collaborators', { project, action: 'remove', user_id: bea.id });
  const after = await fetch(`${url.file_url}b.txt`, { method: 'PUT', body: 'no' });
  assert.equal(after.status, 404, 'a removed collaborator\'s upload URL stops working');
  await B.err('list_files', { project }, /No project/);
  const cl3 = await C.ok('change_requests', { project, action: 'list', status: 'all' });
  assert.ok(cl3.change_requests.length >= 5);
  ok('a removed collaborator loses access at once, upload URLs included; change requests stay');

  // ---- deleting a branch closes its change request -----------------------------------------------------------------
  await C.ok('upload_files', { project, branch: 'cal/colour', files: [{ path: 'late.txt', content: 'late' }] });
  const v6 = (await C.ok('deploy_preview', { project, branch: 'cal/colour' })).version; await settle(C, project, v6);
  const c6 = await C.ok('change_requests', { project, action: 'open', branch: 'cal/colour', title: 'Late' });
  await C.ok('branches', { project, action: 'delete', name: 'cal/colour' });
  const g6 = await C.ok('change_requests', { project, action: 'get', number: c6.number });
  assert.equal(g6.status, 'closed');
  await C.err('change_requests', { project, action: 'reopen', number: c6.number }, /deleted/);
  ok('deleting a branch closes its change request, which cannot be reopened');

  // ---- the console sees the same --------------------------------------------------------------------------------------
  const view = must(await cal.cl.get(`/api/collab/projects/${project}`));
  assert.equal(view.role, 'maintain'); assert.ok(view.branches.length >= 1);
  must(await dee.cl.get(`/api/collab/projects/${project}`), 404);
  ok('the console API answers with the same rules (a stranger gets 404)');
  console.log(`\nall ${step} collaboration checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
