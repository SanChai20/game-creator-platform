// The SocialHub: one Durable Object per account, the live side of friends. It holds the account's open platform pages
// (WebSockets, hibernated), works out its presence from them (src/presence.js), pushes that presence to its friends'
// hubs when it changes, keeps the presence its friends pushed to it, and delivers events (a request, a message, an
// invite) to the account's pages the moment they happen. Nothing here is per check-in in the database: a presence
// change costs one read of the friend list and one call per friend, and a friend list costs nothing beyond the list.
//
// Scale: presence is pushed (each change reaches at most friends_max hubs) and kept where it is read, so a page that
// opens its friends list asks one hub, not every friend. A hub with no page open hibernates; one woken by a friend's
// push stores the presence and goes back to sleep. Friend presence older than FRESH_MS is asked for again.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { readLobby } from './lobby';
// @ts-ignore plain JS module
import { OFFLINE_GRACE_MS, nextChange, presenceOf, samePresence } from './presence.js';
// @ts-ignore plain JS module
import { friendIds, gameRef, getProfile } from './social-rules.js';
/** A game as friends see it: its name, and its name in each listing language (src/social-rules.js gameRef). */
type GameRef = { id: string; slug: string; title: string; lang?: string; i18n?: Record<string, { title: string }> };

export interface Presence { s: 'online' | 'away' | 'busy' | 'offline' | 'invisible'; chosen?: string; game?: GameRef; since?: number; detail?: string; joinable?: boolean }
interface Act { g: GameRef; since: number; detail?: string; lobby?: string; label?: string }
interface Page { uid: string; login: string; vis: boolean; hidAt: number | null; at: number; act: Act | null; actAt: number }
interface Prof { status: string; show_game: number; joinable: number; invites_from: string }

const FRESH_MS = 10 * 60 * 1000, CHECK_MS = 5 * 60 * 1000, FANOUT_CHUNK = 25;
const DETAIL_MAX = 60;

export const socialHub = (env: Env, uid: string) => env.SOCIAL!.get(env.SOCIAL!.idFromName(uid)) as unknown as DurableObjectStub<SocialHub>;
/** Delivers an event to an account's open pages. Never fails the caller: a hub that cannot be reached misses it, and the
    page catches up from the database when it next opens its friends. Returns how many pages got it. */
export async function pushTo(env: Env, uid: string, ev: Record<string, unknown>): Promise<number> {
  if (!env.SOCIAL) return 0;
  try { return await socialHub(env, uid).push(ev); } catch (e) { console.warn('social push', String((e as Error).message || e)); return 0; }
}
/** What `viewer` sees of `uid` right now. Offline when unknown. */
export async function presenceOfUser(env: Env, uid: string, viewer: string): Promise<Presence> {
  if (!env.SOCIAL) return { s: 'offline' };
  try { return await socialHub(env, uid).presenceFor(viewer); } catch { return { s: 'offline' }; }
}

export class SocialHub extends DurableObject<Env> {
  private uid: string | null = null;
  private prof: Prof | null = null;
  private cache: Record<string, { p: Presence; at: number }> | null = null;

