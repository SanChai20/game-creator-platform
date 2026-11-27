// Project-scoped authorization for MCP grants.
// A grant has either unrestricted access to all projects in the account (`allowedProjects === null`),
// or access limited to a specific set of project IDs chosen during OAuth or device authorization (`string[]`).
import { bad, forbidden, type Env, type Project, type User } from '../env';
import { ownedProject } from '../projects';

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
}

export interface ScopedCtx {
  env: Env;
  user: User;
  allowedProjects: string[] | null;
}

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
    "SELECT id FROM projects WHERE owner_id = ?1 AND status != 'removed' AND id IN (SELECT value FROM json_each(?2))"
  ).bind(userId, JSON.stringify(ids)).all<{ id: string }>();
  const owned = new Set(rows.results.map((r) => r.id));
  if (owned.size !== ids.length) {
    throw forbidden('One or more selected projects do not belong to your account.');
  }
  return ids;
}

/** Lists all non-removed projects owned by `userId` for OAuth/device consent project pickers. */
export async function listSelectableProjects(env: Env, userId: string): Promise<SelectableProject[]> {
  const rows = await env.DB.prepare(
    "SELECT id, slug, title, status, updated_at FROM projects WHERE owner_id = ? AND status != 'removed' ORDER BY updated_at DESC"
  ).bind(userId).all<SelectableProject>();
  return rows.results;
}

/** Resolves a project by id or slug and enforces both account ownership and the grant's project scope. */
export async function scopedProject(c: ScopedCtx, idOrSlug: string): Promise<Project> {
  const p = await ownedProject(c.env, c.user, idOrSlug);
  if (c.allowedProjects !== null) {
    // Even if the authorizing user is an admin, a project-scoped agent may only touch the explicitly authorized projects.
    if (p.owner_id !== c.user.id || !c.allowedProjects.includes(p.id)) {
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
