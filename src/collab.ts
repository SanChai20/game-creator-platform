// Multi-developer, multi-agent collaboration on one game: the storage side. The rules (roles, protection, three-way
// merge, whether a change request can be merged) are in src/collab-core.ts; the design is docs/collaboration.md.
//
// Workspaces. main is the project's own workspace (files rows and R2 objects under ws/<project>/…), exactly as before.
// A branch is a workspace of its own under the id "<project>~<branch id>", in the same files table and bucket, so every
// existing function that reads or writes a workspace (upload, checks, deploy, checkout, diff, pull) works on a branch by
// being given that id. Versions are numbered per project as before; a version deployed from a branch carries its branch
// id, and main's history is the versions without one (main deploys and merges).
//
// Concurrency. Every write to a workspace runs under a short lease (ws_locks), so two agents writing the same working
// copy at once cannot leave a file's bytes and its recorded hash from different writes, and a deploy never freezes a
// half-written workspace. A version number and its row are taken in one transaction, conditioned on the version the
// change started from (src/projects.ts snapshot), so two merges or two deploys onto the same base cannot both win.
// A merge first claims its change request (open → merging), so it is merged once however many agents press merge.
import { AppError, bad, forbidden, notFound, type Env, type Project, type User, type Version } from './env';
import { checkProject, getProject, getVersion, listFiles, logEvent, putFile, snapshot, verKey, versionEligible, wsKey } from './projects';
import { getSettings } from './settings';
import { assertFits } from './storage';
import { sendMail } from './mail';
import { rateLimit } from './auth';
import { isText, now, parseJson, rid } from './util';
import { diffFiles, diffLine, isSame, type FileSig } from './version-sync';
import {
  LIMITS, PERMS, ROLE_TEXT, atLeast, branchName, can, hasConflictMarkers, inviteOpen, isMemberRole, looksLikeEmail, mayManage, mayPushMain,
  merge3Text, mergeTrees, mergeability, normEmail, parseProtection, updateProtection,
  type Action, type MemberRole, type Mergeability, type Protection, type ReviewLite, type Role, type Verdict,
} from './collab-core';