  private pages(): { ws: WebSocket; p: Page }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, p: ws.deserializeAttachment() as Page })).filter((x) => x.p && x.p.uid);
  }
  private send(ws: WebSocket, m: unknown) { try { ws.send(JSON.stringify(m)); } catch { /* closing */ } }
  private sendAll(m: unknown): number { const all = this.pages(); for (const { ws } of all) this.send(ws, m); return all.length; }
  private async me(uid?: string): Promise<string> {
    if (!this.uid) this.uid = (await this.ctx.storage.get<string>('uid')) || null;
    if (!this.uid && uid) { this.uid = uid; await this.ctx.storage.put('uid', uid); }
    return this.uid || '';
  }
  private async profile(): Promise<Prof> {
    if (!this.prof) this.prof = (await this.ctx.storage.get<Prof>('prof')) || null;
    if (!this.prof) {
      const uid = await this.me();
      const p = uid ? await getProfile(this.env.DB, uid).catch(() => null) as Prof | null : null;
      this.prof = { status: p?.status || 'online', show_game: p ? p.show_game : 1, joinable: p ? p.joinable : 1, invites_from: p?.invites_from || 'friends' };
      await this.ctx.storage.put('prof', this.prof);
    }
    return this.prof;
  }
  private async friendsCache() {
    if (!this.cache) this.cache = (await this.ctx.storage.get<Record<string, { p: Presence; at: number }>>('fp')) || {};
    return this.cache;
  }
  private async computed(t = Date.now()) {
    return presenceOf(this.pages().map((x) => x.p), await this.profile(), t) as { self: Presence; shown: Presence };
  }

  /** A platform page opens (src/routes/social.ts checked the sign-in and the page's origin). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const q = new URL(request.url).searchParams, uid = q.get('uid') || '', login = q.get('login') || '';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (!uid || (await this.me(uid)) !== uid) { pair[1].close(4000, 'Bad request'); return new Response(null, { status: 101, webSocket: pair[0] }); }
    if (this.pages().length >= 20) { const oldest = this.pages().sort((a, b) => a.p.at - b.p.at)[0]; try { oldest.ws.close(4003, 'Too many pages open'); } catch { /* closed */ } }
    const page: Page = { uid, login, vis: q.get('vis') !== '0', hidAt: q.get('vis') === '0' ? Date.now() : null, at: Date.now(), act: null, actAt: 0 };
    pair[1].serializeAttachment(page);
    const { self } = await this.computed();
    this.send(pair[1], { t: 'hello', me: self });
    await this.changed();
    await this.schedule();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const page = ws.deserializeAttachment() as Page | null;
    if (!page || typeof raw !== 'string' || raw.length > 2000) return;
    let m: { t?: string; vis?: boolean; slug?: string | null; detail?: string; lobby?: string; label?: string };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') { this.send(ws, { t: 'pong' }); return; }
    if (m.t === 'vis') {
      const vis = !!m.vis;
      if (vis === page.vis) return;
      page.vis = vis; page.hidAt = vis ? null : Date.now(); ws.serializeAttachment(page);
      await this.changed(); await this.schedule(); return;
    }
    if (m.t === 'act') {
      // what this page is playing: a live game by its slug (null when it closed the game), and what the game says
      if (!m.slug) { if (!page.act) return; page.act = null; page.actAt = Date.now(); ws.serializeAttachment(page); await this.changed(); return; }
      const slug = String(m.slug).slice(0, 80);
      let g = page.act?.g.slug === slug ? page.act.g : null;
      if (!g) {
        const r = await this.env.DB.prepare("SELECT id, slug, title, listing_i18n, listing_lang, langs FROM projects WHERE slug = ? AND status = 'live'").bind(slug).first<{ id: string; slug: string; title: string }>().catch(() => null);
        if (!r) return;
        g = gameRef(r) as GameRef;   // with its name in each listing language, so every friend sees it in theirs
      }
      const detail = typeof m.detail === 'string' ? m.detail.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, DETAIL_MAX) : '';
      // a place to join, only for a genuine lobby of this game (the token is signed by the platform for this game)
      const lobby = m.lobby && (await readLobby(this.env, m.lobby, g.id, 'live')) ? String(m.lobby) : '';
      const since = page.act && page.act.g.id === g.id ? page.act.since : Date.now();
      const act: Act = { g, since, ...(detail ? { detail } : {}), ...(lobby ? { lobby, label: typeof m.label === 'string' ? m.label.slice(0, 60) : '' } : {}) };
      if (JSON.stringify(act) === JSON.stringify(page.act)) return;
      page.act = act; page.actAt = Date.now(); ws.serializeAttachment(page);
      await this.changed();
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> { try { ws.serializeAttachment(null); } catch { /* closed */ } await this.later(OFFLINE_GRACE_MS); }
  async webSocketError(ws: WebSocket): Promise<void> { try { ws.serializeAttachment(null); } catch { /* closed */ } await this.later(OFFLINE_GRACE_MS); }

  private async later(ms: number) {
    const at = Date.now() + ms, cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > at) await this.ctx.storage.setAlarm(at);
  }
  private async schedule() {
    const next = nextChange(this.pages().map((x) => x.p), await this.profile());
    await this.later(next ? Math.max(1000, next - Date.now() + 500) : CHECK_MS);
  }

  async alarm(): Promise<void> {
    const pages = this.pages(), t = Date.now();
    // pages of a sign-in that ended (signed out elsewhere, expired, suspended) close; checked every few minutes
    const lastCheck = (await this.ctx.storage.get<number>('checked')) || 0;
    if (pages.length && t - lastCheck >= CHECK_MS - 1000) {
      await this.ctx.storage.put('checked', t);
      for (const { ws, p } of pages) {
        const ok = await this.env.DB.prepare("SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.status = 'active'").bind(p.login, p.uid, t).first().catch(() => true);
        if (!ok) { ws.serializeAttachment(null); try { ws.close(4001, 'Signed out'); } catch { /* closed */ } }
      }
    }
    await this.changed(t);
    if (this.pages().length) await this.schedule();
  }

  /** Works out the presence again; when what friends see changed, tells every friend's hub (and this account's pages). */
  private async changed(t = Date.now()): Promise<void> {
    const { self, shown } = await this.computed(t);
    const lastSelf = await this.ctx.storage.get<Presence>('self');
    if (!samePresence(lastSelf, self)) { await this.ctx.storage.put('self', self); this.sendAll({ t: 'me', me: self }); }
    const last = await this.ctx.storage.get<Presence>('shown');
    if (samePresence(last, shown)) return;
    await this.ctx.storage.put('shown', shown);
    await this.fanout(shown);
  }
  private async fanout(shown: Presence) {
    const uid = await this.me(); if (!uid) return;
    const ids: string[] = await friendIds(this.env.DB, uid).catch(() => []);
    const cache = await this.friendsCache(), t = Date.now();
    for (let i = 0; i < ids.length; i += FANOUT_CHUNK) {
      const part = ids.slice(i, i + FANOUT_CHUNK);
      const got = await Promise.allSettled(part.map((f) => socialHub(this.env, f).peer(uid, shown)));
      got.forEach((r, j) => { if (r.status === 'fulfilled') cache[part[j]] = { p: r.value, at: t }; });
    }
    await this.ctx.storage.put('fp', cache);
  }

  // ----- calls from the Worker and from other hubs --------------------------------------------------------------
  /** A friend's hub says what it shows now; answers with what this account shows (so both stay current). */
  async peer(from: string, p: Presence): Promise<Presence> {
    const cache = await this.friendsCache(), prev = cache[from]?.p;
    cache[from] = { p, at: Date.now() };
    await this.ctx.storage.put('fp', cache);
    if (!samePresence(prev, p)) this.sendAll({ t: 'presence', id: from, p });
    return (await this.computed()).shown;
  }
  /** What a friend sees of this account. */
  async presenceFor(_viewer: string): Promise<Presence> { return (await this.computed()).shown; }
  /** What the account sees of itself (Invisible included). */
  async self(): Promise<Presence> { return (await this.computed()).self; }
  /** The presence of these friends, asking any whose news here is old. */
  async snapshot(ids: string[]): Promise<Record<string, Presence>> {
    const uid = await this.me(); const cache = await this.friendsCache(), t = Date.now(), out: Record<string, Presence> = {};
    const stale = ids.filter((id) => !cache[id] || t - cache[id].at > FRESH_MS);
    for (let i = 0; i < stale.length; i += FANOUT_CHUNK) {
      const part = stale.slice(i, i + FANOUT_CHUNK);
      const got = await Promise.allSettled(part.map((f) => socialHub(this.env, f).presenceFor(uid)));
      got.forEach((r, j) => { cache[part[j]] = { p: r.status === 'fulfilled' ? r.value : { s: 'offline' }, at: t }; });
    }
    if (stale.length) await this.ctx.storage.put('fp', cache);
    for (const id of ids) out[id] = cache[id]?.p || { s: 'offline' };
    return out;
  }
  /** An event for this account's pages. */
  async push(ev: Record<string, unknown>): Promise<number> { return this.sendAll({ t: 'event', ev }); }
  /** The account changed its status or privacy: presence again, and friends told when it shows differently now. */
  async setProfile(p: Prof & { uid: string }): Promise<Presence> {
    await this.me(p.uid);
    this.prof = { status: p.status, show_game: p.show_game, joinable: p.joinable, invites_from: p.invites_from };
    await this.ctx.storage.put('prof', this.prof);
    await this.changed();
    return (await this.computed()).self;
  }
  /** A new friend: both hubs learn each other's presence at once. */
  async befriend(uid: string, friend: string): Promise<void> {
    await this.me(uid);
    const shown = (await this.computed()).shown;
    const theirs = await socialHub(this.env, friend).peer(uid, shown).catch(() => ({ s: 'offline' } as Presence));
    const cache = await this.friendsCache(); cache[friend] = { p: theirs, at: Date.now() };
    await this.ctx.storage.put('fp', cache);
    this.sendAll({ t: 'presence', id: friend, p: theirs });
    this.sendAll({ t: 'event', ev: { kind: 'friends' } });
  }
  /** No longer friends (removed or blocked): forget their presence. */
  async unfriend(friend: string): Promise<void> {
    const cache = await this.friendsCache(); delete cache[friend];
    await this.ctx.storage.put('fp', cache);
    this.sendAll({ t: 'event', ev: { kind: 'friends' } });
  }
  /** The place a friend may join, if this account is in a game that offers one and lets friends join. */
  async joinInfo(_viewer: string): Promise<{ game: { id: string; slug: string; title: string }; lobby: string; label: string } | null> {
    const prof = await this.profile();
    if (!prof.joinable || prof.invites_from === 'nobody' || prof.status === 'invisible') return null;
    const pages = this.pages().filter((x) => x.p.act && x.p.act.lobby).sort((a, b) => b.p.actAt - a.p.actAt);
    const a = pages[0]?.p.act;
    return a && a.lobby ? { game: a.g, lobby: a.lobby, label: a.label || '' } : null;
  }
  /** Signing out in this browser closes that sign-in's pages at once. */
  async closeLogin(login: string): Promise<void> {
    for (const { ws, p } of this.pages()) if (p.login === login) { ws.serializeAttachment(null); try { ws.close(4001, 'Signed out'); } catch { /* closed */ } }
    await this.later(1000);
  }
}
