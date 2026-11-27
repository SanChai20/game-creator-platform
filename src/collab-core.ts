// Multi-developer, multi-agent collaboration on one game: the rules, with no imports, so tests/collab.mjs loads this file
// as it is. Modelled on how GitHub runs a repository (docs/collaboration.md has the design and the references):
//   - people:   the owner plus collaborators with a role (read, write, maintain, admin), invited and accepting;
//   - branches: main is the game's own workspace and version line; every other branch is a working copy of its own,
//               forked from a main version (its merge base), deployed as versions of its own;
//   - change requests (pull requests): a branch's newest version proposed for main, reviewed (approve, request changes,
//               comment), and merged by a three-way merge into a new main version, which is verified like any deploy;
//   - protection: how many approvals main needs, whether the proposed version must have passed verification, and who may
//               change main directly.
// The storage side (D1, R2, locks, the merge itself) is src/collab.ts.

// ---------------------------------------------------------------------------------------------
// Roles and what each may do
// ---------------------------------------------------------------------------------------------
export type Role = 'read' | 'write' | 'maintain' | 'admin' | 'owner';
/** Roles a collaborator can be given (the owner is the project's owner_id, never a membership). */
export const MEMBER_ROLES = ['read', 'write', 'maintain', 'admin'] as const;
export type MemberRole = typeof MEMBER_ROLES[number];
const RANK: Record<Role, number> = { read: 1, write: 2, maintain: 3, admin: 4, owner: 5 };
export const isMemberRole = (r: unknown): r is MemberRole => typeof r === 'string' && (MEMBER_ROLES as readonly string[]).includes(r);
export const atLeast = (have: Role | null | undefined, need: Role) => !!have && RANK[have] >= RANK[need];

export type Action =
  | 'view' | 'comment'
  | 'push_branch' | 'deploy_branch' | 'open_change' | 'review'
  | 'push_main' | 'merge' | 'manage_branches' | 'edit_listing' | 'manage_changes' | 'game_data'
  | 'manage_members' | 'protection' | 'publish'
  | 'pricing' | 'delete_project' | 'grant_admin' | 'earnings';

/** The least role for each action, as GitHub's Read, Write, Maintain and Admin; the money and the project itself stay the owner's. */
export const PERMS: Record<Action, Role> = {
  view: 'read', comment: 'read',
  push_branch: 'write', deploy_branch: 'write', open_change: 'write', review: 'write',
  push_main: 'maintain', merge: 'maintain', manage_branches: 'maintain', edit_listing: 'maintain', manage_changes: 'maintain', game_data: 'maintain',
  manage_members: 'admin', protection: 'admin', publish: 'admin',
  pricing: 'owner', delete_project: 'owner', grant_admin: 'owner', earnings: 'owner',
};
export const can = (role: Role | null | undefined, action: Action) => atLeast(role, PERMS[action]);

export const ROLE_TEXT: Record<Role, string> = {
  read: 'Read: sees the project, its versions, branches and change requests, downloads files and comments.',
  write: 'Write: also works on branches (upload, deploy previews), opens change requests and reviews them.',
  maintain: 'Maintain: also changes main directly (when protection allows), merges change requests, manages branches and edits the store listing.',
  admin: 'Admin: also invites and removes collaborators (up to maintain), sets main\'s protection, and publishes, rolls back and unpublishes.',
  owner: 'Owner: everything, including prices, sales, earnings, admins and deleting the game.',
};

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------
export const LIMITS = {
  members: 25,            // collaborators per project, the owner not counted
  pending_invites: 50,    // open invitations per project
  invite_days: 7,         // an invitation expires after a week, as on GitHub
  branches: 30,           // open branches per project, main not counted
  branches_per_user: 10,
  open_changes: 50,       // open change requests per project
  body: 8000,             // characters in a change request or review body
  comment: 4000,
  title: 120,
  reviews_per_change: 400,
  merge_text_bytes: 2_000_000,   // larger text files are merged whole (a conflict when both sides changed them)
};

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------
const RESERVED = new Set(['main', 'head', 'workspace', 'live', 'preview', 'master', 'origin']);
/** A branch name: lowercase letters, digits, and . _ - /, 2 to 48 characters, starting and ending with a letter or digit. */
export function branchName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = String(raw ?? '').trim().toLowerCase();
  if (name.length < 2 || name.length > 48) return { ok: false, error: 'A branch name is 2 to 48 characters.' };
  if (!/^[a-z0-9][a-z0-9._/-]*[a-z0-9]$/.test(name)) return { ok: false, error: `"${name}" is not a branch name: use lowercase letters, digits and . _ - /, starting and ending with a letter or digit (e.g. "boss-fight" or "anna/menus").` };
  if (/\/\/|\.\.|\/\.|\.\/|\.lock$/.test(name)) return { ok: false, error: `"${name}" is not a branch name: no "..", "//", a "." next to "/" or ".lock" at the end.` };
  if (RESERVED.has(name)) return { ok: false, error: `"${name}" is reserved${name === 'main' ? ': main is the game itself' : ''}. Pick another name.` };
  return { ok: true, name };
}

