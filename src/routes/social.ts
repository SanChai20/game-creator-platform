// Friends, chat and invites for the web app (cookie sign-in). The rules are src/social-rules.js; the live side
// (presence, delivery) is the SocialHub (src/social.ts). Games reach the same through /api/rt/friends (src/routes/rt.ts).
import { Hono } from 'hono';
import { AppError, bad, type Env, type User } from '../env';
import { loginIdOf, rateLimit, requireUser } from '../auth';
import { getSettings, type Settings } from '../settings';
import { readLobby } from '../lobby';
import { presenceOfUser, pushTo, socialHub, type Presence } from '../social';
// @ts-ignore plain JS module
import * as R from '../social-rules.js';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
export const social = new Hono<App>();

export function limitsOf(s: Settings) {
  return { ...R.LIMITS, friends_max: Math.max(1, Math.min(2000, Number(s.friends_max) || R.LIMITS.friends_max)) };
}
/** Turns a rules error into the API's error. */
export async function rules<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof R.SocialError) throw new AppError((e as any).status, (e as Error).message, (e as any).code); throw e; }
}
async function enabled(env: Env): Promise<Settings> {
  const s = await getSettings(env);
  if (!s.social_enabled) throw new AppError(403, 'Friends and chat are switched off on this platform.', 'social_off');
  return s;
}
/** The account's profile (made on first use) as the hub needs it. */
async function hubProfile(env: Env, u: { id: string; name: string }) {
  const p = await R.ensureProfile(env.DB, u);
  return { uid: u.id, status: p.status, show_game: p.show_game, joinable: p.joinable, invites_from: p.invites_from };
}

/** Everything a match invite or a "join" carries, from the lobby token (the game's own numbers are ignored). */
export async function lobbyData(env: Env, token: unknown, g: string, e: string, label?: unknown) {
  const l = await readLobby(env, token, g, e);
  if (!l) throw new AppError(409, 'That match has ended or cannot be joined by invite. Open a new one and invite again.', 'lobby_gone');
  return { lobby: token as string, queue: l.q, players: l.n, min: l.m, teams: l.t, ...(l.o ? { mode: l.o } : {}), ...(label != null ? { label } : {}) };
}

/**
 * Sends one invite (from a game through the SDK, or from a platform page) and delivers it. The friend must be online,
 * away or busy as their hub shows them to the sender; a Busy friend gets it quietly (no pop-up, just the badge and chat).
 */
export async function sendInvite(env: Env, s: Settings, from: { id: string; name: string }, to: string, project: string, envName: 'live' | 'preview', data: Record<string, unknown>) {
  if (envName !== 'live') throw new AppError(409, 'Invites work in the live game. In the preview, test with GCP.friends.list() and a private match of your own.', 'preview');
  await rateLimit(env, 'invite:' + from.id, Math.max(1, Number(s.invites_per_10min) || 30), 600);
  const status = (await presenceOfUser(env, to, from.id)).s;
  const kind = data.lobby ? 'match' : 'game';
  const inv = await rules(() => R.createInvite(env.DB, { from: from.id, to, project, env: envName, kind, data, online: status }));
  await pushTo(env, to, { kind: 'invite', quiet: status === 'busy', invite: { id: inv.id, from, game: inv.game, kind, label: inv.label, created_at: inv.created_at, expires_at: inv.expires_at } });
  await pushTo(env, from.id, { kind: 'message', peer: to });
  return { ok: true, id: inv.id, status, expires_at: inv.expires_at };
}

