// Devlogs and patch notes on the Worker side (rules in src/devlogs.js): writes the post, then tells the most recent
// part of its audience at once on their open pages and by push (src/social.ts pushTo). Never throws from the announce.
import type { Env, Project } from './env';
import { pushTo } from './social';
// @ts-ignore plain JS module
import { cleanPatchNotes, postDevlog } from './devlogs.js';
// @ts-ignore plain JS module
import { gameRef } from './social-rules.js';

const CHUNK = 25;

export async function publishDevlog(env: Env, p: Project, author: string, raw: unknown, opts: { kind?: 'post' | 'patch'; version?: number | null; announce?: boolean } = {}): Promise<{ id: string | null; notified: number; told: number; existing?: boolean }> {
  const r = await postDevlog(env.DB, p, author, raw, opts) as { id: string | null; notified: number; live: string[]; existing?: boolean };
  let told = 0;
  if (r.live.length) {
    try {
      const row = await env.DB.prepare('SELECT id, slug, title, listing_i18n, listing_lang, langs FROM projects WHERE id = ?').bind(p.id).first<Record<string, any>>();
      const ev = { kind: 'devlog', game: gameRef(row), devlog: { id: r.id, title: String((raw as { title?: string })?.title || '').slice(0, 120) } };
      for (let i = 0; i < r.live.length; i += CHUNK) {
        const got = await Promise.allSettled(r.live.slice(i, i + CHUNK).map((uid) => pushTo(env, uid, ev)));
        told += got.filter((x) => x.status === 'fulfilled').length;
      }
    } catch (e) { console.warn('devlog news', p.id, String((e as Error).message || e)); }
  }
  return { id: r.id, notified: r.notified, told, ...(r.existing ? { existing: true } : {}) };
}

/** The patch notes stored on a version that just went live, posted once. Updates are announced; a first release is not (its news is the new game). */
export async function postPatchNotes(env: Env, p: Project, n: number, firstRelease: boolean): Promise<{ notified: number } | null> {
  try {
    const v = await env.DB.prepare('SELECT patch_notes FROM versions WHERE project_id = ? AND n = ?').bind(p.id, n).first<{ patch_notes: string | null }>();
    if (!v?.patch_notes) return null;
    const notes = cleanPatchNotes(JSON.parse(v.patch_notes), n);
    if (!notes) return null;
    const live = { ...p, status: 'live' } as Project;
    const r = await publishDevlog(env, live, p.owner_id, notes, { kind: 'patch', version: n, announce: !firstRelease });
    return { notified: r.notified };
  } catch (e) { console.warn('patch notes', p.id, n, String((e as Error).message || e)); return null; }
}
