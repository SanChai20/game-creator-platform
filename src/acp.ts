// The ACP workbench: a creator's own coding agent, running on their machine, used from the console.
//
// MCP brings the platform into the creator's agent (the agent calls HearthCade's tools). ACP, the Agent Client Protocol,
// goes the other way: the console becomes the agent's client, the way an editor such as Zed is. The platform hosts no
// agent. A small bridge on the creator's machine (acp-bridge/, served at /acp/hearthcade-acp-<version>.tgz and started
// with npx) runs the agent, speaks ACP with it and relays the conversation through this Worker to the console.
//
//   bridge ── wss /acp/v1/ws (link secret) ──▶ AcpHub (one per account) ◀── wss /api/acp/ws (session cookie) ── pages
//
// The hub is a switchboard and keeps nothing but who is connected: transcripts and the agent's state live in the bridge
// (acp-bridge/core.mjs), which replays them to each page that joins. Several bridges (agents, machines) and several pages
// can be connected at once.
//
// A machine connects once (a pair: the bridge shows a code, the creator approves it in the console) and gets a link,
// a secret kept on the machine. Each run of a bridge is given its own MCP grant for the account (scoped to the projects the
// link allows), used through a local proxy in the bridge, and revoked when the bridge stops or the link is removed.
import { DurableObject } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { AppError, bad, notFound, type Env, type User } from './env';
import { rateLimit, requireUser, userById } from './auth';
import { getSettings } from './settings';
import { b64u, now, sha256, token } from './util';
import { listSelectableProjects, parseStoredProjectIds, resolveAllowedProjects } from './mcp/scope';
import type { TokenExchange } from './routes/device';
import BRIDGE_PKG from '../acp-bridge/package.json';
import REGISTRY_SNAPSHOT from '../acp-bridge/registry.json';
import { TOOLS } from './mcp/tools';

export const BRIDGE_VERSION: string = BRIDGE_PKG.version;
export const BRIDGE_FILE = `hearthcade-acp-${BRIDGE_VERSION}.tgz`;
const PAIR_TTL_S = 900, PAIR_INTERVAL_S = 3, LINK_TTL_DAYS = 90;
const MAX_VIEWS = 24, MAX_BRIDGES = 8;
const MAX_VIEW_MSG = 16 * 1024 * 1024, MAX_BRIDGE_MSG = 32 * 1024 * 1024;
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
type LinkRow = { id: string; user_id: string; host: string; os: string | null; project_ids: string | null; created_at: number; last_used_at: number | null; expires_at: number; revoked_at: number | null };
type PairRow = { id: string; code: string; host: string; agent: string; cwd: string | null; os: string | null; status: string; user_id: string | null; project_ids: string | null; created_at: number; expires_at: number; last_poll_at: number; req_place: string | null; req_country: string | null };

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const noStore = { 'cache-control': 'no-store' };
export const acpHub = (env: Env, uid: string) => env.ACP!.get(env.ACP!.idFromName(uid)) as unknown as DurableObjectStub<AcpHub>;

function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = ''; for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
export function normalizePairCode(raw: string): string {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : '';
}
function placeOf(req: Request): { place: string | null; country: string | null } {
  const cf = (req as unknown as { cf?: { city?: string; country?: string } }).cf || {};
  const country = typeof cf.country === 'string' ? cf.country.slice(0, 2) : null;
  const city = typeof cf.city === 'string' ? clean(cf.city, 60) : '';
  return { place: [city, country].filter(Boolean).join(', ') || null, country };
}

/** The command a creator runs to start a bridge (the console shows it with the agent filled in). */
export function bridgeCommand(origin: string, agentId = '<agent>'): string {
  const extra = origin === 'https://hearthcade.com' ? '' : ` --server ${origin}`;
  return `npx -y ${origin}/acp/${BRIDGE_FILE} ${agentId}${extra}`;
}

