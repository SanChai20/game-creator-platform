// Project-scoped authorization for MCP grants.
// A grant has either unrestricted access to all projects in the account (`allowedProjects === null`),
// or access limited to a specific set of project IDs chosen during OAuth or device authorization (`string[]`).
import { bad, forbidden, type Env, type Project, type User } from '../env';
import { accessProject, roleOf } from '../collab';
import { atLeast, type Role } from '../collab-core';

export interface McpAuthProps {
  userId?: string;
  client?: string;
  projectIds?: string[] | null;
}

export interface SelectableProject {
  id: string;
  slug: string;
  title: string;
  status: string;
  updated_at: number;
  role?: string;
}

export interface ScopedCtx {
  env: Env;
  user: User;
  allowedProjects: string[] | null;
  /** The tool being called: it decides the least role a collaborator needs (TOOL_ROLES). */
  tool?: string;
  /** Each project's role for this call, filled by scopedProject. */
  roles?: Map<string, Role>;
}

/**
 * The least role each tool needs on a project (src/collab-core.ts). A tool not listed needs the owner, so a tool added
 * later stays the owner's until someone decides otherwise. Tools that write a workspace check main's protection or the
 * branch themselves (src/collab.ts target), and tools with owner-only parts (prices, sales) check those parts.
 */
export const TOOL_ROLES: Record<string, Role> = {
  list_projects: 'read', list_files: 'read', list_versions: 'read', pull_version: 'read', diff_versions: 'read', game_standards: 'read',
  game_storage: 'read', upload_files: 'read', create_upload_url: 'read', checkout_version: 'read', deploy_preview: 'read',
  game_metadata: 'read', compatibility: 'read', collaborators: 'read', branches: 'read', change_requests: 'read',
  debug_preview: 'write',
  update_project: 'maintain', game_data: 'maintain', game_room: 'maintain', build_skill: 'maintain',
  publish: 'admin', rollback: 'admin', unpublish: 'admin',
  jam: 'admin', // enters the game in a public event under the owner's name
  playtest: 'maintain', // opens the preview to outside players
  devlog: 'admin', // posts news to the game's players, like a release
};

const MAX_SELECTED_PROJECTS = 500;

/** Normalizes `projectIds` from OAuth grant props. `null`/`undefined` means all projects; an array restricts access. */
export function normalizeProjectIds(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Parses `device_codes.project_ids` (NULL -> all projects; invalid JSON fails closed to `[]`). */
export function parseStoredProjectIds(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return normalizeProjectIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function isProjectAllowed(allowedProjects: string[] | null, projectId: string): boolean {
  return allowedProjects === null || allowedProjects.includes(projectId);
}

/** Validates a user's project selection during consent: must be non-empty and owned by `userId`. */
export async function resolveAllowedProjects(env: Env, userId: string, requestedIds: unknown): Promise<string[]> {
  const ids = normalizeProjectIds(Array.isArray(requestedIds) ? requestedIds : []);
  if (!ids || !ids.length) {
    throw bad('Select at least one project, or choose "All projects".');
  }
  if (ids.length > MAX_SELECTED_PROJECTS) {
    throw bad(`At most ${MAX_SELECTED_PROJECTS} projects can be selected individually. Choose "All projects" instead.`);
  }
  const rows = await env.DB.prepare(
    `SELECT id FROM projects WHERE status != 'removed' AND id IN (SELECT value FROM json_each(?2))
       AND (owner_id = ?1 OR id IN (SELECT project_id FROM project_members WHERE user_id = ?1))`
  ).bind(userId, JSON.stringify(ids)).all<{ id: string }>();
  const owned = new Set(rows.results.map((r) => r.id));
  if (owned.size !== ids.length) {
    throw forbidden('One or more selected projects are not yours or shared with you.');
  }
  return ids;
}

/** Lists the projects `userId` owns or collaborates on (not removed) for OAuth/device consent project pickers. */
export async function listSelectableProjects(env: Env, userId: string): Promise<SelectableProject[]> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.status, p.updated_at, CASE WHEN p.owner_id = ?1 THEN 'owner' ELSE m.role END AS role
       FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?1
      WHERE (p.owner_id = ?1 OR m.user_id IS NOT NULL) AND p.status != 'removed' ORDER BY p.updated_at DESC`
  ).bind(userId).all<SelectableProject>();
  return rows.results;
}

/**
 * Resolves a project by id or slug and enforces the user's role on it (owner, or a collaborator with at least the role
 * the tool needs) and the grant's project scope.
 */
export async function scopedProject(c: ScopedCtx, idOrSlug: string, need?: Role): Promise<Project> {
  const { p, role } = await accessProject(c.env, c.user, idOrSlug, need ?? (c.tool ? TOOL_ROLES[c.tool] ?? 'owner' : 'owner'), c.tool ? `calling ${c.tool}` : 'this');
  let r = role;
  if (c.allowedProjects !== null && c.user.role === 'admin' && p.owner_id !== c.user.id) {
    // a project-scoped connection never gets the platform admin's reach: only the role the person holds on the project
    r = (await roleOf(c.env, { id: c.user.id, role: 'user' } as any, p)) as Role;
    const needRole = need ?? (c.tool ? TOOL_ROLES[c.tool] ?? 'owner' : 'owner');
    if (!r || !atLeast(r, needRole)) throw forbidden(`This agent connection is limited to selected projects and cannot use platform admin access on "${p.title}".`, 'Reconnect without a project selection to act as a platform admin.');
  }
  c.roles?.set(p.id, r);
  if (c.allowedProjects !== null) {
    // Even if the authorizing user is an admin, a project-scoped agent may only touch the explicitly authorized projects.
    if (!c.allowedProjects.includes(p.id)) {
      throw forbidden(
        `This agent connection does not have access to project "${p.title}" (${p.id}).`,
        'Call list_projects to see which projects this connection can access, or ask the creator to reconnect and include this project.',
      );
    }
  }
  return p;
}

/** Refuses `create_project` when the MCP grant is restricted to specific existing projects. */
export function assertCanCreateProject(allowedProjects: string[] | null): void {
  if (allowedProjects !== null) {
    throw forbidden(
      'This agent connection is limited to selected projects and cannot create new projects.',
      'Ask the creator to reconnect this agent with "All projects" access if you need to create a new project.',
    );
  }
}