export const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
export const looksLikeEmail = (e: string) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

// ---------------------------------------------------------------------------------------------
// Main's protection
// ---------------------------------------------------------------------------------------------
export interface Protection {
  required_approvals: number;      // approvals from someone other than the author on the change's current version (0 to 5)
  require_verified: boolean;       // the proposed version must have passed verification
  dismiss_stale: boolean;          // an approval counts only for the version it reviewed
  main_writers: 'maintain' | 'admin' | 'owner';   // who may upload to main and deploy it directly
  allow_bypass: boolean;           // admins (and the owner) may merge without the approvals or verification, logged
}
export const DEFAULT_PROTECTION: Protection = { required_approvals: 1, require_verified: true, dismiss_stale: true, main_writers: 'maintain', allow_bypass: true };

export function parseProtection(raw: unknown): Protection {
  let o: any = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { o = null; } }
  if (!o || typeof o !== 'object') return { ...DEFAULT_PROTECTION };
  return {
    required_approvals: Number.isInteger(o.required_approvals) ? Math.max(0, Math.min(5, o.required_approvals)) : DEFAULT_PROTECTION.required_approvals,
    require_verified: typeof o.require_verified === 'boolean' ? o.require_verified : DEFAULT_PROTECTION.require_verified,
    dismiss_stale: typeof o.dismiss_stale === 'boolean' ? o.dismiss_stale : DEFAULT_PROTECTION.dismiss_stale,
    main_writers: ['maintain', 'admin', 'owner'].includes(o.main_writers) ? o.main_writers : DEFAULT_PROTECTION.main_writers,
    allow_bypass: typeof o.allow_bypass === 'boolean' ? o.allow_bypass : DEFAULT_PROTECTION.allow_bypass,
  };
}

/** Changes an admin asked for, checked: unknown keys and wrong types are refused rather than ignored. */
export function updateProtection(cur: Protection, input: Record<string, unknown>): { ok: true; value: Protection } | { ok: false; error: string } {
  const next = { ...cur };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (k === 'required_approvals') { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 5) return { ok: false, error: 'required_approvals is a whole number from 0 to 5.' }; next.required_approvals = v as number; }
    else if (k === 'require_verified' || k === 'dismiss_stale' || k === 'allow_bypass') { if (typeof v !== 'boolean') return { ok: false, error: `${k} is true or false.` }; (next as any)[k] = v; }
    else if (k === 'main_writers') { if (!['maintain', 'admin', 'owner'].includes(v as string)) return { ok: false, error: 'main_writers is "maintain", "admin" or "owner".' }; next.main_writers = v as Protection['main_writers']; }
    else return { ok: false, error: `Unknown protection setting "${k}". Settings: required_approvals, require_verified, dismiss_stale, main_writers, allow_bypass.` };
  }
  return { ok: true, value: next };
}

/** Whether this role may write main's workspace directly. A project nobody else works on is never protected for its owner. */
export function mayPushMain(role: Role | null | undefined, prot: Protection): boolean {
  if (role === 'owner') return true;
  return atLeast(role, prot.main_writers) && atLeast(role, 'maintain');
}