/** What the agent is told about where it is, when it accepts system instructions. */
function systemPrompt(origin: string, user: User, projects: { title: string; slug: string | null }[] | null): string {
  const scope = projects === null
    ? `every project in ${user.name}'s account`
    : `only these projects: ${projects.map((p) => `${p.title}${p.slug ? ` (${p.slug})` : ''}`).join(', ') || '(none)'}`;
  return [
    `You are running inside the HearthCade workbench (${origin}/console/workbench): ${user.name} is talking to you from the HearthCade console, and you work in this folder on their machine.`,
    `The "hearthcade" MCP server gives you HearthCade's tools for ${scope}. Call its get_started tool before creating, deploying or publishing a game, and follow what it returns.`,
    'HearthCade hosts web games only (HTML, JavaScript, CSS, WebAssembly that run in a browser page). Deploy previews to check your work; publish only when the user asks.',
  ].join('\n');
}

async function linkBySecret(env: Env, req: Request): Promise<{ link: LinkRow; user: User }> {
  const h = req.headers.get('authorization') || '';
  const secret = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!secret) throw new AppError(401, 'This machine is not connected. Run the command again to connect it.', 'unauthenticated');
  const link = await env.DB.prepare('SELECT * FROM acp_links WHERE secret_hash = ?').bind(await sha256(secret)).first<LinkRow>();
  if (!link || link.revoked_at || link.expires_at < now()) throw new AppError(401, 'This machine\'s connection was removed or has expired. Run the command again to connect it.', 'unauthenticated');
  const user = await userById(env, link.user_id);
  if (!user || user.status !== 'active') throw new AppError(403, 'This account is not active.', 'forbidden');
  if (!user.creator) throw new AppError(403, 'The workbench is part of the creator console: get a creator license first.', 'license_required');
  return { link, user };
}

async function revokeBridgeGrant(env: Env, bridgeId: string, userId: string) {
  const row = await env.DB.prepare('UPDATE acp_bridges SET stopped_at = COALESCE(stopped_at, ?) WHERE id = ? AND user_id = ? RETURNING grant_id').bind(now(), bridgeId, userId).first<{ grant_id: string | null }>();
  if (row?.grant_id) await env.OAUTH_PROVIDER.revokeGrant(row.grant_id, userId).catch(() => {});
}

