// Wishlist news (src/wishlist.js): a wished-for game's first release, and a sale on one, under the bell and by push.
import type { Env } from './env';
import { pushTo } from './social';
import { gameRef } from './social-rules.js';
// @ts-ignore plain JS module
import { released, tellWishers } from './wishlist.js';

const CHUNK = 50;

async function push(env: Env, pid: string, kind: 'wish_release' | 'wish_sale', live: string[]): Promise<number> {
  if (!live.length) return 0;
  const p = await env.DB.prepare('SELECT id, slug, title, listing_i18n, listing_lang, langs FROM projects WHERE id = ?').bind(pid).first<Record<string, any>>();
  if (!p) return 0;
  const ev = { kind, game: gameRef(p) };
  let told = 0;
  for (let i = 0; i < live.length; i += CHUNK) {
    const got = await Promise.allSettled(live.slice(i, i + CHUNK).map((uid) => pushTo(env, uid, ev)));
    told += got.filter((x) => x.status === 'fulfilled').length;
  }
  return told;
}

/** A game's first release: its coming soon page ends, and everyone who wished for it hears. Never throws. */
export async function wishReleased(env: Env, pid: string): Promise<{ notified: number; told: number }> {
  try {
    const r = await released(env.DB, pid) as { notified: number; live: string[] };
    return { notified: r.notified, told: await push(env, pid, 'wish_release', r.live) };
  } catch (e) { console.warn('wishlist release', pid, String((e as Error).message || e)); return { notified: 0, told: 0 }; }
}

/** A sale started on a paid game: once per sale (keyed by its start), to those who wished for it. Never throws. */
export async function wishSale(env: Env, pid: string, saleStart: number): Promise<{ notified: number; told: number }> {
  try {
    const r = await tellWishers(env.DB, pid, 'wish_sale', String(saleStart)) as { notified: number; live: string[] };
    return { notified: r.notified, told: await push(env, pid, 'wish_sale', r.live) };
  } catch (e) { console.warn('wishlist sale', pid, String((e as Error).message || e)); return { notified: 0, told: 0 }; }
}