// ---- the live connection --------------------------------------------------------------------------------------------
social.get('/ws', async (c) => {
  const u = requireUser(c), s = await enabled(c.env);
  void s;
  // a WebSocket carries the cookie from any site: only our own pages may open one (cross-site WebSocket hijacking)
  const o = c.req.header('origin');
  if (!o || (o !== c.get('origin') && o !== new URL(c.req.url).origin)) throw new AppError(403, 'Cross-site request refused.', 'csrf');
  if (c.req.header('upgrade') !== 'websocket') throw new AppError(426, 'Expected a WebSocket.', 'upgrade_required');
  if (!c.env.SOCIAL) throw new AppError(501, 'Live updates are not available here.', 'unavailable');
  const hub = socialHub(c.env, u.id);
  await hub.setProfile(await hubProfile(c.env, u));
  const url = new URL(c.req.url);
  url.search = `?uid=${encodeURIComponent(u.id)}&login=${encodeURIComponent((await loginIdOf(c.req.raw)) || '')}&vis=${c.req.query('vis') === '0' ? '0' : '1'}`;
  return hub.fetch(new Request(url, c.req.raw));
});

// What the badge and the panel's top need: my profile and presence, unread counts and invites waiting.
social.get('/summary', async (c) => {
  const u = requireUser(c), s = await getSettings(c.env);
  if (!s.social_enabled) return c.json({ enabled: false });
  const p = await R.ensureProfile(c.env.DB, u);
  const me: Presence = c.env.SOCIAL ? await socialHub(c.env, u.id).self().catch(() => ({ s: 'offline' } as Presence)) : { s: 'offline' };
  const [counts, invites] = await Promise.all([R.counts(c.env.DB, u.id), R.pendingInvites(c.env.DB, u.id)]);
  return c.json({ enabled: true, profile: R.profileView(p), me, counts, invites, limits: { message_max: R.LIMITS.message_max, friends_max: limitsOf(s).friends_max } });
});

social.get('/friends', async (c) => {
  const u = requireUser(c), s = await enabled(c.env);
  const list = await R.listFriends(c.env.DB, u.id, limitsOf(s).friends_max) as { id: string; name: string; since: number }[];
  const pres = c.env.SOCIAL && list.length ? await socialHub(c.env, u.id).snapshot(list.map((f) => f.id)).catch(() => ({} as Record<string, Presence>)) : {};
  const counts = await R.counts(c.env.DB, u.id) as { chats: Record<string, number> };
  return c.json({ friends: list.map((f) => ({ ...f, p: pres[f.id] || { s: 'offline' }, unread: counts.chats[f.id] || 0 })) });
});

social.get('/requests', async (c) => {
  const u = requireUser(c); await enabled(c.env);
  const [req, notes] = await Promise.all([R.listRequests(c.env.DB, u.id), R.notificationList(c.env.DB, u.id)]);
  return c.json({ ...req, notifications: notes });
});
social.post('/notifications/read', async (c) => { const u = requireUser(c); return c.json(await R.markNotificationsRead(c.env.DB, u.id)); });

social.get('/search', async (c) => {
  const u = requireUser(c); await enabled(c.env);
  await rateLimit(c.env, 'fsearch:' + u.id, 60, 60);
  await R.ensureProfile(c.env.DB, u);
  return c.json({ results: await R.search(c.env.DB, u.id, c.req.query('q') || '') });
});

const idParam = (v: string | undefined) => { const id = String(v || ''); if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) throw bad('Unknown player.'); return id; };
const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, any>>().catch(() => ({}))) as Record<string, any>;