// ----- machine endpoints (the bridge): /acp/v1 -------------------------------------------------------------------------
export function acpMachine(exchange: TokenExchange) {
  const r = new Hono<App>();
  const body = async (c: Context<App>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // 1. The bridge asks to connect this machine: it gets a code to show and a secret to poll with.
  r.post('/pair', async (c) => {
    const p = await body(c), origin = c.get('origin');
    await rateLimit(c.env, 'acppair:' + (c.req.header('cf-connecting-ip') || 'x'), 20, 600);
    const poll = token(32), t = now(), from = placeOf(c.req.raw);
    let code = '';
    for (let i = 0; i < 5 && !code; i++) {
      const cand = newCode();
      const ins = await c.env.DB.prepare('INSERT OR IGNORE INTO acp_pairs (id, code, host, agent, cwd, os, created_at, expires_at, req_place, req_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(await sha256(poll), cand, clean(p.host, 60) || 'Computer', clean(p.agent, 60) || 'Agent', clean(p.cwd, 300) || null, clean(p.os, 20) || null, t, t + PAIR_TTL_S * 1000, from.place, from.country).run();
      if (ins.meta.changes) code = cand;
    }
    if (!code) throw new AppError(503, 'Could not create a code. Try again.', 'busy');
    return c.json({ code, poll, url: `${origin}/console/workbench?pair=${code}`, interval: PAIR_INTERVAL_S, expires_in: PAIR_TTL_S }, 200, noStore);
  });

  // 2. It polls until the creator approved in the console, then receives the link's secret, once.
  r.post('/pair/token', async (c) => {
    const p = await body(c), t = now();
    const id = await sha256(String(p.poll || ''));
    const row = await c.env.DB.prepare('SELECT * FROM acp_pairs WHERE id = ?').bind(id).first<PairRow>();
    if (!row || row.expires_at < t || row.status === 'used') return c.json({ error: 'expired_token' }, 400, noStore);
    if (row.status === 'denied') return c.json({ error: 'access_denied' }, 400, noStore);
    if (row.status === 'pending') {
      const fast = t - row.last_poll_at < 1000;
      await c.env.DB.prepare('UPDATE acp_pairs SET last_poll_at = ? WHERE id = ?').bind(t, id).run();
      return c.json({ error: fast ? 'slow_down' : 'authorization_pending' }, 400, noStore);
    }
    const claim = await c.env.DB.prepare("UPDATE acp_pairs SET status = 'used' WHERE id = ? AND status = 'approved'").bind(id).run();
    if (!claim.meta.changes) return c.json({ error: 'expired_token' }, 400, noStore);
    const user = row.user_id ? await userById(c.env, row.user_id) : null;
    if (!user || user.status !== 'active') return c.json({ error: 'access_denied' }, 400, noStore);
    const secret = 'hcw_' + token(32), linkId = 'acl_' + token(12);
    await c.env.DB.prepare('INSERT INTO acp_links (id, user_id, secret_hash, host, os, project_ids, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(linkId, user.id, await sha256(secret), row.host, row.os, row.project_ids, t, t, t + LINK_TTL_DAYS * 86400_000).run();
    return c.json({ link: linkId, secret, user: user.name }, 200, noStore);
  });

  // 3. A bridge starts: it gets the relay address and an MCP grant of its own for the account.
  r.post('/bridges', async (c) => {
    const { link, user } = await linkBySecret(c.env, c.req.raw), p = await body(c), origin = c.get('origin');
    await rateLimit(c.env, 'acpstart:' + link.id, 60, 3600);
    const bridgeId = clean(p.bridge, 64);
    if (!/^[\w-]{8,64}$/.test(bridgeId)) throw bad('bridge is required.');
    const running = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM acp_bridges WHERE user_id = ? AND stopped_at IS NULL AND created_at > ?').bind(user.id, now() - 7 * 86400_000).first<{ n: number }>();
    if ((running?.n || 0) >= 50) {
      // bridges that died without saying so: retire the oldest so the account never piles up grants
      const old = await c.env.DB.prepare('SELECT id FROM acp_bridges WHERE user_id = ? AND stopped_at IS NULL ORDER BY created_at LIMIT 10').bind(user.id).all<{ id: string }>();
      for (const o of old.results) await revokeBridgeGrant(c.env, o.id, user.id);
    }
    const agent = clean(p.agent, 60) || 'Agent', host = clean(p.host, 60) || link.host;
    const projectIds = parseStoredProjectIds(link.project_ids);
    // keep the scope to projects that still exist and are still the creator's
    const allowed = projectIds === null ? null : (await listSelectableProjects(c.env, user.id)).filter((x) => projectIds.includes(x.id));

    // Issue tokens through the ordinary authorization-code path (as device sign-in does): listed, expiring, revocable.
    const client = `Workbench · ${agent} · ${host}`.slice(0, 80);
    const redirectUri = `${origin}/oauth/code`, resource = `${origin}/mcp`;
    const oc = await c.env.OAUTH_PROVIDER.createClient({ clientName: client, redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] });
    const verifier = token(32), challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const ids = allowed ? allowed.map((x) => x.id) : null;
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: { responseType: 'code', clientId: oc.clientId, redirectUri, scope: ['games'], state: 'acp', codeChallenge: challenge, codeChallengeMethod: 'S256', resource },
      userId: user.id,
      metadata: { client, via: 'workbench', link: link.id, bridge: bridgeId, ...(ids ? { projectIds: ids } : {}) },
      scope: ['games'],
      props: { userId: user.id, client, ...(ids ? { projectIds: ids } : {}) },
    });
    const code = new URL(redirectTo).searchParams.get('code') || '';
    const res = await exchange(c.env, c.executionCtx as ExecutionContext, origin, new URLSearchParams({ grant_type: 'authorization_code', code, client_id: oc.clientId, redirect_uri: redirectUri, code_verifier: verifier, resource }));
    const tokens = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!res.ok || typeof tokens.access_token !== 'string') throw new AppError(500, 'Could not issue the agent\'s access. Try again.', 'internal');
    const grantId = String(tokens.access_token).split(':')[1] || null;
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR REPLACE INTO acp_bridges (id, link_id, user_id, grant_id, agent, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(bridgeId, link.id, user.id, grantId, agent, clean(p.cwd, 300) || null, now()),
      c.env.DB.prepare('UPDATE acp_links SET last_used_at = ?, host = ? WHERE id = ?').bind(now(), host, link.id),
    ]);
    const wsOrigin = origin.replace(/^http/, 'ws');
    return c.json({
      ws: `${wsOrigin}/acp/v1/ws?bridge=${encodeURIComponent(bridgeId)}`,
      workbench: `${origin}/console/workbench`,
      user: user.name,
      scope: allowed === null ? 'all projects' : allowed.length === 1 ? allowed[0].title : `${allowed.length} projects`,
      system_prompt: systemPrompt(origin, user, allowed),
      // the platform tools that only read: the bridge lets an agent use them without a permission check of its own
      read_only_tools: TOOLS.filter((x) => x.annotations?.readOnlyHint).map((x) => x.name),
      mcp: { url: resource, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in, client_id: oc.clientId, token_endpoint: `${origin}/oauth/token` },
    }, 200, noStore);
  });

  r.post('/bridges/:id/stop', async (c) => {
    const { user } = await linkBySecret(c.env, c.req.raw);
    await revokeBridgeGrant(c.env, c.req.param('id'), user.id);
    return c.json({ ok: true }, 200, noStore);
  });

  // 4. The bridge's end of the relay.
  r.get('/ws', async (c) => {
    if (!c.env.ACP) throw new AppError(501, 'The workbench is not available here.', 'unavailable');
    // Credentials first: a bridge whose socket would not open asks with a plain GET whether it was disconnected (401)
    // the run ended (410) or the server is just busy (426), because a refused WebSocket upgrade carries no status it can read.
    const { link, user } = await linkBySecret(c.env, c.req.raw);
    const bridgeId = clean(c.req.query('bridge'), 64);
    if (!/^[\w-]{8,64}$/.test(bridgeId)) throw bad('bridge is required.');
    const known = await c.env.DB.prepare('SELECT stopped_at FROM acp_bridges WHERE id = ? AND link_id = ?').bind(bridgeId, link.id).first<{ stopped_at: number | null }>();
    if (!known || known.stopped_at) throw new AppError(410, 'This run of the bridge has ended. Start it again.', 'gone');
    if (c.req.header('upgrade') !== 'websocket') throw new AppError(426, 'Expected a WebSocket.', 'upgrade_required');
    const url = new URL(c.req.url);
    url.search = `?kind=bridge&uid=${encodeURIComponent(user.id)}&id=${encodeURIComponent(bridgeId)}&link=${encodeURIComponent(link.id)}`;
    return acpHub(c.env, user.id).fetch(new Request(url, c.req.raw));
  });
  return r;
}