// ---------------------------------------------------------------------------------------------
// Reviews and whether a change request can be merged
// ---------------------------------------------------------------------------------------------
export type Verdict = 'approve' | 'request_changes' | 'comment';
export interface ReviewLite { user_id: string; verdict: Verdict; version: number | null; created_at: number; dismissed?: number | boolean }
export interface MergeState {
  status: 'open' | 'merged' | 'closed';
  author_id: string;
  head: number | null;               // the branch's newest version
  head_status: string | null;        // that version's status (verified, failed, queued…)
  head_eligible: boolean;            // it passed verification (or qualified otherwise)
  workspace_ahead: boolean;          // the branch workspace has changes not deployed yet (a warning, never a blocker)
  behind: number;                    // main versions since the branch's merge base
  conflicts: string[];               // unresolved conflicts recorded on the branch
  reviews: ReviewLite[];
}
export interface Mergeability {
  mergeable: boolean;                // every requirement met
  bypassable: boolean;               // only requirements an admin may bypass are unmet
  blockers: { id: string; text: string; bypass: boolean }[];
  approvals: string[];               // user ids whose approval counts now
  changes_requested: string[];       // user ids whose latest review requests changes
  warnings: string[];
}

/** The latest review of each reviewer that is not a plain comment, as GitHub counts them. */
export function latestVerdicts(reviews: ReviewLite[]): Map<string, ReviewLite> {
  const out = new Map<string, ReviewLite>();
  for (const r of [...reviews].sort((a, b) => a.created_at - b.created_at)) {
    if (r.verdict === 'comment' || r.dismissed) continue;
    out.set(r.user_id, r);
  }
  return out;
}

