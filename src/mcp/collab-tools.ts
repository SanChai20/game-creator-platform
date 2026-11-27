// MCP tools for working on one game with other people and other agents (src/collab.ts, docs/collaboration.md):
// collaborators (who works on the game, with which role), branches (a working copy per developer or agent, brought up
// to date with main, conflicts resolved), and change_requests (propose a branch for main, review, merge). Agents that
// connect through MCP and agents driven from the console's ACP workbench use the same tools.
// This file imports no runtime value from ./tools (which lists these tools), so the two never load in a circle.
import { bad, type Env, type User } from '../env';
import { enqueue } from '../pipeline';
import {
  branchView, changeDetail, createBranch, deleteBranch, dismissReview, getBranch, invite, listBranches, listChanges, listMembers, mainHead,
  mergeChange, myInvites, openChange, protectionOf, removeMember, resolveConflict, respondInvite, review, revokeInvite, setChangeStatus,
  setProtection, setRole, targetState, updateBranch, branchWs,
} from '../collab';
import { DEFAULT_PROTECTION, LIMITS, MEMBER_ROLES, ROLE_TEXT, type Role } from '../collab-core';
import { diffLine, isSame } from '../version-sync';
import { scopedProject } from './scope';

interface Ctx { env: Env; user: User; origin: string; client: string; allowedProjects: string[] | null; tool?: string; roles?: Map<string, Role> }
interface Tool {
  name: string; title: string; description: string; inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (a: Record<string, any>, c: Ctx) => Promise<unknown>;
}
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PROJECT = { type: 'string', description: 'Project id or slug (from list_projects, which also lists the projects shared with you).' };
const via = (c: Ctx) => c.client;
const roleOn = (c: Ctx, pid: string): Role => c.roles?.get(pid) ?? 'owner';
const need = (v: unknown, what: string) => { if (v === undefined || v === null || v === '') throw bad(`${what} is needed for this action.`); return v; };