export const branchWs = (pid: string, bid: string) => `${pid}~${bid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Branch {
  id: string; project_id: string; name: string; created_by: string; base_version: number | null; head_version: number | null; ws_base: number | null;
  conflicts: string; status: 'open' | 'deleted'; created_at: number; updated_at: number;
}
export interface Change {
  id: string; project_id: string; number: number; branch_id: string; title: string; body: string; author_id: string; actor: string;
  status: 'open' | 'merging' | 'merged' | 'closed'; merged_version: number | null; merged_head: number | null; merged_by: string | null; closed_by: string | null;
  created_at: number; updated_at: number; closed_at: number | null;
}

// ---------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------
/** This user's role on the project: owner (or a platform admin), a collaborator's role, or null. */
export async function roleOf(env: Env, user: Pick<User, 'id' | 'role'>, p: Pick<Project, 'id' | 'owner_id'>): Promise<Role | null> {
  if (p.owner_id === user.id || user.role === 'admin') return 'owner';
  const m = await env.DB.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').bind(p.id, user.id).first<{ role: string }>();
  return m && isMemberRole(m.role) ? m.role : null;
}

const roleRefusal = (role: Role, need: Role, what: string) => forbidden(
  `Your role on this project is ${role}, and ${what} needs ${need} or higher.`,
  `${ROLE_TEXT[role]} Ask the owner or an admin of the project for a higher role (collaborators {action: "list"} shows who they are).`,
);

/**
 * The project and this user's role, refused unless the role reaches `need`. A project the user has no role on is
 * answered exactly like one that does not exist, so collaborator access never reveals other creators' games.
 */
export async function accessProject(env: Env, user: User, idOrSlug: string, need: Role | Action = 'read', what = 'this'): Promise<{ p: Project; role: Role }> {
  const p = await getProject(env, idOrSlug);
  const role = p ? await roleOf(env, user, p) : null;
  if (!p || !role || (p.status === 'removed' && user.role !== 'admin')) throw notFound(`No project "${idOrSlug}". Call list_projects to see yours and the ones shared with you.`);
  const needRole = (need in PERMS ? PERMS[need as Action] : need) as Role;
  if (!atLeast(role, needRole)) throw roleRefusal(role, needRole, what);
  return { p, role };
}

export function assertCan(role: Role, action: Action, what: string) {
  if (!can(role, action)) throw roleRefusal(role, PERMS[action], what);
}

/** main's newest version: main deploys and merges (versions without a branch). 0 when main has none yet. */
export async function mainHead(env: Env, pid: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM versions WHERE project_id = ? AND branch IS NULL').bind(pid).first<{ n: number }>();
  return r?.n || 0;
}

export function protectionOf(p: Project): Protection { return parseProtection((p as any).protection); }

// ---------------------------------------------------------------------------------------------
// Workspace leases
// ---------------------------------------------------------------------------------------------
const LEASE_MS = 60_000;

/**
 * Runs `fn` while holding this workspace's lease. Another writer waits (up to `waitMs`, then a 409 that says to try
 * again). A lease left by a crashed request lapses after a minute; a long operation renews it through `renew`.
 */
export async function withLock<T>(env: Env, ws: string, fn: (renew: () => Promise<void>) => Promise<T>, waitMs = 10_000): Promise<T> {
  const holder = rid(16), end = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const t = now();
    const got = await env.DB.prepare('INSERT INTO ws_locks (ws, holder, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(ws) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE ws_locks.expires_at < ?4 RETURNING holder')
      .bind(ws, holder, t + LEASE_MS, t).first<{ holder: string }>();
    if (got?.holder === holder) break;
    if (Date.now() > end) throw new AppError(409, 'Another agent is writing this workspace right now, so nothing was changed.', 'workspace_busy', 'Wait a few seconds and call again. Each agent working at the same time is best on a branch of its own: branches {action: "create"}.');
    await sleep(Math.min(800, 40 * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * 60));
  }
  const renew = async () => { await env.DB.prepare('UPDATE ws_locks SET expires_at = ? WHERE ws = ? AND holder = ?').bind(now() + LEASE_MS, ws, holder).run(); };
  try { return await fn(renew); }
  finally { await env.DB.prepare('DELETE FROM ws_locks WHERE ws = ? AND holder = ?').bind(ws, holder).run().catch(() => {}); }
}

// ---------------------------------------------------------------------------------------------
// Which workspace a tool call works on
// ---------------------------------------------------------------------------------------------
export interface Target { ws: string; branch: Branch | null; label: string }

/**
 * The workspace a call names: main (no branch, or "main") or an open branch. Writing main needs the role main's
 * protection allows; writing a branch needs write. Reading needs read.
 */
export async function target(env: Env, p: Project, role: Role, raw: unknown, mode: 'read' | 'write'): Promise<Target> {
  const name = raw === undefined || raw === null || raw === '' ? 'main' : String(raw).trim().toLowerCase();
  if (name === 'main') {
    if (mode === 'write' && !mayPushMain(role, protectionOf(p))) {
      const prot = protectionOf(p);
      throw forbidden(
        `main is protected: your role (${role}) cannot change it directly${prot.main_writers !== 'maintain' ? ` (only ${prot.main_writers} can)` : ''}.`,
        'Work on a branch and propose it: branches {project, action: "create", name}, then upload_files/deploy_preview with {branch}, then change_requests {action: "open", branch}.',
      );
    }
    return { ws: p.id, branch: null, label: 'main' };
  }
  const b = await getBranch(env, p, name);
  if (mode === 'write') assertCan(role, 'push_branch', `changing branch ${b.name}`);
  return { ws: branchWs(p.id, b.id), branch: b, label: `branch ${b.name}` };
}

export async function getBranch(env: Env, p: Project, name: string): Promise<Branch> {
  const b = await env.DB.prepare("SELECT * FROM branches WHERE project_id = ? AND name = ? AND status = 'open'").bind(p.id, String(name).toLowerCase()).first<Branch>();
  if (!b) {
    const names = (await env.DB.prepare("SELECT name FROM branches WHERE project_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 20").bind(p.id).all<{ name: string }>()).results.map((r) => r.name);
    throw notFound(`No branch "${name}" in this project.`, names.length ? `Branches: main, ${names.join(', ')}.` : 'This project has only main. branches {action: "create", name} makes one.');
  }
  return b;
}

/** The version a workspace is based on, its newest version, and what changed since. */
export async function targetState(env: Env, p: Project, t: Target) {
  const files = await listFiles(env, t.ws);
  const base = t.branch ? (t.branch.ws_base ?? t.branch.base_version) : (p.ws_base ?? null);
  const v = base ? await getVersion(env, p.id, base) : null;
  const d = v ? diffFiles(parseJson<FileSig[]>(v.files, []), files.map((f) => ({ path: f.path, size: f.size, sha: f.sha }))) : null;
  return { files, base: v ? base : null, diff: d };
}

// ---------------------------------------------------------------------------------------------
// Collaborators and invitations
// ---------------------------------------------------------------------------------------------
export async function listMembers(env: Env, p: Project, viewer: Role) {
  const owner = await env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(p.owner_id).first<{ id: string; name: string; email: string }>();
  const rows = (await env.DB.prepare('SELECT m.user_id, m.role, m.created_at, u.name, u.email FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.created_at').bind(p.id).all<any>()).results;
  const admin = atLeast(viewer, 'admin');
  const invites = admin ? (await env.DB.prepare("SELECT id, email, role, invited_by, created_at, expires_at FROM project_invites WHERE project_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC").bind(p.id, now()).all<any>()).results : [];
  return {
    members: [
      { user_id: owner?.id || p.owner_id, name: owner?.name || 'Owner', role: 'owner' as Role, ...(admin && owner ? { email: owner.email } : {}) },
      ...rows.map((r) => ({ user_id: r.user_id, name: r.name, role: r.role as Role, since: r.created_at, ...(admin ? { email: r.email } : {}) })),
    ],
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, created_at: i.created_at, expires_at: i.expires_at })),
  };
}

export async function invite(env: Env, actor: User, role: Role, p: Project, rawEmail: unknown, rawRole: unknown, origin: string, via = 'console') {
  const email = normEmail(rawEmail);
  if (!looksLikeEmail(email)) throw bad('Give the email address the collaborator signs in to HearthCade with.');
  if (!isMemberRole(rawRole)) throw bad('role is one of read, write, maintain, admin.', Object.values(ROLE_TEXT).slice(0, 4).join(' '));
  const ok = mayManage(role, null, rawRole);
  if (!ok.ok) throw forbidden(ok.error);
  await rateLimit(env, 'collab_invite:' + actor.id, 30, 3600);   // invitations are emailed: a cap per inviter per hour
  const existing = await env.DB.prepare('SELECT u.id, (SELECT role FROM project_members m WHERE m.project_id = ? AND m.user_id = u.id) AS role FROM users u WHERE u.email = ?').bind(p.id, email).first<{ id: string; role: string | null }>();
  if (existing?.id === p.owner_id) throw bad('That is the owner of this project.');
  if (existing?.role) throw bad(`That person is already a collaborator (${existing.role}).`, 'collaborators {action: "set_role"} changes their role.');
  const t = now();
  const [members, pending] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').bind(p.id).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM project_invites WHERE project_id = ? AND status = 'pending' AND expires_at > ?").bind(p.id, t).first<{ n: number }>(),
  ]);
  if ((members?.n || 0) >= LIMITS.members) throw forbidden(`This project already has ${LIMITS.members} collaborators, the most it can have.`);
  if ((pending?.n || 0) >= LIMITS.pending_invites) throw forbidden(`This project has ${LIMITS.pending_invites} open invitations. Revoke some first.`);
  const id = 'inv_' + rid(14), exp = t + LIMITS.invite_days * 86400000;
  // an open invitation to the same address is renewed with the new role rather than doubled (one open per address)
  await env.DB.batch([
    env.DB.prepare("UPDATE project_invites SET status = 'revoked', responded_at = ? WHERE project_id = ? AND email = ? AND status = 'pending'").bind(t, p.id, email),
    env.DB.prepare('INSERT INTO project_invites (id, project_id, email, role, invited_by, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?)').bind(id, p.id, email, rawRole, actor.id, t, exp),
  ]);
  await logEvent(env, p.id, 'member_invited', `${actor.name} invited ${email} as ${rawRole}`, null, via);
  const link = `${origin}/team`;
  const sent = await sendMail(env, {
    to: email, subject: `${actor.name} invited you to work on ${p.title}`,
    text: `${actor.name} invited you to work on "${p.title}" on HearthCade as ${rawRole}.\n\n${ROLE_TEXT[rawRole]}\n\nSign in with this email address and accept: ${link}\n\nThe invitation is open for ${LIMITS.invite_days} days.`,
    html: `<p>${esc(actor.name)} invited you to work on <b>${esc(p.title)}</b> on HearthCade as <b>${rawRole}</b>.</p><p>${esc(ROLE_TEXT[rawRole])}</p><p><a href="${esc(link)}">Sign in with this email address and accept</a>. The invitation is open for ${LIMITS.invite_days} days.</p>`,
  }).catch(() => false);
  return { invite: { id, email, role: rawRole, expires_at: exp }, emailed: sent };
}
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/** The open invitations for the address this account signs in with. */
export async function myInvites(env: Env, user: User) {
  const rows = await env.DB.prepare(`SELECT i.id, i.role, i.created_at, i.expires_at, p.id AS project_id, p.title, p.slug, p.cover_key, u.name AS invited_by
    FROM project_invites i JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.invited_by
    WHERE i.email = ? AND i.status = 'pending' AND i.expires_at > ? AND p.status != 'removed' ORDER BY i.created_at DESC LIMIT 50`).bind(normEmail(user.email), now()).all<any>();
  return rows.results;
}

export async function respondInvite(env: Env, user: User, id: string, accept: boolean, via = 'console') {
  const t = now();
  const inv = await env.DB.prepare('SELECT * FROM project_invites WHERE id = ?').bind(id).first<any>();
  if (!inv || inv.email !== normEmail(user.email)) throw notFound('No such invitation for this account.', 'Invitations are for the email address they were sent to: sign in with that one.');
  if (!inviteOpen(inv, t)) throw new AppError(409, `This invitation is ${inv.status === 'pending' ? 'expired' : inv.status}.`, 'invite_closed', 'Ask for a new one.');
  const p = await getProject(env, inv.project_id);
  if (!p || p.status === 'removed') throw notFound('That project no longer exists.');
  if (p.owner_id === user.id) throw bad('You own this project.');
  // claimed once: the same invitation accepted twice at once joins once
  const claimed = await env.DB.prepare("UPDATE project_invites SET status = ?, responded_at = ?, user_id = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
    .bind(accept ? 'accepted' : 'declined', t, user.id, id, t).run();
  if (!claimed.meta.changes) throw new AppError(409, 'This invitation was already answered.', 'invite_closed');
  if (!accept) { await logEvent(env, p.id, 'invite_declined', `${user.name} declined`, null, via); return { declined: true, project: p.id }; }
  // the member count is checked in the same statement that adds the row, so simultaneous accepts never pass the limit
  const added = await env.DB.prepare(`INSERT INTO project_members (project_id, user_id, role, added_by, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?5 WHERE (SELECT COUNT(*) FROM project_members WHERE project_id = ?1) < ?6
    ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`).bind(p.id, user.id, inv.role, inv.invited_by, t, LIMITS.members).run();
  if (!added.meta.changes) {
    await env.DB.prepare("UPDATE project_invites SET status = 'pending', responded_at = NULL, user_id = NULL WHERE id = ?").bind(id).run();
    throw forbidden(`This project already has ${LIMITS.members} collaborators, the most it can have.`);
  }
  await logEvent(env, p.id, 'member_joined', `${user.name} joined as ${inv.role}`, null, via);
  return { joined: true, project: p.id, slug: p.slug, title: p.title, role: inv.role as MemberRole };
}

export async function revokeInvite(env: Env, role: Role, p: Project, id: string) {
  const inv = await env.DB.prepare("SELECT role FROM project_invites WHERE id = ? AND project_id = ? AND status = 'pending'").bind(id, p.id).first<{ role: MemberRole }>();
  if (!inv) throw notFound('No open invitation with that id.');
  const ok = mayManage(role, null, inv.role);
  if (!ok.ok) throw forbidden(ok.error);
  await env.DB.prepare("UPDATE project_invites SET status = 'revoked', responded_at = ? WHERE id = ? AND status = 'pending'").bind(now(), id).run();
  return { revoked: id };
}

export async function setRole(env: Env, actor: User, role: Role, p: Project, userId: string, rawRole: unknown, via = 'console') {
  if (!isMemberRole(rawRole)) throw bad('role is one of read, write, maintain, admin.');
  const cur = await roleOf(env, { id: userId, role: 'user' }, p);
  if (!cur) throw notFound('That person is not a collaborator on this project.');
  const ok = mayManage(role, cur, rawRole);
  if (!ok.ok) throw forbidden(ok.error);
  await env.DB.prepare('UPDATE project_members SET role = ?, updated_at = ? WHERE project_id = ? AND user_id = ?').bind(rawRole, now(), p.id, userId).run();
  await logEvent(env, p.id, 'member_role', `${actor.name} set ${userId} to ${rawRole}`, null, via);
  return { user_id: userId, role: rawRole };
}

export async function removeMember(env: Env, actor: User, role: Role, p: Project, userId: string, via = 'console') {
  const cur = await roleOf(env, { id: userId, role: 'user' }, p);
  if (!cur || cur === 'owner') throw notFound('That person is not a collaborator on this project.');
  if (userId !== actor.id) { const ok = mayManage(role, cur, null); if (!ok.ok) throw forbidden(ok.error); }
  await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(p.id, userId).run();
  await logEvent(env, p.id, userId === actor.id ? 'member_left' : 'member_removed', userId === actor.id ? `${actor.name} left` : `${actor.name} removed ${userId}`, null, via);
  return { removed: userId };
}

/** Projects shared with this user (not their own), with their role. */
export async function sharedProjects(env: Env, userId: string) {
  return (await env.DB.prepare(`SELECT p.id, p.slug, p.title, p.tagline, p.status, p.cover_key, p.preview_version, p.updated_at, m.role, u.name AS owner_name,
      (SELECT COUNT(*) FROM change_requests c WHERE c.project_id = p.id AND c.status = 'open') AS open_changes
    FROM project_members m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = p.owner_id
    WHERE m.user_id = ? AND p.status != 'removed' ORDER BY p.updated_at DESC LIMIT 200`).bind(userId).all<any>()).results;
}

// ---------------------------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------------------------
async function copyObjects(env: Env, files: { path: string; size: number; sha: string }[], from: (path: string) => string, ws: string, renew?: () => Promise<void>) {
  let i = 0;
  for (const f of files) {
    const obj = await env.FILES.get(from(f.path));
    if (!obj) throw new AppError(500, `${f.path} is missing from storage.`);
    const ctype = obj.httpMetadata?.contentType || 'application/octet-stream';
    await env.FILES.put(wsKey(ws, f.path), obj.body, { httpMetadata: { contentType: ctype } });
    await env.DB.prepare('INSERT INTO files (project_id, path, size, sha, ctype, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET size = excluded.size, sha = excluded.sha, ctype = excluded.ctype, updated_at = excluded.updated_at')
      .bind(ws, f.path, f.size, f.sha, ctype, now()).run();
    if (renew && ++i % 25 === 0) await renew();
  }
}
async function dropFile(env: Env, ws: string, path: string) {
  await env.DB.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').bind(ws, path).run();
  await env.FILES.delete(wsKey(ws, path));
}
async function dropWorkspace(env: Env, ws: string) {
  const rows = await listFiles(env, ws);
  for (let i = 0; i < rows.length; i += 100) await env.FILES.delete(rows.slice(i, i + 100).map((f) => wsKey(ws, f.path)));
  await env.DB.prepare('DELETE FROM files WHERE project_id = ?').bind(ws).run();
}
const versionFiles = (v: Version | null): FileSig[] => (v ? parseJson<FileSig[]>(v.files, []) : []);

export async function branchView(env: Env, p: Project, b: Branch, head0?: number) {
  const head = head0 ?? await mainHead(env, p.id);
  const behind = b.base_version === null ? (head ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND branch IS NULL').bind(p.id).first<{ n: number }>())!.n : 0)
    : (await env.DB.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND branch IS NULL AND n > ?').bind(p.id, b.base_version).first<{ n: number }>())!.n;
  const ahead = (await env.DB.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND branch = ?').bind(p.id, b.id).first<{ n: number }>())!.n;
  const creator = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(b.created_by).first<{ name: string }>();
  const cr = await env.DB.prepare("SELECT number, title, status FROM change_requests WHERE branch_id = ? AND status IN ('open','merging') LIMIT 1").bind(b.id).first<any>();
  const headV = b.head_version ? await getVersion(env, p.id, b.head_version) : null;
  return {
    name: b.name, created_by: creator?.name || b.created_by, created_by_id: b.created_by, created_at: b.created_at, updated_at: b.updated_at,
    base_version: b.base_version, head_version: b.head_version, head_status: headV?.status ?? null,
    versions_on_branch: ahead, main_versions_since_base: behind, main_head: head || null,
    conflicts: parseJson<string[]>(b.conflicts, []),
    change_request: cr ? { number: cr.number, title: cr.title, status: cr.status } : null,
  };
}

export async function listBranches(env: Env, p: Project) {
  const rows = (await env.DB.prepare("SELECT * FROM branches WHERE project_id = ? AND status = 'open' ORDER BY updated_at DESC").bind(p.id).all<Branch>()).results;
  const head = await mainHead(env, p.id);
  return { main: { head_version: head || null, workspace_based_on: p.ws_base ?? null, protection: protectionOf(p) }, branches: await Promise.all(rows.map((b) => branchView(env, p, b, head))) };
}

/**
 * A new branch, forked from a main version (main's newest by default): its workspace starts as that version's files,
 * and that version is its merge base. `from: "workspace"` forks main's workspace as it is instead (for a game with no
 * version yet, or to carry undeployed work over); its merge base is then the version main's workspace is based on.
 */
export async function createBranch(env: Env, user: User, role: Role, p: Project, rawName: unknown, from: unknown, via = 'console') {
  assertCan(role, 'push_branch', 'creating a branch');
  const nm = branchName(rawName);
  if (!nm.ok) throw bad(nm.error);
  const [open, mine] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM branches WHERE project_id = ? AND status = 'open'").bind(p.id).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM branches WHERE project_id = ? AND status = 'open' AND created_by = ?").bind(p.id, user.id).first<{ n: number }>(),
  ]);
  if ((open?.n || 0) >= LIMITS.branches) throw forbidden(`This project has ${LIMITS.branches} branches, the most it can have. Delete merged ones first.`);
  if ((mine?.n || 0) >= LIMITS.branches_per_user) throw forbidden(`You have ${LIMITS.branches_per_user} branches on this project. Delete merged ones first.`);
  const head = await mainHead(env, p.id);
  let base: number | null, files: FileSig[], src: (path: string) => string;
  if (from === 'workspace' || (!head && (from === undefined || from === null || from === ''))) {
    files = (await listFiles(env, p.id)).map((f) => ({ path: f.path, size: f.size, sha: f.sha }));
    base = p.ws_base ?? (head || null); src = (path) => wsKey(p.id, path);
  } else {
    const n = from === undefined || from === null || from === '' ? head : Number(from);
    const v = Number.isInteger(n) && n > 0 ? await getVersion(env, p.id, n) : null;
    if (!v) throw notFound(`Version ${from} does not exist.`);
    if (v.branch) throw bad(`Version ${n} was deployed on another branch. Fork from a main version (main's newest is ${head || 'none yet'}), or omit from.`);
    files = versionFiles(v); base = n; src = (path) => verKey(p.id, n, path);
  }
  assertFits(await getSettings(env), p, [], files.map((f) => ({ path: f.path, size: f.size })));
  const id = rid(10), t = now();
  try {
    await env.DB.prepare('INSERT INTO branches (id, project_id, name, created_by, base_version, head_version, ws_base, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, \'open\', ?, ?)')
      .bind(id, p.id, nm.name, user.id, base, base, t, t).run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error).message))) throw new AppError(409, `A branch named "${nm.name}" already exists.`, 'branch_exists', 'Use it (upload_files {branch}) or pick another name.');
    throw e;
  }
  const ws = branchWs(p.id, id);
  try {
    await withLock(env, ws, async (renew) => {
      if (from === 'workspace') await withLock(env, p.id, () => copyObjects(env, files, src, ws, renew));
      else await copyObjects(env, files, src, ws, renew);
    });
  } catch (e) {
    await env.DB.prepare("UPDATE branches SET status = 'deleted', updated_at = ? WHERE id = ?").bind(now(), id).run();
    await dropWorkspace(env, ws).catch(() => {});
    throw e;
  }
  await logEvent(env, p.id, 'branch_created', `${user.name} created ${nm.name} from ${base ? `version ${base}` : 'an empty main'}`, base, via);
  const b = (await env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(id).first<Branch>())!;
  return { branch: await branchView(env, p, b), files: files.length };
}

