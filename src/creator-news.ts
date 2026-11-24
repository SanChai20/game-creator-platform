// A creator's game went live for the first time: their followers hear about it. Every follower gets a notification
// under the bell (one statement, src/follows.js announceNewGame); the most recent followers are also told at once on
// their open pages, and by a push notification on the devices that turned those on (src/social.ts pushTo). Never
// fails the publish that called it.
import type { Env } from './env';
import { pushTo } from './social';
// @ts-ignore plain JS module
import { announceNewGame } from './follows.js';
// @ts-ignore plain JS module
import { gameRef } from './social-rules.js';

const CHUNK = 25;

export async function announceFirstRelease(env: Env, pid: string): Promise<{ notified: number; told: number }> {
  try {
    const p = await env.DB.prepare(`SELECT p.id, p.slug, p.title, p.owner_id, p.status, p.hidden_at, p.listing_i18n, p.listing_lang, p.langs, u.name AS creator
        FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?`).bind(pid).first<Record<string, any>>();
    if (!p || p.status !== 'live' || p.hidden_at) return { notified: 0, told: 0 };
    const r = await announceNewGame(env.DB, p.owner_id, p.id) as { notified: number; live: string[] };
    const ev = { kind: 'new_game', creator: { id: p.owner_id, name: p.creator }, game: gameRef(p) };
    let told = 0;
    for (let i = 0; i < r.live.length; i += CHUNK) {
      const got = await Promise.allSettled(r.live.slice(i, i + CHUNK).map((uid) => pushTo(env, uid, ev)));
      told += got.filter((x) => x.status === 'fulfilled').length;
    }
    return { notified: r.notified, told };
  } catch (e) {
    console.warn('creator news', pid, String((e as Error).message || e));
    return { notified: 0, told: 0 };
  }
}
