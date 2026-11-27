// Direct uploads from an agent's shell (curl), authorised by a short-lived token from create_upload_url, and downloads
// (pull_version) the same way.
import { Hono } from 'hono';
import { AppError, bad, type Env } from '../env';
import { userById } from '../auth';
import { importZip } from '../mcp/tools';
import { putFile } from '../projects';
import { accessProject, autoResolve, target, withLock } from '../collab';
import { getSettings } from '../settings';
import { now, readCapped, sha256 } from '../util';
import { budgetOf, mb, storageLine } from '../storage';
import { storageHint } from '../storage-rules';
import { readSourceFile, sourceFiles, sourceName, zipStream, type Source } from '../version-store';

export const upload = new Hono<{ Bindings: Env }>();

async function grant(env: Env, token: string) {
  const g = await env.DB.prepare('SELECT project_id, user_id, expires_at, ws FROM uploads WHERE token_hash = ?').bind(await sha256(token)).first<{ project_id: string; user_id: string; expires_at: number; ws: string | null }>();
  if (!g || g.expires_at < now()) throw new AppError(401, 'This upload URL has expired. Call create_upload_url again.', 'expired');
  const user = await userById(env, g.user_id);
  if (!user || user.status !== 'active') throw new AppError(403, 'Account not active.');
  // the role is checked again on every upload: a collaborator removed since the URL was made cannot use it
  const { p, role } = await accessProject(env, user, g.project_id, 'read');
  const branchId = g.ws && g.ws.startsWith(p.id + '~') ? g.ws.slice(p.id.length + 1) : null;
  const name = branchId ? (await env.DB.prepare("SELECT name FROM branches WHERE id = ? AND status = 'open'").bind(branchId).first<{ name: string }>())?.name : null;
  if (branchId && !name) throw new AppError(410, 'The branch this upload URL was made for was deleted.', 'branch_gone');
  const t = await target(env, p, role, name || null, 'write');
  return { user, project: p, t };
}

upload.put('/:token', async (c) => {
  const { project, t } = await grant(c.env, c.req.param('token')), s = await getSettings(c.env);
  const path = c.req.query('path');
  if (!path) throw bad('Add ?path=<file path>, e.g. ?path=index.html');
  const declared = Number(c.req.header('content-length') || 0);   // refuse an oversized file before reading it
  if (declared > s.file_max_bytes) throw new AppError(413, `${path} is ${mb(declared)}; the largest file a game can hold is ${mb(s.file_max_bytes)}.`, 'file_too_large', storageHint(s.storage_requests_open));
  const buf = await readCapped(c.req.raw, s.file_max_bytes);   // also without a Content-Length (chunked), never more than the limit
  if (!buf) throw new AppError(413, `${path} is larger than ${mb(s.file_max_bytes)}, the largest file a game can hold.`, 'file_too_large', storageHint(s.storage_requests_open));
  const row = await withLock(c.env, t.ws, () => putFile(c.env, project, path, buf, false, t.ws));   // checks the file and the game's storage
  const resolved = await autoResolve(c.env, t.branch, [row.path], t.ws);
  return c.json({ ...(t.branch ? { branch: t.branch.name } : {}), written: [{ path: row.path, bytes: row.size }], ...(resolved.length ? { conflicts_resolved: resolved } : {}), storage: await storageLine(c.env, project) });
});

upload.post('/:token/zip', async (c) => {
  const { project, t } = await grant(c.env, c.req.param('token')), s = await getSettings(c.env);
  const room = budgetOf(project, s).bytes, declared = Number(c.req.header('content-length') || 0);
  // refused before the body is read; unpacking then goes by the sizes in the zip's directory, which importZip checks
  // first (fflate never writes more than an entry's declared size, so a zip that lies about its sizes cannot grow)
  if (declared > room) throw new AppError(413, `The zip is ${mb(declared)}; this game has ${mb(room)} of storage in all.`, 'storage_full', storageHint(s.storage_requests_open));
  const buf = await readCapped(c.req.raw, room);
  if (!buf || buf.byteLength > room) throw new AppError(413, `The zip is ${buf ? mb(buf.byteLength) : `over ${mb(room)}`}; this game has ${mb(room)} of storage in all.`, 'storage_full', storageHint(s.storage_requests_open));
  return c.json(await withLock(c.env, t.ws, async () => {
    const r = await importZip(c.env, project, buf, c.req.query('clean') === '1', t.ws);
    const resolved = await autoResolve(c.env, t.branch, r.written, t.ws);
    return { ...(t.branch ? { branch: t.branch.name } : {}), ...r, ...(resolved.length ? { conflicts_resolved: resolved } : {}) };
  }, 30_000));
});

// Downloads to an agent's shell (curl), authorised by a short-lived token from pull_version: the whole version (or the
// workspace) as a zip, or one file with ?path=. This is how another machine signed in to the same account gets a version.
export const download = new Hono<{ Bindings: Env }>();

async function downloadGrant(env: Env, token: string) {
  const g = await env.DB.prepare('SELECT project_id, user_id, version, expires_at, ws FROM downloads WHERE token_hash = ?').bind(await sha256(token)).first<{ project_id: string; user_id: string; version: number | null; expires_at: number; ws: string | null }>();
  if (!g || g.expires_at < now()) throw new AppError(401, 'This download URL has expired. Call pull_version again.', 'expired');
  const user = await userById(env, g.user_id);
  if (!user || user.status !== 'active') throw new AppError(403, 'Account not active.');
  const { p: project } = await accessProject(env, user, g.project_id, 'read');
  const source: Source = g.version ? { version: g.version } : { workspace: true, ...(g.ws && g.ws.startsWith(project.id + '~') ? { ws: g.ws, label: 'the branch' } : {}) };
  return { project, source };
}

download.get('/:token', async (c) => {
  const { project, source } = await downloadGrant(c.env, c.req.param('token'));
  const files = await sourceFiles(c.env, project, source), one = c.req.query('path');
  const label = 'version' in source ? `v${source.version}` : 'workspace';
  if (one) {
    const f = files.find((x) => x.path === one);
    const obj = f && await readSourceFile(c.env, project, source, f.path);
    if (!obj) throw new AppError(404, `No file "${one}" in ${sourceName(source)}.`, 'not_found');
    return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size), 'x-gcp-sha': f!.sha, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }
  return new Response(zipStream(c.env, project, source, files), { headers: {
    'content-type': 'application/zip', 'content-disposition': `attachment; filename="${project.slug}-${label}.zip"`, 'cache-control': 'no-store',
    'x-gcp-files': String(files.length),
  } });
});