export function mergeability(m: MergeState, prot: Protection): Mergeability {
  const blockers: Mergeability['blockers'] = [], warnings: string[] = [];
  const latest = latestVerdicts(m.reviews);
  const approvals: string[] = [], changes: string[] = [];
  for (const [uid, r] of latest) {
    if (uid === m.author_id) continue;      // an author's own review never counts
    if (r.verdict === 'request_changes') changes.push(uid);
    else if (r.verdict === 'approve' && (!prot.dismiss_stale || r.version === m.head)) approvals.push(uid);
  }
  if (m.status !== 'open') blockers.push({ id: 'not_open', text: `This change request is ${m.status}.`, bypass: false });
  if (m.head === null) blockers.push({ id: 'no_version', text: 'The branch has no deployed version yet: deploy_preview {branch} makes one.', bypass: false });
  if (m.conflicts.length) blockers.push({ id: 'conflicts', text: `The branch has ${m.conflicts.length} unresolved conflict(s): ${m.conflicts.slice(0, 6).join(', ')}${m.conflicts.length > 6 ? ', …' : ''}. Fix the files, deploy the branch again.`, bypass: false });
  if (m.head !== null && prot.require_verified && !m.head_eligible) {
    const st = m.head_status || 'unknown';
    blockers.push({ id: 'verification', text: /queued|deploying|verifying/.test(st) ? `Version ${m.head} is still ${st}.` : `Version ${m.head} has not passed verification.`, bypass: !/queued|deploying|verifying/.test(st) });
  }
  if (changes.length) blockers.push({ id: 'changes_requested', text: `${changes.length} reviewer(s) asked for changes. They approve after the fix, or an admin dismisses the review.`, bypass: true });
  if (approvals.length < prot.required_approvals) blockers.push({ id: 'approvals', text: `Needs ${prot.required_approvals} approval(s) of version ${m.head ?? '?'} from someone other than the author; has ${approvals.length}.`, bypass: true });
  if (m.workspace_ahead) warnings.push('The branch workspace has changes that are not deployed: they are not part of this change request until deploy_preview {branch} makes a new version.');
  if (m.behind > 0) warnings.push(`main has ${m.behind} version(s) the branch does not have yet. The merge combines them; a conflict is reported if both sides changed the same lines.`);
  return {
    mergeable: blockers.length === 0,
    bypassable: blockers.length > 0 && blockers.every((b) => b.bypass) && prot.allow_bypass,
    blockers, approvals, changes_requested: changes, warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Three-way merge of file lists
// ---------------------------------------------------------------------------------------------
export interface Sig { path: string; size: number; sha: string }
export type Pick = { path: string; from: 'ours' | 'theirs'; sig: Sig } | { path: string; from: 'deleted' };
export type ConflictKind = 'both_changed' | 'both_added' | 'changed_deleted' | 'deleted_changed';
export interface TreeMerge {
  picks: Pick[];                                   // decided without reading any file
  both: { path: string; kind: 'both_changed' | 'both_added'; base: Sig | null; ours: Sig; theirs: Sig }[];   // need a content merge
  conflicts: { path: string; kind: ConflictKind; ours: Sig | null; theirs: Sig | null }[];   // cannot be merged by content
}

/**
 * The tree-level three-way merge git does: for each path, compare main ("ours") and the branch ("theirs") with their
 * merge base. A path only one side changed takes that side; both changed it the same way, either; both changed it
 * differently, a content merge (text) or a conflict; one changed and the other deleted it, a conflict.
 */
export function mergeTrees(base: Sig[], ours: Sig[], theirs: Sig[]): TreeMerge {
  const B = new Map(base.map((f) => [f.path, f])), O = new Map(ours.map((f) => [f.path, f])), T = new Map(theirs.map((f) => [f.path, f]));
  const paths = [...new Set([...B.keys(), ...O.keys(), ...T.keys()])].sort();
  const out: TreeMerge = { picks: [], both: [], conflicts: [] };
  for (const path of paths) {
    const b = B.get(path) || null, o = O.get(path) || null, t = T.get(path) || null;
    const same = (x: Sig | null, y: Sig | null) => (x === null && y === null) || (!!x && !!y && x.sha === y.sha);
    if (same(o, t)) { if (o) out.picks.push({ path, from: 'ours', sig: o }); else if (b) out.picks.push({ path, from: 'deleted' }); continue; }
    if (same(b, o)) { if (t) out.picks.push({ path, from: 'theirs', sig: t }); else out.picks.push({ path, from: 'deleted' }); continue; }
    if (same(b, t)) { if (o) out.picks.push({ path, from: 'ours', sig: o }); else out.picks.push({ path, from: 'deleted' }); continue; }
    // both sides changed this path, differently
    if (o && t) out.both.push({ path, kind: b ? 'both_changed' : 'both_added', base: b, ours: o, theirs: t });
    else out.conflicts.push({ path, kind: o ? 'changed_deleted' : 'deleted_changed', ours: o, theirs: t });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Three-way merge of a text file (diff3)
// ---------------------------------------------------------------------------------------------
/** Edit script from a to b as hunks over a: [aStart, aEnd) is replaced by b[bStart, bEnd). Myers' O(ND) algorithm. */
export interface Hunk { a0: number; a1: number; b0: number; b1: number }
export function diffHunks(a: string[], b: string[], maxD = 20000): Hunk[] | null {
  // intern lines as numbers so the inner loop compares integers
  const ids = new Map<string, number>(), A = new Int32Array(a.length), Bv = new Int32Array(b.length);
  const id = (s: string) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  for (let i = 0; i < a.length; i++) A[i] = id(a[i]);
  for (let i = 0; i < b.length; i++) Bv[i] = id(b[i]);
  let s = 0; while (s < A.length && s < Bv.length && A[s] === Bv[s]) s++;
  let ea = A.length, eb = Bv.length; while (ea > s && eb > s && A[ea - 1] === Bv[eb - 1]) { ea--; eb--; }
  const N = ea - s, M = eb - s;
  if (N === 0 && M === 0) return [];
  if (N === 0 || M === 0) return [{ a0: s, a1: ea, b0: s, b1: eb }];
  const max = Math.min(N + M, maxD), off = max + 1;
  const V = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[s + x] === Bv[s + y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;   // too different to diff here
  // walk back: the matching diagonals become the common lines
  const common: [number, number][] = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const px = v[off + prevK], py = px - prevK;
    // the edit step lands on (sx, sy): down (an inserted line of b) or right (a deleted line of a); a snake runs from there
    const sx = prevK === k + 1 ? px : px + 1, sy = prevK === k + 1 ? py + 1 : py;
    while (x > sx && y > sy) { x--; y--; common.push([s + x, s + y]); }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; common.push([s + x, s + y]); }
  common.reverse();
  // hunks between the common lines
  const hunks: Hunk[] = [];
  let ia = s, ib = s;
  for (const [ca, cb] of common) {
    if (ca > ia || cb > ib) hunks.push({ a0: ia, a1: ca, b0: ib, b1: cb });
    ia = ca + 1; ib = cb + 1;
  }
  if (ea > ia || eb > ib) hunks.push({ a0: ia, a1: ea, b0: ib, b1: eb });
  return hunks;
}

/** Applies a side's hunks inside base[lo, hi) and returns that side's lines for the range. */
function sideRange(base: string[], side: string[], hunks: Hunk[], lo: number, hi: number): string[] {
  const out: string[] = [];
  let pos = lo;
  for (const h of hunks) {
    for (let i = pos; i < h.a0; i++) out.push(base[i]);
    for (let i = h.b0; i < h.b1; i++) out.push(side[i]);
    pos = h.a1;
  }
  for (let i = pos; i < hi; i++) out.push(base[i]);
  return out;
}

export interface TextMerge { text: string; conflicts: number; regions: { ours: string; theirs: string }[] }
const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * diff3: the changes main made and the changes the branch made, each against their merge base, are applied together.
 * Changes to separate lines merge cleanly; changes that overlap or touch the same lines conflict, unless both sides made
 * the very same change, and the conflict is written into the text with git's markers. null: too big or too different.
 */
export function merge3Text(base: string, ours: string, theirs: string, labels = { ours: 'main', theirs: 'branch' }): TextMerge | null {
  if (ours === theirs) return { text: ours, conflicts: 0, regions: [] };
  if (base === ours) return { text: theirs, conflicts: 0, regions: [] };
  if (base === theirs) return { text: ours, conflicts: 0, regions: [] };
  const O = base.split('\n'), A = ours.split('\n'), Bl = theirs.split('\n');
  const ha = diffHunks(O, A), hb = diffHunks(O, Bl);
  if (!ha || !hb) return null;
  type Tagged = Hunk & { side: 'a' | 'b' };
  const all: Tagged[] = [...ha.map((h) => ({ ...h, side: 'a' as const })), ...hb.map((h) => ({ ...h, side: 'b' as const }))]
    .sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
  const out: string[] = [], regions: TextMerge['regions'] = [];
  let pos = 0, i = 0, conflicts = 0;
  while (i < all.length) {
    // a group: hunks whose base ranges overlap or touch (git treats changes on adjacent lines as one conflict)
    let lo = all[i].a0, hi = all[i].a1;
    const group: Tagged[] = [all[i++]];
    // (one side's own hunks are always apart by a common line, so only the other side's can touch the group)
    while (i < all.length && all[i].a0 <= hi) {
      hi = Math.max(hi, all[i].a1); group.push(all[i++]);
    }
    for (let k = pos; k < lo; k++) out.push(O[k]);
    const ga = group.filter((g) => g.side === 'a'), gb = group.filter((g) => g.side === 'b');
    const ra = sideRange(O, A, ga, lo, hi), rb = sideRange(O, Bl, gb, lo, hi), ro = O.slice(lo, hi);
    if (!gb.length || eq(rb, ro)) out.push(...ra);
    else if (!ga.length || eq(ra, ro)) out.push(...rb);
    else if (eq(ra, rb)) out.push(...ra);
    else {
      // zealous, as git: lines both sides have at the start or end of the region stay outside the markers
      let pre = 0, suf = 0;
      while (pre < ra.length && pre < rb.length && ra[pre] === rb[pre]) pre++;
      while (suf < ra.length - pre && suf < rb.length - pre && ra[ra.length - 1 - suf] === rb[rb.length - 1 - suf]) suf++;
      const ca = ra.slice(pre, ra.length - suf), cb = rb.slice(pre, rb.length - suf);
      conflicts++;
      regions.push({ ours: ca.join('\n'), theirs: cb.join('\n') });
      out.push(...ra.slice(0, pre), `<<<<<<< ${labels.ours}`, ...ca, '=======', ...cb, `>>>>>>> ${labels.theirs}`, ...ra.slice(ra.length - suf));
    }
    pos = hi;
  }
  for (let k = pos; k < O.length; k++) out.push(O[k]);
  return { text: out.join('\n'), conflicts, regions };
}

/** True when a text still holds a conflict a merge wrote into it. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< [^\n]*\n[\s\S]*?^=======\r?\n[\s\S]*?^>>>>>>> /m.test(text);
}

// ---------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------
export interface InviteLite { status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'; expires_at: number }
export const inviteOpen = (i: InviteLite, t: number) => i.status === 'pending' && i.expires_at > t;

/** Who may give or take away a role: admins up to maintain, only the owner admin; nobody touches the owner or a higher role. */
export function mayManage(actor: Role | null | undefined, targetCurrent: Role | null, targetNew: Role | null): { ok: true } | { ok: false; error: string } {
  if (!atLeast(actor, 'admin')) return { ok: false, error: 'Only the owner or an admin of this project manages its collaborators.' };
  if (targetCurrent === 'owner' || targetNew === 'owner') return { ok: false, error: 'The owner\'s access cannot be changed here.' };
  if (actor !== 'owner' && (targetCurrent === 'admin' || targetNew === 'admin')) return { ok: false, error: 'Only the owner gives or takes away the admin role.' };
  return { ok: true };
}
