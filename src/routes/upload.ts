// Direct uploads from an agent's shell (curl), authorised by a short-lived token from create_upload_url.
import { Hono } from 'hono';
import { AppError, bad, type Env } from '../env';
import { userById } from '../auth';
import { importZip } from '../mcp/tools';
import { ownedProject, putFile } from '../projects';
import { getSettings } from '../settings';
import { now, sha256 } from '../util';

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
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength > s.file_max_bytes) throw bad(`File too large (${s.file_max_bytes} bytes max).`);
  const row = await putFile(c.env, project, path, buf);
  return c.json({ written: [{ path: row.path, bytes: row.size }] });
});

upload.post('/:token/zip', async (c) => {
  const { user, project } = await grant(c.env, c.req.param('token')), s = await getSettings(c.env);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength > s.bundle_max_bytes) throw bad(`Zip too large (${s.bundle_max_bytes} bytes max).`);
  return c.json(await importZip(c.env, user, project.id, buf, c.req.query('clean') === '1'));
});