// ----- the console's endpoints: /api/acp --------------------------------------------------------------------------------
export const acpApi = new Hono<App>();
function creatorOnly(c: Context<App>): User {
  const u = requireUser(c as any);
  if (!u.creator) throw new AppError(403, 'The workbench is part of the creator console: get a creator license first.', 'license_required');
  return u;
}

acpApi.get('/overview', async (c) => {
  const u = creatorOnly(c), origin = c.get('origin');
  const [links, projects] = await Promise.all([
    c.env.DB.prepare('SELECT id, host, os, project_ids, created_at, last_used_at, expires_at FROM acp_links WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 50').bind(u.id, now()).all<LinkRow>(),
    listSelectableProjects(c.env, u.id),
  ]);
  const title = new Map(projects.map((p) => [p.id, p]));
  return c.json({
    command: bridgeCommand(origin), command_base: bridgeCommand(origin, '').trimEnd(), version: BRIDGE_VERSION, server: origin,
    links: links.results.map((l) => {
      const ids = parseStoredProjectIds(l.project_ids);
      return { id: l.id, host: l.host, os: l.os, created_at: l.created_at, last_used_at: l.last_used_at, expires_at: l.expires_at,
        project_scope: ids === null ? 'all' : 'selected', projects: ids === null ? null : ids.map((id) => title.get(id)).filter(Boolean).map((p) => ({ id: p!.id, title: p!.title, slug: p!.slug })) };
    }),
    projects: projects.slice(0, 200).map((p) => ({ id: p.id, title: p.title, slug: p.slug, status: p.status })),
  });
});

