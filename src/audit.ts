// Checks the games bucket for objects the platform did not write the way it writes them. Until game Workers stopped
// getting a bucket binding, a game's server code could reach the whole bucket; this finds what such code could have
// changed: version files rewritten after their version was frozen, workspace files that differ from their record,
// pictures stored as something other than a picture, and objects under prefixes the platform never writes.
// Runs one page of the bucket per call (admin: POST /api/admin/audit/files), so a large bucket is checked in steps.
import type { Env } from './env';
import { parseJson } from './util';

export interface AuditFlag { key: string; problem: string; uploaded?: string; size?: number; type?: string }
const SLACK_MS = 10 * 60 * 1000;   // objects are written just before their record; anything this much later was rewritten
const PICTURE = /^image\/(png|jpeg|webp)$/;

/** Pure: what is wrong with one object, given what the database says about it. Exported for tests. */
export function auditObject(o: { key: string; size: number; uploaded: number; type?: string },
  version: { created_at: number; files: { path: string; size: number }[] } | null | undefined,
  workspace: { size: number; updated_at: number } | null | undefined): string | null {
  const k = o.key;
  let m = /^v\/([a-z0-9]{6,16})\/(\d+)\/(.+)$/.exec(k);
  if (m) {
    if (!version) return 'version file with no version record';
    const f = version.files.find((x) => x.path === m![3]);
    if (!f) return 'file is not part of its version';
    if (f.size !== o.size) return `size differs from the version record (${f.size} recorded)`;
    if (o.uploaded > version.created_at + SLACK_MS) return 'written after its version was frozen';
    return null;
  }
  m = /^ws\/([a-z0-9]{6,16})\/(.+)$/.exec(k);
  if (m) {
    if (!workspace) return 'workspace file with no file record';
    if (workspace.size !== o.size) return `size differs from the file record (${workspace.size} recorded)`;
    if (o.uploaded > workspace.updated_at + SLACK_MS) return 'written after its file record';
    return null;
  }
  if (/^(covers|shots)\//.test(k)) {
    if (!/\.(png|jpe?g|webp)$/.test(k)) return 'picture with a name that is not png, jpg or webp';
    if (o.type && !PICTURE.test(o.type)) return `picture stored as ${o.type}`;
    return null;
  }
  return 'object under a prefix the platform never writes';
}

export async function auditFiles(env: Env, cursor?: string, limit = 500): Promise<{ checked: number; flags: AuditFlag[]; cursor: string | null }> {
  const page = await env.FILES.list({ cursor, limit: Math.min(Math.max(limit, 1), 1000), include: ['httpMetadata'] } as R2ListOptions);
  const versions = new Map<string, { created_at: number; files: { path: string; size: number }[] } | null>();
  const flags: AuditFlag[] = [];
  for (const o of page.objects) {
    let version, workspace;
    const v = /^v\/([a-z0-9]{6,16})\/(\d+)\//.exec(o.key);
    if (v) {
      const id = `${v[1]}/${v[2]}`;
      if (!versions.has(id)) {
        const r = await env.DB.prepare('SELECT created_at, files FROM versions WHERE project_id = ? AND n = ?').bind(v[1], Number(v[2])).first<{ created_at: number; files: string }>();
        versions.set(id, r ? { created_at: r.created_at, files: parseJson(r.files, []) } : null);
      }
      version = versions.get(id);
    }
    const w = /^ws\/([a-z0-9]{6,16})\/(.+)$/.exec(o.key);
    if (w) workspace = await env.DB.prepare('SELECT size, updated_at FROM files WHERE project_id = ? AND path = ?').bind(w[1], w[2]).first<{ size: number; updated_at: number }>();
    const type = o.httpMetadata?.contentType, uploaded = o.uploaded.getTime();
    const problem = auditObject({ key: o.key, size: o.size, uploaded, type }, version, workspace);
    if (problem) flags.push({ key: o.key, problem, uploaded: o.uploaded.toISOString(), size: o.size, type });
  }
  return { checked: page.objects.length, flags, cursor: page.truncated ? page.cursor : null };
}
