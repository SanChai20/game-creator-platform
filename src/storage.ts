// Per-game storage on the Worker: the budget each game has, refusing changes that do not fit, creators' requests for
// more, and an admin's decisions. The rules themselves are pure (./storage-rules) so tests can run them.
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from './env';
import { getSettings, type Settings } from './settings';
import { logEvent, listFiles, type FileRow } from './projects';
import { KEEP_SMALL, MB, RUNTIME_LOADING, breakdown, budgetOf, checkChange, mb, storageHint, storageStatus, totalOf, type FileSize } from './storage-rules';
import { now, rid } from './util';

export { budgetOf, mb, MB } from './storage-rules';

/** The storage line for tool answers: used, storage, free, and a warning from 80% used. */
export async function storageLine(env: Env, p: Project, files?: FileSize[]) {
  const s = await getSettings(env);
  return storageStatus(totalOf(files ?? await listFiles(env, p.id)), budgetOf(p, s), s.storage_requests_open);
}

export interface StorageRequest {
  id: string; project_id: string; user_id: string; bytes: number; quota_bytes: number; used_bytes: number; reason: string;
  status: 'pending' | 'approved' | 'denied' | 'withdrawn'; granted_bytes: number | null; note: string | null; decided_by: string | null; decided_at: number | null; created_at: number;
}

/** Throws a clear, actionable refusal when writing `writes` and deleting `deletes` would not fit the game's storage. */
export function assertFits(s: Settings, p: Project, files: FileSize[], writes: FileSize[], deletes: string[] = []) {
  const r = checkChange(files, writes, deletes, budgetOf(p, s));
  if (!r) return;
  const hint = storageHint(s.storage_requests_open);
  if (r.kind === 'file') throw new AppError(413, r.message, 'file_too_large', `Split it, compress it, generate it from code, or load it at run time from a host you control. ${hint}`);
  if (r.kind === 'files') throw new AppError(413, r.message, 'too_many_files', 'Merge small files (an atlas for sprites, one module bundle for code) or delete unused ones with upload_files {delete}.');
  throw new AppError(413, r.message, 'storage_full', hint);
}

/** The refusal for a version or workspace that is already over (deploy_preview, publish). Null when it fits. */
export function overBudget(s: Settings, p: Project, bytes: number, files: number): { message: string; hint: string } | null {
  const b = budgetOf(p, s);
  if (bytes > b.bytes) return { message: `The game's files add up to ${mb(bytes)}; this game has ${mb(b.bytes)} of storage.`, hint: storageHint(s.storage_requests_open) };
  if (files > b.files) return { message: `The game has ${files} files; a game can hold ${b.files}.`, hint: 'Merge small files (an atlas for sprites, one module bundle for code) or delete unused ones with upload_files {delete}.' };
  return null;
}

export async function latestRequest(env: Env, pid: string): Promise<StorageRequest | null> {
  return env.DB.prepare('SELECT * FROM storage_requests WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').bind(pid).first<StorageRequest>();
}

const requestView = (r: StorageRequest | null) => r ? {
  status: r.status, asked_for: mb(r.bytes), asked_at: new Date(r.created_at).toISOString(), reason: r.reason,
  ...(r.status === 'approved' ? { granted: mb(r.granted_bytes ?? r.bytes) } : {}), ...(r.note ? { answer: r.note } : {}), ...(r.decided_at ? { decided_at: new Date(r.decided_at).toISOString() } : {}),
} : null;

/** Everything an agent or the console needs about one game's storage. */
export async function storageReport(env: Env, p: Project, files?: FileRow[]) {
  const s = await getSettings(env), rows = files ?? await listFiles(env, p.id), b = budgetOf(p, s), used = totalOf(rows);
  const req = await latestRequest(env, p.id);
  return {
    storage: mb(b.bytes), storage_bytes: b.bytes, used: mb(used), used_bytes: used, free: mb(Math.max(0, b.bytes - used)), free_bytes: Math.max(0, b.bytes - used),
    percent_used: b.bytes ? Math.round((used / b.bytes) * 100) : 100, over: used > b.bytes,
    source: b.source === 'game' ? 'set for this game by the platform' : `the platform default for every game (${mb(s.bundle_max_bytes)})`,
    limits: { largest_file: mb(b.file), files: `${rows.length} of ${b.files}` },
    ...breakdown(rows),
    request: requestView(req),
    can_request: s.storage_requests_open ? { up_to: mb(Math.max(s.storage_max_bytes, b.bytes)), automatic_up_to: s.storage_auto_approve_bytes > 0 ? mb(s.storage_auto_approve_bytes) : 'none: an admin reviews every request' } : 'closed: storage requests are turned off on this platform',
  };
}

export const STORAGE_GUIDE = { keep_small: KEEP_SMALL, runtime_loading: RUNTIME_LOADING };