async function pendingPair(c: Context<App>): Promise<PairRow> {
  const u = creatorOnly(c);
  await rateLimit(c.env, 'acpcode:' + u.id, 30, 600);
  const code = normalizePairCode(c.req.param('code') || '');
  if (!code) throw bad('That code is not complete. It looks like ABCD-EFGH.');
  const row = await c.env.DB.prepare('SELECT * FROM acp_pairs WHERE code = ?').bind(code).first<PairRow>();
  if (!row || row.expires_at < now() || row.status !== 'pending') throw notFound('That code is not valid any more. Run the command again.');
  return row;
}
acpApi.get('/pair/:code', async (c) => {
  const row = await pendingPair(c), u = creatorOnly(c);
  const here = placeOf(c.req.raw).country, elsewhere = !!(row.req_country && here && row.req_country !== here);
  return c.json({ code: row.code, host: row.host, agent: row.agent, cwd: row.cwd, os: row.os, from: row.req_place, elsewhere, created_at: row.created_at, expires_at: row.expires_at, projects: (await listSelectableProjects(c.env, u.id)).slice(0, 500) });
});
acpApi.post('/pair/:code', async (c) => {
  const row = await pendingPair(c), u = creatorOnly(c);
  const b = await c.req.json<{ decision?: string; project_scope?: string; project_ids?: string[] }>().catch(() => ({} as { decision?: string; project_scope?: string; project_ids?: string[] }));
  const status = b.decision === 'approve' ? 'approved' : 'denied';
  let ids: string | null = null;
  if (status === 'approved' && b.project_scope === 'selected') ids = JSON.stringify(await resolveAllowedProjects(c.env, u.id, b.project_ids));
  const r = await c.env.DB.prepare("UPDATE acp_pairs SET status = ?, user_id = ?, project_ids = ? WHERE id = ? AND status = 'pending' AND expires_at > ?").bind(status, u.id, ids, row.id, now()).run();
  if (!r.meta.changes) throw notFound('That code is not valid any more. Run the command again.');
  return c.json({ ok: true, status });
});