export async function deleteBranch(env: Env, user: User, role: Role, p: Project, name: string, via = 'console') {
  const b = await getBranch(env, p, name);
  if (b.created_by !== user.id) assertCan(role, 'manage_branches', `deleting ${b.name}, which someone else created,`);
  const ws = branchWs(p.id, b.id);
  await withLock(env, ws, async () => {
    const t = now();
    const r = await env.DB.prepare("UPDATE branches SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'open'").bind(t, b.id).run();
    if (!r.meta.changes) throw notFound(`Branch ${b.name} was already deleted.`);
    // deleting a branch closes its change request, as on GitHub
    await env.DB.prepare("UPDATE change_requests SET status = 'closed', closed_by = ?, closed_at = ?, updated_at = ? WHERE branch_id = ? AND status = 'open'").bind(user.id, t, t, b.id).run();
    await dropWorkspace(env, ws);
  });
  await logEvent(env, p.id, 'branch_deleted', `${user.name} deleted ${b.name}`, null, via);
  return { deleted: b.name, note: 'The branch\'s versions stay in the version list; only its workspace is gone.' };
}

async function readText(env: Env, key: string): Promise<string | null> {
  const o = await env.FILES.get(key);
  return o ? o.text() : null;
}

/**
 * Brings main's newest version into a branch (git merge main, from the branch): the branch workspace's own changes stay,
 * main's changes come in, lines both changed get git's conflict markers, and a file one side deleted while the other
 * changed it keeps the branch's side and is listed as a conflict. The branch's merge base becomes main's newest version.
 */
