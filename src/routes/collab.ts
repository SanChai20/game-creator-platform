// The console's side of working together on a game (cookie sign-in): invitations, the people on a game, branches,
// change requests, reviews and merges. Every rule is in src/collab.ts and src/collab-core.ts, shared with the MCP
// tools (src/mcp/collab-tools.ts), so an agent and a person in the console are held to exactly the same checks.
import { Hono } from 'hono';
import { bad, type Env, type User } from '../env';
import { rateLimit, requireUser } from '../auth';
import {
  accessProject, branchView, changeDetail, createBranch, deleteBranch, dismissReview, getBranch, getChange, invite, listBranches, listChanges,
  listMembers, mergeChange, myInvites, openChange, removeMember, resolveConflict, respondInvite, review, revokeInvite,
  setChangeStatus, setProtection, setRole, sharedProjects, updateBranch, branchWs, targetState,
} from '../collab';
import { ROLE_TEXT, MEMBER_ROLES, LIMITS } from '../collab-core';
import { getVersion } from '../projects';
import { enqueue } from '../pipeline';
import { readSourceFile } from '../version-store';
import { diffFiles, diffLine, isSame, textDiff, type FileSig } from '../version-sync';
import { isText, parseJson } from '../util';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
export const collab = new Hono<App>();
const VIA = 'console';
const media = (origin: string, key: string | null) => (key ? `${origin}/api/media/${key}` : null);
async function body(c: any): Promise<Record<string, any>> { return c.req.json().catch(() => ({})); }
/** Writes are capped per person, so a stuck page or a script cannot hammer merges or reviews. */
const writeCap = (c: any, u: User) => rateLimit(c.env, 'collab_w:' + u.id, 240, 600);

collab.get('/mine', async (c) => {
  const u = requireUser(c), origin = c.get('origin');
  const [inv, shared] = await Promise.all([myInvites(c.env, u), sharedProjects(c.env, u.id)]);
  c.header('cache-control', 'private, no-store');
  return c.json({
    invitations: inv.map((r: any) => ({ id: r.id, role: r.role, created_at: r.created_at, expires_at: r.expires_at, project: { id: r.project_id, title: r.title, slug: r.slug, cover: media(origin, r.cover_key) }, invited_by: r.invited_by })),
    shared: shared.map((r: any) => ({ id: r.id, slug: r.slug, title: r.title, tagline: r.tagline, status: r.status, cover: media(origin, r.cover_key), role: r.role, owner: r.owner_name, open_changes: r.open_changes, updated_at: r.updated_at })),
    roles: Object.fromEntries([...MEMBER_ROLES, 'owner' as const].map((r) => [r, ROLE_TEXT[r]])),
  });
});

collab.post('/invites/:id/:answer{accept|decline}', async (c) => {
  const u = requireUser(c); await writeCap(c, u);
  return c.json(await respondInvite(c.env, u, c.req.param('id'), c.req.param('answer') === 'accept', VIA));
});

// ---- one project ----------------------------------------------------------------------------------------------------
async function proj(c: any, need: 'read' | 'write' = 'read') {
  const u = requireUser(c);
  const { p, role } = await accessProject(c.env, u, c.req.param('id'), need);
  return { u, p, role };
}

collab.get('/projects/:id', async (c) => {
  const { p, role } = await proj(c), origin = c.get('origin');
  const [people, br, changes] = await Promise.all([listMembers(c.env, p, role), listBranches(c.env, p), listChanges(c.env, p, 'open')]);
  c.header('cache-control', 'private, no-store');
  return c.json({
    project: { id: p.id, slug: p.slug, title: p.title, status: p.status, cover: media(origin, p.cover_key), preview_version: p.preview_version, live_version: p.status === 'live' ? p.live_version : null },
    role, role_text: ROLE_TEXT[role], roles: Object.fromEntries([...MEMBER_ROLES, 'owner' as const].map((r) => [r, ROLE_TEXT[r]])), limits: { members: LIMITS.members, branches: LIMITS.branches },
    ...people, main: br.main, branches: br.branches, changes,
  });
});

collab.post('/projects/:id/invites', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  return c.json(await invite(c.env, u, role, p, b.email, b.role, c.get('origin'), VIA));
});
collab.delete('/projects/:id/invites/:inv', async (c) => {
  const { u, p, role } = await proj(c); await writeCap(c, u);
  return c.json(await revokeInvite(c.env, role, p, c.req.param('inv')));
});
collab.post('/projects/:id/members/:uid', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  return c.json(await setRole(c.env, u, role, p, c.req.param('uid'), b.role, VIA));
});
collab.delete('/projects/:id/members/:uid', async (c) => {
  const { u, p, role } = await proj(c); await writeCap(c, u);
  return c.json(await removeMember(c.env, u, role, p, c.req.param('uid'), VIA));
});
collab.post('/projects/:id/protection', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  return c.json(await setProtection(c.env, u, role, p, b, VIA));
});