acpApi.delete('/links/:id', async (c) => {
  const u = creatorOnly(c), id = c.req.param('id');
  const r = await c.env.DB.prepare('UPDATE acp_links SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(now(), id, u.id).run();
  if (!r.meta.changes) throw notFound('That machine is not connected.');
  const bridges = await c.env.DB.prepare('SELECT id FROM acp_bridges WHERE link_id = ? AND stopped_at IS NULL').bind(id).all<{ id: string }>();
  for (const b of bridges.results) await revokeBridgeGrant(c.env, b.id, u.id);
  if (c.env.ACP) await acpHub(c.env, u.id).dropLink(id).catch(() => {});
  return c.json({ ok: true });
});

acpApi.get('/ws', async (c) => {
  const u = creatorOnly(c);
  // a WebSocket carries the cookie from any site: only our own pages may open one (cross-site WebSocket hijacking)
  const o = c.req.header('origin');
  if (!o || (o !== c.get('origin') && o !== new URL(c.req.url).origin)) throw new AppError(403, 'Cross-site request refused.', 'csrf');
  if (c.req.header('upgrade') !== 'websocket') throw new AppError(426, 'Expected a WebSocket.', 'upgrade_required');
  if (!c.env.ACP) throw new AppError(501, 'The workbench is not available here.', 'unavailable');
  const url = new URL(c.req.url);
  url.search = `?kind=view&uid=${encodeURIComponent(u.id)}&id=${encodeURIComponent('v' + token(9))}`;
  return acpHub(c.env, u.id).fetch(new Request(url, c.req.raw));
});

/** Account deletion and cleanup. */
export const acpCleanupStmts = (env: Env, t: number) => [
  env.DB.prepare('DELETE FROM acp_pairs WHERE expires_at < ?').bind(t - 86400_000),
  env.DB.prepare('DELETE FROM acp_links WHERE (revoked_at IS NOT NULL AND revoked_at < ?1) OR expires_at < ?1').bind(t - 30 * 86400_000),
  env.DB.prepare('DELETE FROM acp_bridges WHERE stopped_at IS NOT NULL AND stopped_at < ?').bind(t - 30 * 86400_000),
];

// ----- the relay ---------------------------------------------------------------------------------------------------------
type Tag = { kind: 'view' | 'bridge'; id: string; uid: string; link?: string; meta?: Record<string, unknown> | null; at: number };

/** One per account: connects its bridges (agents on the creator's machines) with its console pages. */
export class AcpHub extends DurableObject<Env> {
  private all(): { ws: WebSocket; t: Tag }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, t: ws.deserializeAttachment() as Tag })).filter((x) => x.t && x.t.kind);
  }
  private views() { return this.all().filter((x) => x.t.kind === 'view'); }
  private bridges() { return this.all().filter((x) => x.t.kind === 'bridge'); }
  private put(ws: WebSocket, data: string) { try { ws.send(data); } catch { /* closing */ } }
  private list() {
    return this.bridges().map(({ t }) => ({ id: t.id, link: t.link, at: t.at, ...(t.meta || {}) })).sort((a, b) => a.at - b.at);
  }
  private announce() {
    const msg = JSON.stringify({ type: 'bridges', bridges: this.list() });
    for (const v of this.views()) this.put(v.ws, msg);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const q = new URL(request.url).searchParams;
    const kind = q.get('kind') === 'bridge' ? 'bridge' : 'view', id = q.get('id') || '', uid = q.get('uid') || '';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const stored = await this.ctx.storage.get<string>('uid');
    if (!stored && uid) await this.ctx.storage.put('uid', uid);
    if (!id || !uid || (stored && stored !== uid)) { pair[1].close(4000, 'Bad request'); return new Response(null, { status: 101, webSocket: pair[0] }); }
    if (kind === 'bridge') {
      // the same run reconnecting replaces its old socket
      for (const b of this.bridges()) if (b.t.id === id) { try { b.ws.close(4009, 'Replaced'); } catch { /* closed */ } }
      if (this.bridges().filter((b) => b.t.id !== id).length >= MAX_BRIDGES) { pair[1].close(4029, `At most ${MAX_BRIDGES} agents can be connected at once.`); return new Response(null, { status: 101, webSocket: pair[0] }); }
      pair[1].serializeAttachment({ kind, id, uid, link: q.get('link') || '', meta: null, at: Date.now() } satisfies Tag);
      this.announce();
      for (const v of this.views()) this.put(pair[1], JSON.stringify({ type: 'view_open', from: v.t.id }));
    } else {
      const views = this.views();
      if (views.length >= MAX_VIEWS) { const oldest = views.sort((a, b) => a.t.at - b.t.at)[0]; try { oldest.ws.close(4003, 'Too many pages open'); } catch { /* closed */ } }
      pair[1].serializeAttachment({ kind, id, uid, at: Date.now() } satisfies Tag);
      this.put(pair[1], JSON.stringify({ type: 'welcome', id, bridges: this.list() }));
      for (const b of this.bridges()) this.put(b.ws, JSON.stringify({ type: 'view_open', from: id }));
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const t = ws.deserializeAttachment() as Tag | null;
    if (!t || typeof raw !== 'string') return;
    if (raw.length > (t.kind === 'view' ? MAX_VIEW_MSG : MAX_BRIDGE_MSG)) {
      this.put(ws, JSON.stringify({ type: 'error', message: 'Message too large.' }));
      return;
    }
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (m.type === 'ping') { this.put(ws, '{"type":"pong"}'); return; }

    if (t.kind === 'view') {
      if (m.type === 'list') { this.put(ws, JSON.stringify({ type: 'bridges', bridges: this.list() })); return; }
      const target = String(m.b || '');
      const b = this.bridges().find((x) => x.t.id === target);
      if (!b) {
        this.put(ws, JSON.stringify(m.type === 'rpc' ? { type: 'rpc_result', b: target, id: m.id, error: { code: -32000, message: 'This agent is not connected any more.' } } : { type: 'offline', b: target }));
        return;
      }
      delete m.b; m.from = t.id;   // the relay, not the page, says who is talking
      this.put(b.ws, JSON.stringify(m));
      return;
    }

    // from a bridge
    if (m.type === 'meta') {
      const meta = m.meta && typeof m.meta === 'object' ? m.meta as Record<string, unknown> : {};
      const safe: Record<string, unknown> = {};
      for (const k of ['agent', 'agentId', 'host', 'cwd', 'os', 'version', 'startedAt']) if (meta[k] !== undefined) safe[k] = typeof meta[k] === 'string' ? (meta[k] as string).slice(0, 300) : meta[k];
      for (const k of ['launch', 'child']) if (meta[k] === true) safe[k] = true;   // it can start more agents / it was started by one
      t.meta = safe; ws.serializeAttachment(t);
      this.announce();
      return;
    }
    const to = typeof m.to === 'string' ? m.to : null;
    delete m.to; m.b = t.id;
    const out = JSON.stringify(m);
    for (const v of this.views()) if (!to || v.t.id === to) this.put(v.ws, out);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const t = ws.deserializeAttachment() as Tag | null;
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch { /* already */ }
    if (!t) return;
    if (t.kind === 'bridge') this.announce();
    else for (const b of this.bridges()) this.put(b.ws, JSON.stringify({ type: 'view_close', from: t.id }));
  }
  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws, 1011); }

  /** A machine was disconnected in the console: its bridges stop at once. */
  async dropLink(linkId: string): Promise<number> {
    let n = 0;
    for (const b of this.bridges()) if (b.t.link === linkId) { n++; try { b.ws.close(4401, 'This machine was disconnected.'); } catch { /* closed */ } }
    // getWebSockets still lists a socket closing in this turn: announce without them
    const left = this.list().filter((x) => x.link !== linkId);
    const msg = JSON.stringify({ type: 'bridges', bridges: left });
    for (const v of this.views()) this.put(v.ws, msg);
    return n;
  }
}