export async function updateBranch(env: Env, user: User, role: Role, p: Project, name: string, via = 'console') {
  const b0 = await getBranch(env, p, name);
  assertCan(role, 'push_branch', `updating ${b0.name}`);
  const ws = branchWs(p.id, b0.id);
  return withLock(env, ws, async (renew) => {
    const b = await getBranch(env, p, name), head = await mainHead(env, p.id);
    if (!head) return { updated: false, reason: 'main has no version yet, so there is nothing to bring in.' };
    if (b.base_version === head) return { updated: false, reason: `The branch already has main's newest version (${head}).`, conflicts: parseJson<string[]>(b.conflicts, []) };
    const baseV = b.base_version ? await getVersion(env, p.id, b.base_version) : null, mainV = (await getVersion(env, p.id, head))!;
    const mine = (await listFiles(env, ws)).map((f) => ({ path: f.path, size: f.size, sha: f.sha }));
    const tm = mergeTrees(versionFiles(baseV), mine, versionFiles(mainV));
    const s = await getSettings(env);
    const written: string[] = [], removed: string[] = [], merged: string[] = [], conflicts = new Set<string>(parseJson<string[]>(b.conflicts, []));
    const mainKey = (path: string) => verKey(p.id, head, path);
    for (const pk of tm.picks) {
      if (pk.from === 'theirs') { await copyObjects(env, [pk.sig], mainKey, ws); written.push(pk.path); }
      else if (pk.from === 'deleted' && mine.some((f) => f.path === pk.path)) { await dropFile(env, ws, pk.path); removed.push(pk.path); }
    }
    await renew();
    for (const x of tm.both) {
      const textual = isText(x.path) && x.ours.size <= LIMITS.merge_text_bytes && x.theirs.size <= LIMITS.merge_text_bytes;
      const [bt, ot, tt] = textual ? await Promise.all([x.base ? readText(env, verKey(p.id, b.base_version!, x.path)) : '', readText(env, wsKey(ws, x.path)), readText(env, mainKey(x.path))]) : [null, null, null];
      const m = textual && ot !== null && tt !== null ? merge3Text(bt ?? '', ot, tt, { ours: `${b.name} (your branch)`, theirs: `main (version ${head})` }) : null;
      if (m) {
        await putFile(env, p, x.path, new TextEncoder().encode(m.text), true, ws);
        if (m.conflicts) conflicts.add(x.path); else merged.push(x.path);
      } else conflicts.add(x.path);   // binary or too big: the branch's file stays, listed as a conflict
    }
    for (const x of tm.conflicts) conflicts.add(x.path);   // changed on one side, deleted on the other: the branch's side stays
    const after = await listFiles(env, ws);
    assertFits(s, p, [], after.map((f) => ({ path: f.path, size: f.size })));
    const list = [...conflicts].sort();
    await env.DB.prepare('UPDATE branches SET base_version = ?, conflicts = ?, updated_at = ? WHERE id = ?').bind(head, JSON.stringify(list), now(), b.id).run();
    await logEvent(env, p.id, 'branch_updated', `${user.name} brought main (version ${head}) into ${b.name}${list.length ? `: ${list.length} conflict(s)` : ''}`, head, via);
    return {
      updated: true, merge_base: head, from_main: written, removed, merged_by_lines: merged, conflicts: list,
      next: list.length
        ? `Resolve each conflict: open the file, keep the right lines between <<<<<<< and >>>>>>>, delete the markers and upload it (upload_files {branch}); a deleted-vs-changed or binary file: branches {action: "resolve", path, take: "main"|"branch"}. Then deploy_preview {branch}.`
        : 'No conflicts. deploy_preview {branch} makes a new version of the branch with main\'s changes in it.',
    };
  });
}