// branches: a name may hold "/", so it travels in the body or the query, never the path
collab.get('/projects/:id/branch', async (c) => {
  const { p } = await proj(c), b = await getBranch(c.env, p, String(c.req.query('name') || ''));
  const st = await targetState(c.env, p, { ws: branchWs(p.id, b.id), branch: b, label: b.name });
  return c.json({ ...(await branchView(c.env, p, b)), workspace: { files: st.files.length, based_on_version: st.base, changed_since: st.diff ? (isSame(st.diff) ? null : diffLine(st.diff)) : null } });
});
collab.post('/projects/:id/branches', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  return c.json(await createBranch(c.env, u, role, p, b.name, b.from, VIA));
});
collab.post('/projects/:id/branches/:op{update|delete|resolve}', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  const name = String(b.name || ''), op = c.req.param('op');
  if (!name) throw bad('name is needed.');
  if (op === 'update') return c.json(await updateBranch(c.env, u, role, p, name, VIA));
  if (op === 'resolve') return c.json(await resolveConflict(c.env, role, p, name, String(b.path || ''), b.take));
  return c.json(await deleteBranch(c.env, u, role, p, name, VIA));
});

// change requests
collab.get('/projects/:id/changes', async (c) => {
  const { p } = await proj(c);
  return c.json({ changes: await listChanges(c.env, p, c.req.query('status')) });
});
collab.post('/projects/:id/changes', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  return c.json(await openChange(c.env, u, role, p, String(b.branch || ''), b.title, b.body, VIA));
});
collab.get('/projects/:id/changes/:n', async (c) => {
  const { u, p, role } = await proj(c);
  c.header('cache-control', 'private, no-store');
  return c.json(await changeDetail(c.env, p, u, role, c.req.param('n')));
});
/** The line diffs of what a change request changes (its merge base against its newest version), capped. */
collab.get('/projects/:id/changes/:n/diff', async (c) => {
  const { p } = await proj(c), ch = await getChange(c.env, p, c.req.param('n'));
  const br = await c.env.DB.prepare('SELECT base_version, head_version FROM branches WHERE id = ?').bind(ch.branch_id).first<{ base_version: number | null; head_version: number | null }>();
  const head = ch.status === 'merged' ? ch.merged_head : br?.head_version;
  if (!head) return c.json({ files: [] });
  const [baseV, headV] = await Promise.all([br?.base_version ? getVersion(c.env, p.id, br.base_version) : null, getVersion(c.env, p.id, head)]);
  const A = parseJson<FileSig[]>(baseV?.files, []), B = parseJson<FileSig[]>(headV?.files, []), d = diffFiles(A, B);
  const out: { path: string; kind: string; diff?: string; truncated?: boolean; binary?: boolean }[] = [];
  let budget = 400_000;
  const text = async (n: number | null | undefined, path: string) => (n ? (await readSourceFile(c.env, p, { version: n }, path))?.text() ?? '' : '');
  for (const [kind, list] of [['changed', d.changed], ['added', d.added], ['removed', d.removed]] as const) for (const f of list) {
    if (!isText(f.path) || (f.bytes_before || 0) > 1_000_000 || (f.bytes_after || 0) > 1_000_000 || budget <= 0) { out.push({ path: f.path, kind, binary: !isText(f.path) }); continue; }
    const r = textDiff(kind === 'added' ? '' : await text(br?.base_version, f.path), kind === 'removed' ? '' : await text(head, f.path), f.path, { maxLines: 600 });
    if (!r) { out.push({ path: f.path, kind, truncated: true }); continue; }
    budget -= r.diff.length; out.push({ path: f.path, kind, diff: r.diff, ...(r.truncated ? { truncated: true } : {}) });
  }
  return c.json({ base: br?.base_version ?? null, head, summary: diffLine(d), files: out });
});
collab.post('/projects/:id/changes/:n/review', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  return c.json(await review(c.env, u, role, p, c.req.param('n'), b.verdict, b.body, b.path, b.line, VIA));
});
collab.post('/projects/:id/changes/:n/reviews/:rid/dismiss', async (c) => {
  const { u, p, role } = await proj(c); await writeCap(c, u);
  return c.json(await dismissReview(c.env, u, role, p, c.req.param('n'), c.req.param('rid')));
});
collab.post('/projects/:id/changes/:n/:op{close|reopen}', async (c) => {
  const { u, p, role } = await proj(c); await writeCap(c, u);
  return c.json(await setChangeStatus(c.env, u, role, p, c.req.param('n'), c.req.param('op') === 'close' ? 'closed' : 'open', VIA));
});
collab.post('/projects/:id/changes/:n/merge', async (c) => {
  const { u, p, role } = await proj(c), b = await body(c); await writeCap(c, u);
  const origin = c.get('origin');
  return c.json(await mergeChange(c.env, u, role, p, c.req.param('n'), {
    bypass: b.bypass === true, delete_branch: b.delete_branch === true, via: VIA, origin,
    enqueue: (n) => enqueue(c.env, { kind: 'preview', pid: p.id, n, origin, actor: VIA }),
  }));
});