// ----- the ACP Registry ----------------------------------------------------------------------------------------------
// The workbench supports exactly the agents of the official ACP Registry (the list Zed and JetBrains offer). The site
// serves the live index (cached for an hour at the edge) to the page and the bridge, and the snapshot it was built with
// (scripts/acp-registry.mjs) when the registry cannot be reached.
export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const REGISTRY_EXCLUDE = new Set(['github-copilot']);
type RegistryAgent = { id: string; name: string; version: string; description?: string; distribution?: Record<string, unknown>; [k: string]: unknown };
export async function acpRegistry(fetchImpl: typeof fetch = fetch): Promise<{ agents: RegistryAgent[]; live: boolean; snapshot?: string }> {
  try {
    const r = await fetchImpl(REGISTRY_URL, { cf: { cacheTtl: 3600, cacheEverything: true }, signal: AbortSignal.timeout(5000) } as RequestInit);
    if (r.ok) {
      const j = await r.json() as { agents?: RegistryAgent[] };
      const agents = (Array.isArray(j.agents) ? j.agents : []).filter((a) => a && typeof a.id === 'string' && /^[a-z0-9-]{1,64}$/.test(a.id) && typeof a.name === 'string' && a.distribution && !REGISTRY_EXCLUDE.has(a.id) && !/\(legacy ID\)$/.test(a.name));
      if (agents.length >= 5) return { agents: agents.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })), live: true };
    }
  } catch { /* the snapshot */ }
  const snap = REGISTRY_SNAPSHOT as { snapshot: string; agents: RegistryAgent[] };
  return { agents: snap.agents, live: false, snapshot: snap.snapshot };
}