export const COLLAB_TOOLS: Tool[] = [
  {
    name: 'collaborators', title: 'Work with other people on a game: invite, roles, invitations',
    description: `Who works on a game and with which role, as on GitHub. Roles: ${MEMBER_ROLES.map((r) => ROLE_TEXT[r]).join(' ')} ${ROLE_TEXT.owner} Actions: "list" (default) the people and open invitations, and your own role; "invite" {email, role} (owner and admins; admins up to maintain), emailed and open for ${LIMITS.invite_days} days, accepted by the account signed in with that email; "revoke" {invite}; "set_role" {user_id, role}; "remove" {user_id}; "leave" (yourself). Without project: "invitations" lists the invitations sent to you, "accept" or "decline" {invite} answers one. At most ${LIMITS.members} collaborators per game.`,
    inputSchema: obj({
      action: { type: 'string', enum: ['list', 'invite', 'revoke', 'set_role', 'remove', 'leave', 'invitations', 'accept', 'decline'], description: 'Default "list".' },
      project: { ...PROJECT, description: 'The project (not needed for invitations, accept, decline).' },
      email: { type: 'string', description: 'invite: the address the collaborator signs in with.' },
      role: { type: 'string', enum: [...MEMBER_ROLES], description: 'invite, set_role: the role.' },
      user_id: { type: 'string', description: 'set_role, remove: the collaborator (from list).' },
      invite: { type: 'string', description: 'revoke, accept, decline: the invitation id.' },
    }),
    run: async (a, c) => {
      const action = a.action || 'list';
      if (action === 'invitations') {
        const rows = await myInvites(c.env, c.user);
        return { invitations: rows.map((r: any) => ({ invite: r.id, project: r.project_id, title: r.title, role: r.role, invited_by: r.invited_by, expires_at: new Date(r.expires_at).toISOString() })), next: rows.length ? 'collaborators {action: "accept", invite} joins the project.' : 'No open invitations for this account\'s email address.' };
      }
      if (action === 'accept' || action === 'decline') {
        const r = await respondInvite(c.env, c.user, String(need(a.invite, 'invite')), action === 'accept', via(c));
        return { ...r, ...(action === 'accept' ? { next: `You can now work on it: branches {project: "${(r as any).project}", action: "create", name} makes a branch of your own. If this agent connection was limited to selected projects, reconnect it to include this one.` } : {}) };
      }
      const p = await scopedProject(c as any, String(need(a.project, 'project'))), role = roleOn(c, p.id);
      if (action === 'list') return { your_role: role, what_you_can_do: ROLE_TEXT[role], ...(await listMembers(c.env, p, role)), protection: protectionOf(p) };
      if (action === 'invite') return await invite(c.env, c.user, role, p, a.email, a.role, c.origin, via(c));
      if (action === 'revoke') return await revokeInvite(c.env, role, p, String(need(a.invite, 'invite')));
      if (action === 'set_role') return await setRole(c.env, c.user, role, p, String(need(a.user_id, 'user_id')), a.role, via(c));
      if (action === 'remove') return await removeMember(c.env, c.user, role, p, String(need(a.user_id, 'user_id')), via(c));
      if (action === 'leave') return await removeMember(c.env, c.user, role, p, c.user.id, via(c));
      throw bad(`Unknown action "${action}".`);
    },
  },
  {
    name: 'branches', title: 'Branches: a working copy of your own, kept up to date with main',
    description: `A branch is a workspace of its own, forked from a main version (its merge base), so several developers and agents change the same game at once without overwriting each other, as with git branches. upload_files, create_upload_url, list_files, deploy_preview, checkout_version, diff_versions, pull_version, game_metadata and compatibility take {branch}. Actions: "list" (default) main and every branch with how far each is behind main and its change request; "status" {name} one branch with its unresolved conflicts and undeployed changes; "create" {name, from?} (from: a main version number, default main's newest, or "workspace" for main's workspace as it is); "update" {name} brings main's newest version into the branch (git merge main): separate changes combine, lines both sides changed get <<<<<<< ======= >>>>>>> markers and are listed as conflicts; "resolve" {name, path, take: "main"|"branch"} settles a conflict (uploading a conflicted text file without markers settles it too); "delete" {name} (its creator or a maintainer; closes its open change request); "protection" shows main's protection, and with any of required_approvals (0-5, default ${DEFAULT_PROTECTION.required_approvals}), require_verified, dismiss_stale, main_writers ("maintain", "admin", "owner"), allow_bypass changes it (admins). At most ${LIMITS.branches} branches per game.`,
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['list', 'status', 'create', 'update', 'resolve', 'delete', 'protection'], description: 'Default "list".' },
      name: { type: 'string', description: 'The branch: lowercase letters, digits and . _ - /, e.g. "boss-fight" or "anna/menus".' },
      from: { type: ['integer', 'string'], description: 'create: a main version number, or "workspace". Default: main\'s newest version.' },
      path: { type: 'string', description: 'resolve: the conflicted file.' },
      take: { type: 'string', enum: ['main', 'branch'], description: 'resolve: main\'s file, or the branch\'s file as it is in the branch workspace now.' },
      required_approvals: { type: 'integer', minimum: 0, maximum: 5 }, require_verified: { type: 'boolean' }, dismiss_stale: { type: 'boolean' },
      main_writers: { type: 'string', enum: ['maintain', 'admin', 'owner'] }, allow_bypass: { type: 'boolean' },
    }, ['project']),
    run: async (a, c) => {
      const p = await scopedProject(c as any, a.project), role = roleOn(c, p.id), action = a.action || 'list';
      if (action === 'list') return { your_role: role, ...(await listBranches(c.env, p)) };
      if (action === 'status') {
        const b = await getBranch(c.env, p, String(need(a.name, 'name'))), st = await targetState(c.env, p, { ws: branchWs(p.id, b.id), branch: b, label: b.name });
        return { ...(await branchView(c.env, p, b)), workspace: { files: st.files.length, based_on_version: st.base, changed_since: st.diff ? (isSame(st.diff) ? 'nothing' : diffLine(st.diff)) : null } };
      }
      if (action === 'create') {
        const r = await createBranch(c.env, c.user, role, p, a.name, a.from, via(c));
        return { ...r, next: `Work on it with {branch: "${r.branch.name}"} on upload_files, deploy_preview and the other workspace tools. When a version of it is verified, change_requests {action: "open", branch: "${r.branch.name}", title} proposes it for main.` };
      }
      if (action === 'update') return await updateBranch(c.env, c.user, role, p, String(need(a.name, 'name')), via(c));
      if (action === 'resolve') return await resolveConflict(c.env, role, p, String(need(a.name, 'name')), String(need(a.path, 'path')), a.take);
      if (action === 'delete') return await deleteBranch(c.env, c.user, role, p, String(need(a.name, 'name')), via(c));
      if (action === 'protection') {
        const input = Object.fromEntries(['required_approvals', 'require_verified', 'dismiss_stale', 'main_writers', 'allow_bypass'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
        if (!Object.keys(input).length) return { protection: protectionOf(p), main_head: (await mainHead(c.env, p.id)) || null };
        return await setProtection(c.env, c.user, role, p, input, via(c));
      }
      throw bad(`Unknown action "${action}".`);
    },
  },
  {
    name: 'change_requests', title: 'Change requests: propose a branch for main, review it, merge it',
    description: `A change request (a pull request) proposes a branch's newest version for main. Actions: "list" (default; status: open, merged, closed, all); "open" {branch, title, body?} (one open per branch; it follows each new version deployed on the branch); "get" {number}: what it changes, the reviews, a dry run of the merge (conflicts show before anyone merges) and every requirement still unmet; "review" {number, verdict: "approve"|"request_changes"|"comment", body, path?, line?} (not your own for approve or request_changes; an approval counts for the version it reviewed); "dismiss_review" {number, review} (maintainers); "close" / "reopen" {number}; "merge" {number, delete_branch?, bypass?} (maintainers): a three-way merge of main's newest version and the branch's newest version against their merge base, frozen as a new main version and verified like any deploy. A merge is refused, with nothing written, while a requirement is unmet (approvals of the current version, verification, requested changes, conflicts); an admin may bypass the approvals and verification with bypass: true, which is recorded. Publish the merged version with publish.`,
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['list', 'open', 'get', 'review', 'dismiss_review', 'close', 'reopen', 'merge'], description: 'Default "list".' },
      number: { type: 'integer', description: 'The change request number.' },
      status: { type: 'string', enum: ['open', 'merged', 'closed', 'all'], description: 'list: which ones. Default open.' },
      branch: { type: 'string', description: 'open: the branch to propose.' },
      title: { type: 'string', description: 'open: what it changes, in a line.' },
      body: { type: 'string', description: 'open: the description; review: the review text (needed for request_changes and comment).' },
      verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
      path: { type: 'string', description: 'review: a file the comment is about (optional).' },
      line: { type: 'integer', description: 'review: a line in that file (optional).' },
      review: { type: 'string', description: 'dismiss_review: the review id from get.' },
      delete_branch: { type: 'boolean', description: 'merge: delete the branch after merging.' },
      bypass: { type: 'boolean', description: 'merge, admins only: merge although approvals or verification are missing (never with conflicts). Recorded in the activity log.' },
    }, ['project']),
    run: async (a, c) => {
      const p = await scopedProject(c as any, a.project), role = roleOn(c, p.id), action = a.action || 'list';
      if (action === 'list') return { your_role: role, change_requests: await listChanges(c.env, p, a.status) };
      if (action === 'open') return await openChange(c.env, c.user, role, p, String(need(a.branch, 'branch')), a.title, a.body, via(c));
      if (action === 'get') return await changeDetail(c.env, p, c.user, role, need(a.number, 'number'));
      if (action === 'review') return await review(c.env, c.user, role, p, need(a.number, 'number'), a.verdict, a.body, a.path, a.line, via(c));
      if (action === 'dismiss_review') return await dismissReview(c.env, c.user, role, p, need(a.number, 'number'), need(a.review, 'review'));
      if (action === 'close' || action === 'reopen') return await setChangeStatus(c.env, c.user, role, p, need(a.number, 'number'), action === 'close' ? 'closed' : 'open', via(c));
      if (action === 'merge') {
        return await mergeChange(c.env, c.user, role, p, need(a.number, 'number'), {
          bypass: a.bypass === true, delete_branch: a.delete_branch === true, via: via(c), origin: c.origin,
          enqueue: (n) => enqueue(c.env, { kind: 'preview', pid: p.id, n, origin: c.origin, actor: via(c) }),
        });
      }
      throw bad(`Unknown action "${action}".`);
    },
  },
];

