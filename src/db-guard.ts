// Keeps the platform working when game data grows. D1 has a hard size limit per database (10 GB); past it, every write
// fails, sign-in and purchases included. Games' own data (saves, stats, scores, server store, shared data) is refused
// first, once the database passes the admin-set ceiling, so the rest of the platform keeps the room it needs.
// The size comes from D1's own query metadata (meta.size_after), learnt per isolate at most once a minute.
import { AppError, type Env } from './env';

let size = 0, at = 0;
const FRESH_MS = 60_000;

/** Notes the database size a D1 result reports. */
export function noteSize(meta: unknown): void {
  const s = Number((meta as { size_after?: number } | undefined)?.size_after);
  if (Number.isFinite(s) && s > 0) { size = s; at = Date.now(); }
}
/** The database size in bytes as last seen (0 when unknown). */
export async function dbSize(env: Env): Promise<number> {
  if (Date.now() - at > FRESH_MS) {
    try { noteSize((await env.DB.prepare('SELECT 1').run()).meta); } catch { /* unknown: allow */ }
    if (!at) at = Date.now();   // a driver without size metadata (tests, local) asks again only a minute later
  }
  return size;
}
/** Refuses a write of game data when the database is past the ceiling (gigabytes, 0 turns the check off). */
export async function assertGameDataRoom(env: Env, ceilingGb: number): Promise<void> {
  if (!(ceilingGb > 0)) return;
  if ((await dbSize(env)) > ceilingGb * 1024 ** 3) {
    console.error(JSON.stringify({ db_guard: 'game data refused', size }));
    throw new AppError(507, 'The platform is short of room for game data right now. Your progress was not saved; try again later.', 'storage_full');
  }
}