/** Marks conflicts resolved: take main's file, keep the branch's, or (text) accept what is in the workspace now. */
export async function resolveConflict(env: Env, role: Role, p: Project, name: string, path: string, take: unknown) {
  const b0 = await getBranch(env, p, name);
  assertCan(role, 'push_branch', `resolving conflicts on ${b0.name}`);
  const ws = branchWs(p.id, b0.id);
  return withLock(env, ws, async () => {
    const b = await getBranch(env, p, name), list = parseJson<string[]>(b.conflicts, []);
    if (!list.includes(path)) throw notFound(`${path} is not in conflict on ${b.name}.`, list.length ? `Conflicts: ${list.join(', ')}.` : 'The branch has no conflicts.');
    if (take === 'main') {
      const head = b.base_version!, mv = await getVersion(env, p.id, head), sig = versionFiles(mv).find((f) => f.path === path);
      if (sig) await copyObjects(env, [sig], (x) => verKey(p.id, head, x), ws); else await dropFile(env, ws, path);
    } else if (take === 'branch' || take === 'workspace') {
      const f = (await listFiles(env, ws)).find((x) => x.path === path);
      if (f && isText(path)) { const txt = await readText(env, wsKey(ws, path)); if (txt && hasConflictMarkers(txt)) throw bad(`${path} still has conflict markers. Edit it first, or take "main".`); }
    } else throw bad('take is "main" (use main\'s file) or "branch" (keep the file in the branch workspace as it is now).');
    const rest = list.filter((x) => x !== path);
    await env.DB.prepare('UPDATE branches SET conflicts = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(rest), now(), b.id).run();
    return { resolved: path, took: take === 'main' ? 'main' : 'branch', conflicts_left: rest };
  });
}

/** After uploads to a branch: a conflicted text file uploaded without markers counts as resolved. */
export async function autoResolve(env: Env, b: Branch | null, paths: string[], ws: string): Promise<string[]> {
  if (!b) return [];
  const list = parseJson<string[]>(b.conflicts, []), hit = paths.filter((x) => list.includes(x));
  if (!hit.length) return [];
  const done: string[] = [];
  for (const path of hit) {
    if (!isText(path)) continue;
    const txt = await readText(env, wsKey(ws, path));
    if (txt !== null && !hasConflictMarkers(txt)) done.push(path);
  }
  if (done.length) {
    // re-read inside the statement's own row so two uploads resolving different files keep both
    const cur = parseJson<string[]>((await env.DB.prepare('SELECT conflicts FROM branches WHERE id = ?').bind(b.id).first<{ conflicts: string }>())?.conflicts, []);
    await env.DB.prepare('UPDATE branches SET conflicts = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(cur.filter((x) => !done.includes(x))), now(), b.id).run();
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// Change requests
// ---------------------------------------------------------------------------------------------
export async function getChange(env: Env, p: Project, number: unknown): Promise<Change> {
  const n = Number(number);
  const c = Number.isInteger(n) && n > 0 ? await env.DB.prepare('SELECT * FROM change_requests WHERE project_id = ? AND number = ?').bind(p.id, n).first<Change>() : null;
  if (!c) throw notFound(`No change request #${number} in this project.`, 'change_requests {project, action: "list"} lists them.');
  return c;
}

export async function openChange(env: Env, user: User, role: Role, p: Project, branch: string, title: unknown, body: unknown, via = 'console') {
  assertCan(role, 'open_change', 'opening a change request');
  const b = await getBranch(env, p, branch);
  const t = String(title ?? '').trim().slice(0, LIMITS.title);
  if (t.length < 3) throw bad('Give the change request a title (3 to 120 characters) saying what it changes.');
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM change_requests WHERE project_id = ? AND status IN ('open','merging')").bind(p.id).first<{ n: number }>();
  if ((open?.n || 0) >= LIMITS.open_changes) throw forbidden(`This project has ${LIMITS.open_changes} open change requests. Merge or close some first.`);
  // refused before a number is taken, so a second request for the same branch leaves no gap in the numbers
  const already = await env.DB.prepare("SELECT number FROM change_requests WHERE branch_id = ? AND status IN ('open','merging')").bind(b.id).first<{ number: number }>();
  if (already) throw new AppError(409, `Branch ${b.name} already has an open change request (#${already.number}).`, 'change_exists', 'Deploying the branch again updates that change request; there is no need for a second one.');
  const got = await env.DB.prepare('UPDATE projects SET next_change = next_change + 1 WHERE id = ? RETURNING next_change').bind(p.id).first<{ next_change: number }>();
  const number = got!.next_change - 1, id = 'cr_' + rid(12), ts = now();
  try {
    await env.DB.prepare("INSERT INTO change_requests (id, project_id, number, branch_id, title, body, author_id, actor, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .bind(id, p.id, number, b.id, t, String(body ?? '').slice(0, LIMITS.body), user.id, via.slice(0, 80), ts, ts).run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error).message))) {
      const cur = await env.DB.prepare("SELECT number FROM change_requests WHERE branch_id = ? AND status IN ('open','merging')").bind(b.id).first<{ number: number }>();
      throw new AppError(409, `Branch ${b.name} already has an open change request${cur ? ` (#${cur.number})` : ''}.`, 'change_exists', 'Deploying the branch again updates that change request; there is no need for a second one.');
    }
    throw e;
  }
  await logEvent(env, p.id, 'change_opened', `#${number} ${t} (${b.name})`, b.head_version, via);
  return changeDetail(env, p, user, role, number);
}

async function reviewsOf(env: Env, changeId: string) {
  return (await env.DB.prepare('SELECT r.*, u.name FROM change_reviews r JOIN users u ON u.id = r.user_id WHERE r.change_id = ? ORDER BY r.created_at LIMIT ?').bind(changeId, LIMITS.reviews_per_change).all<any>()).results;
}

/** How many people other than the author could approve: the effective approvals needed never exceed it. */
async function reviewersFor(env: Env, p: Project, authorId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND user_id != ? AND role IN ('write','maintain','admin')").bind(p.id, authorId).first<{ n: number }>();
  return (r?.n || 0) + (p.owner_id !== authorId ? 1 : 0);
}

export async function mergeStateOf(env: Env, p: Project, c: Change) {
  const s = await getSettings(env);
  const b = await env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(c.branch_id).first<Branch>();
  const headV = b?.head_version ? await getVersion(env, p.id, b.head_version) : null;
  const reviews = await reviewsOf(env, c.id);
  const head = await mainHead(env, p.id);
  const behind = b ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND branch IS NULL AND n > ?').bind(p.id, b.base_version ?? 0).first<{ n: number }>())!.n : 0;
  let wsAhead = false;
  if (b && b.status === 'open' && headV) {
    const files = (await listFiles(env, branchWs(p.id, b.id))).map((f) => ({ path: f.path, size: f.size, sha: f.sha }));
    wsAhead = !isSame(diffFiles(versionFiles(headV), files));
  }
  const prot0 = protectionOf(p), reviewers = await reviewersFor(env, p, c.author_id);
  const prot = { ...prot0, required_approvals: Math.min(prot0.required_approvals, reviewers) };
  const state = {
    status: (c.status === 'merging' ? 'open' : c.status) as 'open' | 'merged' | 'closed', author_id: c.author_id,
    head: b?.status === 'open' ? (b.head_version ?? null) : null, head_status: headV?.status ?? null,
    head_eligible: headV ? versionEligible(headV, s.verify_browser_required).ok : false,
    workspace_ahead: wsAhead, behind, conflicts: b ? parseJson<string[]>(b.conflicts, []) : [],
    reviews: reviews.map((r) => ({ user_id: r.user_id, verdict: r.verdict as Verdict, version: r.version, created_at: r.created_at, dismissed: r.dismissed })) as ReviewLite[],
  };
  const m = mergeability(state, prot);
  if (b?.status !== 'open' && c.status === 'open') m.blockers.unshift({ id: 'branch_gone', text: 'The branch was deleted.', bypass: false }), m.mergeable = false, m.bypassable = false;
  if (prot.required_approvals < prot0.required_approvals) m.warnings.push(`main asks for ${prot0.required_approvals} approval(s), but only ${reviewers} person(s) besides the author can review, so ${prot.required_approvals} ${prot.required_approvals === 1 ? 'is' : 'are'} needed.`);
  return { b, headV, reviews, head, m, prot };
}

export async function changeDetail(env: Env, p: Project, viewer: User, role: Role, number: unknown) {
  const c = await getChange(env, p, number);
  const { b, headV, reviews, head, m, prot } = await mergeStateOf(env, p, c);
  const author = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(c.author_id).first<{ name: string }>();
  // what the branch changes: its merge base against its newest version, as GitHub's "Files changed"
  const baseV = b?.base_version ? await getVersion(env, p.id, b.base_version) : null;
  const changes = headV ? diffFiles(versionFiles(baseV), versionFiles(headV)) : null;
  // a dry run of the merge, so conflicts show before anyone presses merge
  let preview: { clean: boolean; conflicts: { path: string; kind: string }[] } | null = null;
  if (c.status === 'open' && headV && b) preview = await previewMerge(env, p, b, headV, head);
  return {
    number: c.number, title: c.title, body: c.body, status: c.status, author: author?.name || c.author_id, author_id: c.author_id, opened_via: c.actor,
    branch: b?.name ?? null, branch_deleted: b?.status !== 'open', merge_base: b?.base_version ?? null, head_version: b?.head_version ?? null, head_status: headV?.status ?? null,
    main_head: head || null, created_at: c.created_at, updated_at: c.updated_at,
    ...(c.status === 'merged' ? { merged_version: c.merged_version, merged_head: c.merged_head, merged_at: c.closed_at } : {}),
    files_changed: changes ? { summary: diffLine(changes), added: changes.added.map((f) => f.path), changed: changes.changed.map((f) => f.path), removed: changes.removed.map((f) => f.path) } : null,
    merge_preview: preview,
    mergeable: m.mergeable && (!preview || preview.clean), blockers: [...m.blockers, ...(preview && !preview.clean ? [{ id: 'merge_conflicts', text: `Merging now would conflict in ${preview.conflicts.map((x) => x.path).join(', ')}. Bring main into the branch (branches {action: "update"}), resolve, deploy the branch again.`, bypass: false }] : [])],
    bypassable: m.bypassable && (!preview || preview.clean) && atLeast(role, 'admin'),
    approvals: m.approvals.length, required_approvals: prot.required_approvals, changes_requested: m.changes_requested.length, warnings: m.warnings,
    reviews: reviews.map((r) => ({ id: r.id, by: r.name, user_id: r.user_id, verdict: r.verdict, body: r.body, version: r.version, path: r.path, line: r.line, dismissed: !!r.dismissed, via: r.actor, created_at: r.created_at,
      ...(r.verdict === 'approve' && prot.dismiss_stale && r.version !== (b?.head_version ?? null) ? { stale: true } : {}) })),
    you: { role, may_review: can(role, 'review') && viewer.id !== c.author_id, may_merge: can(role, 'merge'), is_author: viewer.id === c.author_id },
  };
}

/** The merge as it would go now, without writing anything: which files would conflict. */
async function previewMerge(env: Env, p: Project, b: Branch, headV: Version, head: number) {
  const baseV = b.base_version ? await getVersion(env, p.id, b.base_version) : null, mainV = head ? await getVersion(env, p.id, head) : null;
  const tm = mergeTrees(versionFiles(baseV), versionFiles(mainV), versionFiles(headV));
  const conflicts: { path: string; kind: string }[] = tm.conflicts.map((x) => ({ path: x.path, kind: x.kind }));
  for (const x of tm.both) {
    const textual = isText(x.path) && x.ours.size <= LIMITS.merge_text_bytes && x.theirs.size <= LIMITS.merge_text_bytes;
    if (!textual) { conflicts.push({ path: x.path, kind: 'binary_both_changed' }); continue; }
    const [bt, ot, tt] = await Promise.all([x.base ? readText(env, verKey(p.id, b.base_version!, x.path)) : '', readText(env, verKey(p.id, head, x.path)), readText(env, verKey(p.id, headV.n, x.path))]);
    const m = ot !== null && tt !== null ? merge3Text(bt ?? '', ot, tt) : null;
    if (!m || m.conflicts) conflicts.push({ path: x.path, kind: m ? 'lines' : 'too_big' });
  }
  return { clean: conflicts.length === 0, conflicts };
}

export async function listChanges(env: Env, p: Project, status: unknown) {
  const st = status === 'closed' || status === 'merged' || status === 'all' ? status : 'open';
  const where = st === 'all' ? '' : st === 'open' ? " AND c.status IN ('open','merging')" : ' AND c.status = ?';
  const rows = await env.DB.prepare(`SELECT c.number, c.title, c.status, c.created_at, c.updated_at, c.merged_version, u.name AS author, b.name AS branch, b.head_version,
      (SELECT COUNT(*) FROM change_reviews r WHERE r.change_id = c.id AND r.verdict = 'approve' AND r.dismissed = 0) AS approvals
    FROM change_requests c JOIN users u ON u.id = c.author_id LEFT JOIN branches b ON b.id = c.branch_id WHERE c.project_id = ?${where} ORDER BY c.number DESC LIMIT 100`)
    .bind(...(st === 'closed' || st === 'merged' ? [p.id, st] : [p.id])).all<any>();
  return rows.results;
}

export async function review(env: Env, user: User, role: Role, p: Project, number: unknown, verdict: unknown, body: unknown, path?: unknown, line?: unknown, via = 'console') {
  const v = verdict === 'approve' || verdict === 'request_changes' || verdict === 'comment' ? verdict : null;
  if (!v) throw bad('verdict is "approve", "request_changes" or "comment".');
  assertCan(role, v === 'comment' ? 'comment' : 'review', v === 'comment' ? 'commenting' : 'reviewing');
  const c = await getChange(env, p, number);
  if (c.status !== 'open') throw new AppError(409, `#${c.number} is ${c.status}.`, 'change_closed');
  if (v !== 'comment' && c.author_id === user.id) throw forbidden('You opened this change request, so your own approval or request for changes does not count. Ask another collaborator to review it, or comment instead.');
  const text = String(body ?? '').slice(0, v === 'comment' ? LIMITS.comment : LIMITS.body);
  if (v !== 'approve' && !text.trim()) throw bad(v === 'comment' ? 'A comment needs text.' : 'Say what needs to change.');
  const b = await env.DB.prepare('SELECT head_version FROM branches WHERE id = ?').bind(c.branch_id).first<{ head_version: number | null }>();
  if (v === 'approve' && !b?.head_version) throw bad('The branch has no deployed version to approve yet.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM change_reviews WHERE change_id = ?').bind(c.id).first<{ n: number }>();
  if ((count?.n || 0) >= LIMITS.reviews_per_change) throw forbidden('This change request has as many reviews and comments as it can hold.');
  const p2 = typeof path === 'string' && path ? path.slice(0, 300) : null, l2 = Number.isInteger(line) ? Number(line) : null;
  const id = 'rv_' + rid(12), t = now();
  await env.DB.prepare('INSERT INTO change_reviews (id, change_id, project_id, user_id, actor, verdict, body, version, path, line, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, c.id, p.id, user.id, via.slice(0, 80), v, text, b?.head_version ?? null, p2, l2, t).run();
  await env.DB.prepare('UPDATE change_requests SET updated_at = ? WHERE id = ?').bind(t, c.id).run();
  await logEvent(env, p.id, `change_${v}`, `#${c.number} ${user.name}${text ? `: ${text.slice(0, 120)}` : ''}`, b?.head_version ?? null, via);
  return { review: id, verdict: v, version: b?.head_version ?? null, change: await changeDetail(env, p, user, role, c.number) };
}

export async function dismissReview(env: Env, user: User, role: Role, p: Project, number: unknown, reviewId: unknown) {
  assertCan(role, 'manage_changes', 'dismissing a review');
  const c = await getChange(env, p, number);
  const r = await env.DB.prepare('UPDATE change_reviews SET dismissed = 1, dismissed_by = ? WHERE id = ? AND change_id = ? AND dismissed = 0').bind(user.id, String(reviewId), c.id).run();
  if (!r.meta.changes) throw notFound('No such review on this change request (or it was already dismissed).');
  return { dismissed: reviewId };
}

export async function setChangeStatus(env: Env, user: User, role: Role, p: Project, number: unknown, to: 'closed' | 'open', via = 'console') {
  const c = await getChange(env, p, number);
  if (c.author_id !== user.id) assertCan(role, 'manage_changes', `${to === 'closed' ? 'closing' : 'reopening'} someone else's change request`);
  const t = now();
  if (to === 'closed') {
    const r = await env.DB.prepare("UPDATE change_requests SET status = 'closed', closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").bind(user.id, t, t, c.id).run();
    if (!r.meta.changes) throw new AppError(409, `#${c.number} is ${c.status}.`, 'change_closed');
  } else {
    const b = await env.DB.prepare('SELECT status FROM branches WHERE id = ?').bind(c.branch_id).first<{ status: string }>();
    if (b?.status !== 'open') throw new AppError(409, 'Its branch was deleted, so it cannot be reopened.', 'branch_gone');
    try {
      const r = await env.DB.prepare("UPDATE change_requests SET status = 'open', closed_by = NULL, closed_at = NULL, updated_at = ? WHERE id = ? AND status = 'closed'").bind(t, c.id).run();
      if (!r.meta.changes) throw new AppError(409, `#${c.number} is ${c.status}.`, 'change_closed');
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String((e as Error).message))) throw new AppError(409, 'The branch has another open change request.', 'change_exists');
      throw e;
    }
  }
  await logEvent(env, p.id, to === 'closed' ? 'change_closed' : 'change_reopened', `#${c.number} by ${user.name}`, null, via);
  return changeDetail(env, p, user, role, c.number);
}

const CLAIM_STALE_MS = 5 * 60_000;

/**
 * Merges a change request: a three-way merge of main's newest version and the branch's newest version against their
 * merge base, frozen as a new main version and verified like any deploy. Refused (nothing written) when a requirement
 * is not met (unless an admin bypasses the ones that may be), when any file conflicts, or when the merged files fail the
 * static checks. `enqueue` starts the merged version's deploy and verification (src/pipeline.ts).
 */
export async function mergeChange(env: Env, user: User, role: Role, p: Project, number: unknown, opts: { bypass?: boolean; delete_branch?: boolean; via?: string; origin: string; enqueue: (n: number) => Promise<void> }) {
  assertCan(role, 'merge', 'merging into main');
  const via = opts.via || 'console';
  const c0 = await getChange(env, p, number);
  // one merge per change request: claim it (a claim left by a crashed merge lapses after 5 minutes)
  const t0 = now();
  const claim = await env.DB.prepare("UPDATE change_requests SET status = 'merging', updated_at = ? WHERE id = ? AND (status = 'open' OR (status = 'merging' AND updated_at < ?))").bind(t0, c0.id, t0 - CLAIM_STALE_MS).run();
  if (!claim.meta.changes) {
    const cur = await getChange(env, p, number);
    throw new AppError(409, cur.status === 'merging' ? `#${cur.number} is being merged right now by someone else.` : `#${cur.number} is ${cur.status}${cur.status === 'merged' ? ` (as version ${cur.merged_version})` : ''}.`, 'change_closed');
  }
  const release = () => env.DB.prepare("UPDATE change_requests SET status = 'open', updated_at = ? WHERE id = ? AND status = 'merging'").bind(now(), c0.id).run();
  const scratch = branchWs(p.id, 'merge-' + rid(8));
  try {
    const c = { ...c0, status: 'open' as const };
    const { b, headV, head, m } = await mergeStateOf(env, p, c);
    let bypassed: string[] = [];
    if (!m.mergeable) {
      const canBypass = opts.bypass === true && m.bypassable && atLeast(role, 'admin');
      if (!canBypass) {
        throw new AppError(409, `#${c.number} cannot be merged yet: ${m.blockers.map((x) => x.text).join(' ')}`, 'not_mergeable',
          m.bypassable && atLeast(role, 'admin') ? 'As an admin you may merge anyway with bypass: true; it is recorded.' : 'change_requests {action: "get", number} shows what it needs.');
      }
      bypassed = m.blockers.map((x) => x.id);
    }
    if (!b || !headV) throw new AppError(409, 'The branch has no version to merge.', 'not_mergeable');
    // the three-way merge: main's newest (ours) and the branch's newest (theirs) against the merge base
    const baseV = b.base_version ? await getVersion(env, p.id, b.base_version) : null, mainV = head ? await getVersion(env, p.id, head) : null;
    const tm = mergeTrees(versionFiles(baseV), versionFiles(mainV), versionFiles(headV));
    const texts = new Map<string, string>(), conflicts: { path: string; kind: string }[] = tm.conflicts.map((x) => ({ path: x.path, kind: x.kind }));
    for (const x of tm.both) {
      const textual = isText(x.path) && x.ours.size <= LIMITS.merge_text_bytes && x.theirs.size <= LIMITS.merge_text_bytes;
      if (!textual) { conflicts.push({ path: x.path, kind: 'binary_both_changed' }); continue; }
      const [bt, ot, tt] = await Promise.all([x.base ? readText(env, verKey(p.id, b.base_version!, x.path)) : '', readText(env, verKey(p.id, head, x.path)), readText(env, verKey(p.id, headV.n, x.path))]);
      const mm = ot !== null && tt !== null ? merge3Text(bt ?? '', ot, tt) : null;
      if (!mm || mm.conflicts) conflicts.push({ path: x.path, kind: mm ? 'lines' : 'too_big' }); else texts.set(x.path, mm.text);
    }
    if (conflicts.length) {
      throw new AppError(409, `Merging #${c.number} conflicts with main in ${conflicts.length} file(s): ${conflicts.map((x) => `${x.path} (${x.kind.replace(/_/g, ' ')})`).join(', ')}. Nothing was merged.`, 'merge_conflict',
        `Bring main into the branch: branches {project, action: "update", name: "${b.name}"}. It writes both sides of each conflict into the file with markers; fix them, upload, deploy_preview {branch: "${b.name}"}, then merge again.`);
    }
    // build the merged files in a scratch workspace, check them as a deploy would, and freeze them as a main version
    const s = await getSettings(env);
    const picks = tm.picks.filter((x) => x.from !== 'deleted') as { path: string; from: 'ours' | 'theirs'; sig: FileSig }[];
    assertFits(s, p, [], [...picks.map((x) => ({ path: x.path, size: x.sig.size })), ...[...texts].map(([path, t]) => ({ path, size: new TextEncoder().encode(t).byteLength }))]);
    const v = await withLock(env, scratch, async (renew) => {
      for (const pk of picks) await copyObjects(env, [pk.sig], (path) => verKey(p.id, pk.from === 'ours' ? head : headV.n, path), scratch, renew);
      for (const [path, t] of texts) await putFile(env, p, path, new TextEncoder().encode(t), true, scratch);
      const check = await checkProject(env, p, opts.origin, scratch);
      if (!check.ok) throw new AppError(409, `The merged files fail the static checks, so nothing was merged: ${check.errors.slice(0, 5).map((e) => `${e.file ? `${e.file}: ` : ''}${e.message}`).join(' · ')}`, 'merge_checks', 'Bring main into the branch (branches {action: "update"}), fix it there, deploy the branch, then merge again.');
      const note = `Merge #${c.number}: ${c.title}`.slice(0, 300);
      return snapshot(env, p, check.manifest, note, { ws: scratch, branch: null, expectNewest: head, base: head || null, actor: `${user.name} via ${via}`.slice(0, 120), change: c.number, keepWsBase: true });
    });
    if (!v) throw new AppError(409, 'main changed while this merge was being made (another merge or deploy landed first), so nothing was merged.', 'main_moved', 'Call merge again: it merges onto the new main.');
    const t = now();
    await env.DB.prepare("UPDATE change_requests SET status = 'merged', merged_version = ?, merged_head = ?, merged_by = ?, closed_at = ?, updated_at = ? WHERE id = ?").bind(v.n, headV.n, user.id, t, t, c.id).run();
    await logEvent(env, p.id, 'change_merged', `#${c.number} ${c.title} → version ${v.n}${bypassed.length ? ` (bypassed: ${bypassed.join(', ')})` : ''}`, v.n, via);
    await opts.enqueue(v.n);
    // main's workspace follows when nobody had undeployed work in it; the branch follows when its workspace is its head
    const mainWs = await followMerge(env, p, p.id, head, v.n, async () => { await env.DB.prepare('UPDATE projects SET ws_base = ? WHERE id = ?').bind(v.n, p.id).run(); });
    let branchAfter: string;
    if (opts.delete_branch) { await deleteBranch(env, user, role, p, b.name, via).catch(() => {}); branchAfter = 'deleted'; }
    else {
      const followed = await followMerge(env, p, branchWs(p.id, b.id), headV.n, v.n, async () => { await env.DB.prepare('UPDATE branches SET base_version = ?, ws_base = ?, updated_at = ? WHERE id = ?').bind(v.n, v.n, now(), b.id).run(); });
      branchAfter = followed ? `now at version ${v.n} (main), ready for more work` : 'kept as it is: its workspace has changes not in the merged version';
    }
    return {
      merged: true, number: c.number, version: v.n, merge_base: b.base_version, main_was: head || null, branch_version: headV.n,
      ...(bypassed.length ? { bypassed } : {}),
      main_workspace: mainWs ? `now version ${v.n}` : 'left as it was: it has changes not deployed yet (diff_versions shows them)',
      branch: branchAfter,
      next: `Version ${v.n} is being deployed to the preview and verified. list_versions {project, version: ${v.n}} waits for its report; publish {version: ${v.n}} makes it live.`,
    };
  } catch (e) {
    await release();
    throw e;
  } finally {
    await dropWorkspace(env, scratch).catch(() => {});
  }
}

/** Moves a workspace to the merged version when it was exactly `expect` (no undeployed work), under its lease. */
async function followMerge(env: Env, p: Project, ws: string, expect: number, to: number, mark: () => Promise<void>): Promise<boolean> {
  try {
    return await withLock(env, ws, async (renew) => {
      const files = (await listFiles(env, ws)).map((f) => ({ path: f.path, size: f.size, sha: f.sha }));
      const at = expect ? await getVersion(env, p.id, expect) : null;
      if (!at || !isSame(diffFiles(versionFiles(at), files))) return false;
      const target = versionFiles(await getVersion(env, p.id, to)), d = diffFiles(files, target);
      await copyObjects(env, [...d.added, ...d.changed].map((f) => target.find((x) => x.path === f.path)!), (path) => verKey(p.id, to, path), ws, renew);
      for (const f of d.removed) await dropFile(env, ws, f.path);
      await mark();
      return true;
    }, 5000);
  } catch { return false; }
}

export async function setProtection(env: Env, user: User, role: Role, p: Project, input: Record<string, unknown>, via = 'console') {
  assertCan(role, 'protection', 'changing main\'s protection');
  const r = updateProtection(protectionOf(p), input);
  if (!r.ok) throw bad(r.error);
  await env.DB.prepare('UPDATE projects SET protection = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(r.value), now(), p.id).run();
  await logEvent(env, p.id, 'protection', `${user.name} set main's protection: ${JSON.stringify(r.value)}`, null, via);
  return { protection: r.value };
}

export type { Mergeability };
