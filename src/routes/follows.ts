// Creator profiles, following creators, and the notification feed under the bell (cookie sign-in). The rules are
// src/follows.js; a creator's games come from the store's list (GET /api/games?by=<id>, src/routes/api.ts).
import { Hono } from 'hono';
import { AppError, type Env, type User } from '../env';
import { rateLimit, requireUser } from '../auth';
import { listingLangs } from '../listing';
import { matureList } from '../mature';
// @ts-ignore plain JS module
import * as FR from '../follows.js';
const F = FR as any;   // plain JS: its argument types are not inferred usefully

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
export const follows = new Hono<App>();

/** Turns a rules error into the API's error. */
async function rules<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof F.FollowError) throw new AppError((e as any).status, (e as Error).message, (e as any).code); throw e; }
}
const media = (origin: string, key: string | null) => (key ? `${origin}/api/media/${key}` : null);

// ---- profiles ---------------------------------------------------------------------------------------------------------
// Public: anyone may look at a creator's profile. Only the follow state depends on who asks, so the answer is never shared.
follows.get('/creators/:id', async (c) => {
  const id = c.req.param('id'), me = c.get('user');
  const p = await F.profile(c.env.DB, id, me?.id || null);
  if (!p) throw new AppError(404, 'No such creator.', 'not_found');
  c.header('cache-control', 'private, no-store');
  return c.json(p);
});

// Following and unfollowing: a player can change their mind, but a script cannot churn the table.
const followLimit = (env: Env, u: User) => rateLimit(env, 'follow:' + u.id, 30, 600);
follows.post('/creators/:id/follow', async (c) => {
  const u = requireUser(c); await followLimit(c.env, u);
  return c.json(await rules(() => F.follow(c.env.DB, u.id, c.req.param('id'))));
});
follows.delete('/creators/:id/follow', async (c) => {
  const u = requireUser(c); await followLimit(c.env, u);
  return c.json(await rules(() => F.unfollow(c.env.DB, u.id, c.req.param('id'))));
});
import { pageMeta, parsePage } from '../paging';

follows.get('/me/following', async (c) => {
  const u = requireUser(c), pg = parsePage((k) => c.req.query(k), 24, 100);
  const { following, total } = await F.followingPage(c.env.DB, u.id, { limit: pg.limit, offset: pg.offset });
  return c.json({ following, ...pageMeta(total, pg.page, pg.per_page) });
});

// ---- the bell ---------------------------------------------------------------------------------------------------------
follows.get('/notifications', async (c) => {
  const u = requireUser(c), origin = c.get('origin'), before = c.req.query('before');
  const [page, unread] = await Promise.all([
    F.feed(c.env.DB, u.id, { limit: Number(c.req.query('limit')) || 20, before: before && /^\d{1,15}$/.test(before) ? Number(before) : null }),
    F.unreadCount(c.env.DB, u.id),
  ]) as [{ items: any[]; more: number | null }, number];
  const items = page.items.map((n) => {
    const g = n.game;
    return {
      id: n.id, kind: n.kind, at: n.at, read: n.read, actor: n.actor, data: n.data,
      game: g ? { id: g.id, slug: g.slug, title: g.title, tagline: g.tagline, cover: media(origin, g.cover_key), live: g.live, mature: matureList(g), ...listingLangs(g, ['title', 'tagline'], (k) => media(origin, k)) } : null,
    };
  });
  c.header('cache-control', 'private, no-store');
  return c.json({ unread, items, more: page.more });
});
follows.get('/notifications/count', async (c) => {
  const u = requireUser(c);
  c.header('cache-control', 'private, no-store');
  return c.json({ unread: await F.unreadCount(c.env.DB, u.id) });
});
follows.post('/notifications/read', async (c) => { const u = requireUser(c); return c.json(await rules(() => F.markRead(c.env.DB, u.id, null))); });
follows.post('/notifications/:id/read', async (c) => { const u = requireUser(c); return c.json(await rules(() => F.markRead(c.env.DB, u.id, c.req.param('id')))); });