/** A creator asks for more storage for one game. Approved at once under the automatic limit; otherwise an admin decides. */
export async function requestStorage(env: Env, user: User, p: Project, megabytes: unknown, reason: unknown, actor: string) {
  const s = await getSettings(env), b = budgetOf(p, s);
  if (!s.storage_requests_open) throw forbidden('Storage requests are turned off on this platform.', storageHint(false));
  const want = Math.round(Number(megabytes) * MB), why = String(reason ?? '').trim();
  if (!Number.isFinite(want) || want <= 0) throw bad('megabytes must be the total storage wanted for the game, in MB (e.g. 80).');
  if (want <= b.bytes) throw bad(`The game already has ${mb(b.bytes)}. megabytes is the new total, not an amount to add.`);
  const max = Math.max(s.storage_max_bytes, b.bytes);
  if (want > max) throw forbidden(`Creators can ask for at most ${mb(max)} for one game.`, storageHint(false));
  if (why.length < 40) throw bad('Explain in reason (at least 40 characters) what needs the space and why generating it from code or loading it at run time does not work for it.', 'game_storage {project} shows where the storage goes now.');
  const used = totalOf(await listFiles(env, p.id)), t = now();
  // one open request per game: a new one replaces it
  await env.DB.prepare("UPDATE storage_requests SET status = 'withdrawn', decided_at = ? WHERE project_id = ? AND status = 'pending'").bind(t, p.id).run();
  const id = rid(12), auto = s.storage_auto_approve_bytes > 0 && want <= s.storage_auto_approve_bytes;
  await env.DB.prepare('INSERT INTO storage_requests (id, project_id, user_id, bytes, quota_bytes, used_bytes, reason, status, granted_bytes, note, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, p.id, user.id, want, b.bytes, used, why.slice(0, 1000), auto ? 'approved' : 'pending', auto ? want : null, auto ? 'Approved automatically.' : null, auto ? 'auto' : null, auto ? t : null, t).run();
  if (auto) await env.DB.prepare('UPDATE projects SET storage_bytes = ? WHERE id = ?').bind(want, p.id).run();
  await logEvent(env, p.id, 'storage', auto ? `Storage raised to ${mb(want)} (automatic)` : `Asked for ${mb(want)} of storage`, null, actor);
  return auto
    ? { status: 'approved', storage: mb(want), next: 'The game can hold the new amount now. Upload the files, then deploy_preview.' }
    : { status: 'pending', asked_for: mb(want), next: 'An admin reviews the request. game_storage {project} shows its status and the answer. Meanwhile keep building inside the current storage.' };
}

/** An admin sets one game's storage. null returns it to the platform default. */
export async function setGameStorage(env: Env, p: Project, bytes: number | null, actor: string) {
  if (bytes !== null && (!Number.isFinite(bytes) || bytes < 0)) throw bad('Storage must be a positive number of MB, or empty for the platform default.');
  await env.DB.prepare('UPDATE projects SET storage_bytes = ? WHERE id = ?').bind(bytes === null ? null : Math.round(bytes), p.id).run();
  await logEvent(env, p.id, 'storage', bytes === null ? 'Storage set back to the platform default' : `Storage set to ${mb(bytes)} by the platform`, null, actor);
}

/** An admin approves (optionally with a different amount) or denies a request. */
export async function decideRequest(env: Env, admin: User, id: string, approve: boolean, megabytes?: unknown, note?: unknown) {
  const r = await env.DB.prepare('SELECT * FROM storage_requests WHERE id = ?').bind(id).first<StorageRequest>();
  if (!r) throw notFound();
  if (r.status !== 'pending') throw bad('Only a pending request can be decided.');
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(r.project_id).first<Project>();
  if (!p) throw notFound();
  const text = String(note ?? '').trim().slice(0, 500) || null, t = now();
  if (approve) {
    const grant = megabytes !== undefined && megabytes !== null && megabytes !== '' ? Math.round(Number(megabytes) * MB) : r.bytes;
    if (!Number.isFinite(grant) || grant <= 0) throw bad('Enter the storage to grant in MB.');
    await env.DB.batch([
      env.DB.prepare("UPDATE storage_requests SET status = 'approved', granted_bytes = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?").bind(grant, text, admin.id, t, id),
      env.DB.prepare('UPDATE projects SET storage_bytes = ? WHERE id = ?').bind(grant, p.id),
    ]);
    await logEvent(env, p.id, 'storage', `Storage request approved: ${mb(grant)}`, null, 'admin');
  } else {
    await env.DB.prepare("UPDATE storage_requests SET status = 'denied', note = ?, decided_by = ?, decided_at = ? WHERE id = ?").bind(text, admin.id, t, id).run();
    await logEvent(env, p.id, 'storage', `Storage request denied${text ? `: ${text}` : ''}`, null, 'admin');
  }
}