social.post('/requests', async (c) => {
  const u = requireUser(c), s = await enabled(c.env), b = await body(c), to = idParam(b.to);
  await rateLimit(c.env, 'freq:' + u.id, Math.max(1, Number(s.friend_requests_per_day) || 50), 86400);
  await R.ensureProfile(c.env.DB, u);
  const r = await rules(() => R.sendRequest(c.env.DB, u.id, to, limitsOf(s)));
  if (r.notify) await pushTo(c.env, to, { kind: 'request', from: { id: u.id, name: u.name } });
  if (r.accepted) await befriended(c.env, u, to);
  return c.json({ state: r.state });
});
async function befriended(env: Env, u: User, other: string) {
  if (env.SOCIAL) await socialHub(env, u.id).befriend(u.id, other).catch((e) => console.warn('befriend', e));
  await pushTo(env, other, { kind: 'accepted', by: { id: u.id, name: u.name } });
}
social.post('/requests/:id/accept', async (c) => {
  const u = requireUser(c), s = await enabled(c.env), from = idParam(c.req.param('id'));
  await R.ensureProfile(c.env.DB, u);
  await rules(() => R.acceptRequest(c.env.DB, u.id, from, limitsOf(s)));
  await befriended(c.env, u, from);
  return c.json({ state: 'friends' });
});
social.post('/requests/:id/decline', async (c) => { const u = requireUser(c), from = idParam(c.req.param('id')); return c.json(await R.declineRequest(c.env.DB, u.id, from)); });
social.delete('/requests/:id', async (c) => {
  const u = requireUser(c), to = idParam(c.req.param('id'));
  const r = await R.cancelRequest(c.env.DB, u.id, to);
  await pushTo(c.env, to, { kind: 'counts' });
  return c.json(r);
});
async function parted(env: Env, a: string, b: string) {
  if (!env.SOCIAL) return;
  await Promise.allSettled([socialHub(env, a).unfriend(b), socialHub(env, b).unfriend(a)]);
}
social.delete('/friends/:id', async (c) => {
  const u = requireUser(c), other = idParam(c.req.param('id'));
  await R.removeFriend(c.env.DB, u.id, other);
  await parted(c.env, u.id, other);
  return c.json({ ok: true });
});
social.get('/blocks', async (c) => { const u = requireUser(c); return c.json({ blocked: await R.listBlocked(c.env.DB, u.id) }); });
social.post('/blocks', async (c) => {
  const u = requireUser(c), b = await body(c), other = idParam(b.id);
  await rules(() => R.block(c.env.DB, u.id, other));
  await parted(c.env, u.id, other);
  return c.json({ ok: true });
});
social.delete('/blocks/:id', async (c) => { const u = requireUser(c); return c.json(await R.unblock(c.env.DB, u.id, idParam(c.req.param('id')))); });

// ---- chat -------------------------------------------------------------------------------------------------------------
social.get('/chat/:id', async (c) => {
  const u = requireUser(c), other = idParam(c.req.param('id'));
  const before = c.req.query('before');
  const rel = await R.relation(c.env.DB, u.id, other);
  const who = await c.env.DB.prepare('SELECT id, name, status FROM users WHERE id = ?').bind(other).first<{ id: string; name: string; status: string }>();
  if (!who) throw new AppError(404, 'No such player.', 'not_found');
  return c.json({ peer: { id: who.id, name: who.status === 'active' ? who.name : 'Deleted account' }, relation: rel, ...(await R.conversation(c.env.DB, u.id, other, (before && /^\d+$/.test(before) ? Number(before) : null) as any)) });
});
social.post('/chat/:id', async (c) => {
  const u = requireUser(c), s = await enabled(c.env), other = idParam(c.req.param('id')), b = await body(c);
  await rateLimit(c.env, 'dm:' + u.id, Math.max(1, Number(s.messages_per_minute) || 30), 60);
  const m = await rules(() => R.sendMessage(c.env.DB, u.id, other, b.body));
  const quiet = (await presenceOfUser(c.env, other, u.id)).s === 'busy';
  await pushTo(c.env, other, { kind: 'message', peer: u.id, from: { id: u.id, name: u.name }, msg: m, quiet });
  await pushTo(c.env, u.id, { kind: 'message', peer: other, msg: m, mine: true });
  return c.json({ message: m });
});
social.post('/chat/:id/read', async (c) => {
  const u = requireUser(c), other = idParam(c.req.param('id'));
  const r = await R.markRead(c.env.DB, u.id, other);
  if (r.read) await pushTo(c.env, u.id, { kind: 'counts' });
  return c.json(r);
});

