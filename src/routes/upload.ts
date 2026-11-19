// Direct uploads from an agent's shell (curl), authorised by a short-lived token from create_upload_url.
import { Hono } from 'hono';
import { AppError, bad, type Env } from '../env';
import { userById } from '../auth';
import { importZip } from '../mcp/tools';
import { ownedProject, putFile } from '../projects';
import { getSettings } from '../settings';
import { now, sha256 } from '../util';
import { budgetOf, mb, storageLine } from '../storage';
import { storageHint } from '../storage-rules';

export const upload = new Hono<{ Bindings: Env }>();

async function grant(env: Env, token: string) {
  const g = await env.DB.prepare('SELECT project_id, user_id, expires_at FROM uploads WHERE token_hash = ?').bind(await sha256(token)).first<{ project_id: string; user_id: string; expires_at: number }>();
  if (!g || g.expires_at < now()) throw new AppError(401, 'This upload URL has expired. Call create_upload_url again.', 'expired');
  const user = await userById(env, g.user_id);
  if (!user || user.status !== 'active') throw new AppError(403, 'Account not active.');
  return { user, project: await ownedProject(env, user, g.project_id) };
}

upload.put('/:token', async (c) => {
  const { project } = await grant(c.env, c.req.param('token')), s = await getSettings(c.env);
  const path = c.req.query('path');
  if (!path) throw bad('Add ?path=<file path>, e.g. ?path=index.html');
  const declared = Number(c.req.header('content-length') || 0);   // refuse an oversized file before reading it
  if (declared > s.file_max_bytes) throw new AppError(413, `${path} is ${mb(declared)}; the largest file a game can hold is ${mb(s.file_max_bytes)}.`, 'file_too_large', storageHint(s.storage_requests_open));
  const buf = new Uint8Array(await c.req.arrayBuffer());
  const row = await putFile(c.env, project, path, buf);   // checks the file and the game's storage
  return c.json({ written: [{ path: row.path, bytes: row.size }], storage: await storageLine(c.env, project) });
});

upload.post('/:token/zip', async (c) => {
  const { user, project } = await grant(c.env, c.req.param('token')), s = await getSettings(c.env);
  const room = budgetOf(project, s).bytes, declared = Number(c.req.header('content-length') || 0);
  // refused before the body is read; unpacking then goes by the sizes in the zip's directory, which importZip checks
  // first (fflate never writes more than an entry's declared size, so a zip that lies about its sizes cannot grow)
  if (declared > room) throw new AppError(413, `The zip is ${mb(declared)}; this game has ${mb(room)} of storage in all.`, 'storage_full', storageHint(s.storage_requests_open));
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength > room) throw new AppError(413, `The zip is ${mb(buf.byteLength)}; this game has ${mb(room)} of storage in all.`, 'storage_full', storageHint(s.storage_requests_open));
  return c.json(await importZip(c.env, user, project.id, buf, c.req.query('clean') === '1'));
});