// ---- invites ----------------------------------------------------------------------------------------------------------
// From a platform page: the friends list ("Invite to <game you are playing>") or the invite picker a game opened over itself
// (GCP.friends.open). lobby: the private lobby the game handed over, when it is a match invite.
social.post('/invites', async (c) => {
  const u = requireUser(c), s = await enabled(c.env), b = await body(c), to = idParam(b.to);
  const p = await c.env.DB.prepare("SELECT id FROM projects WHERE slug = ? AND status = 'live'").bind(String(b.slug || '')).first<{ id: string }>();
  if (!p) throw new AppError(409, 'This game is not live.', 'offline');
  const data = b.lobby ? await lobbyData(c.env, b.lobby, p.id, 'live', b.label) : (b.label != null ? { label: b.label } : {});
  return c.json(await sendInvite(c.env, s, { id: u.id, name: u.name }, to, p.id, 'live', data));
});
social.post('/invites/:id/:answer{accept|decline}', async (c) => {
  const u = requireUser(c), accept = c.req.param('answer') === 'accept';
  const r = await rules(() => R.answerInvite(c.env.DB, u.id, c.req.param('id'), accept));
  await pushTo(c.env, r.from, { kind: 'invite_answer', id: r.invite, by: { id: u.id, name: u.name }, accepted: accept, game: r.game });
  await pushTo(c.env, u.id, { kind: 'counts' });
  return c.json(r);
});
social.delete('/invites/:id', async (c) => {
  const u = requireUser(c), r = await R.cancelInvite(c.env.DB, u.id, c.req.param('id'));
  if (r.to) await pushTo(c.env, r.to, { kind: 'invite_cancelled', id: c.req.param('id') });
  return c.json({ ok: true });
});
// "Join" on a friend who is in a game that offers a place: an accepted invite is recorded for the joiner, and the game
// they open is told (GCP.launch.join) as it would be for an invite.
social.post('/friends/:id/join', async (c) => {
  const u = requireUser(c), s = await enabled(c.env), friend = idParam(c.req.param('id'));
  void s;
  await rateLimit(c.env, 'fjoin:' + u.id, 30, 600);
  const info = c.env.SOCIAL ? await socialHub(c.env, friend).joinInfo(u.id).catch(() => null) : null;
  if (!info) throw new AppError(409, 'There is no place to join right now.', 'not_joinable');
  const data = await lobbyData(c.env, info.lobby, info.game.id, 'live', info.label || undefined);
  const join = await rules(() => R.createJoin(c.env.DB, { me: u.id, friend, project: info.game.id, env: 'live', data }));
  await pushTo(c.env, friend, { kind: 'joining', by: { id: u.id, name: u.name }, game: info.game });
  return c.json({ game: info.game, join });
});

// ---- my profile: status and privacy -------------------------------------------------------------------------------
social.patch('/profile', async (c) => {
  const u = requireUser(c), b = await body(c);
  await R.ensureProfile(c.env.DB, u);
  const v = await rules(() => R.updateProfile(c.env.DB, u.id, b));
  let me: Presence | null = null;
  if (c.env.SOCIAL) me = await socialHub(c.env, u.id).setProfile(await hubProfile(c.env, u)).catch(() => null);
  return c.json({ profile: v, me });
});

// ---- reports ------------------------------------------------------------------------------------------------------------
social.post('/reports', async (c) => {
  const u = requireUser(c), b = await body(c), target = idParam(b.target);
  await rateLimit(c.env, 'sreport:' + u.id, 20, 86400);
  const r = await rules(() => R.report(c.env.DB, u.id, target, String(b.reason || ''), String(b.detail || ''), b.messages));
  // reporting someone also offers to block them; the page asks separately (b.block)
  if (b.block === true) { await rules(() => R.block(c.env.DB, u.id, target)); await parted(c.env, u.id, target); }
  return c.json(r);
});
