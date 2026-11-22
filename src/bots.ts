// Preview test bots: a creator adds bot players to their own preview of an online game, and the bots connect to it like
// real players do, over the platform's real network path. A local simulation in the page would hide what only shows
// online (latency, stutter, a reconnect, a desync), so the bots are remote clients, run here, server side.
//
// One BotFleet Durable Object per creator, game and region, created in that region (a location hint), so its bots
// really connect from there. Each bot (src/bot-client.js):
//   - has a play session of its own, kind 'bot', in the preview only (session-binding.js refuses it anywhere else). It
//     is never rated (match-result leaves it out), never counted as a player, and its session row is removed when the
//     fleet stops, which ends every connection it still has;
//   - reaches the platform through its public front door: fetch() of this Worker's own address goes out through
//     Cloudflare's edge and back in (global_fetch_strictly_public), so the matchmaker route, the game's own Worker and
//     the match's Durable Object see a client like any other, from where the fleet runs;
//   - puts a last mile of its own on top (bots-core.js NetLink): latency, jitter, packet loss, lag spikes, outages;
//   - plays with the game's own logic, server/bot.js, run in a Dynamic Worker with no network and no bindings
//     (src/runtime/bot-runner.js). Without one, bots join and stay connected but send nothing.
//
// Where bots go: 'follow' (the default) puts them wherever the creator searches or opens a room in the preview (the
// /api/rt/match and /api/rt/room routes tell the fleet), so pressing the game's own Find Match button fills the table.
// Or a public queue, a private lobby code or a room the creator names (the MCP tool preview_bots, for agents that test
// without a browser: bots alone can fill a match).
//
// Cost and abuse: only a game's owner starts bots, in the preview only; at most preview_bots_max bots per fleet,
// preview_bots_fleets fleets per creator at once, each stopping by itself after preview_bots_max_minutes, and
// preview_bots_daily_minutes bot-minutes per creator per day. The matchmaker's and the match's own message budgets
// apply to bots as to anyone.
import { DurableObject } from 'cloudflare:workers';
import { AppError, bad, type Env, type Project, type User } from './env';
import { getSettings } from './settings';
import { playKey, gameUrl } from './deploy';
import { verKey, getVersion, ownedProject } from './projects';
import { now, rid } from './util';
import { BOT_RUNNER_SOURCE } from './generated/runtime-source';
// @ts-ignore plain JS module
import { BOT_LIMITS, BOT_REGIONS, NET_PROFILES, botId, botMinutes, fleetRequest, netShape } from './bots-core.js';
// @ts-ignore plain JS module
import { BotClient } from './bot-client.js';
// @ts-ignore plain JS module
import { botIssues } from './bot-contract.js';
// @ts-ignore plain JS module
import { answerBotInvite, createBotInvite } from './social-rules.js';
import { pushTo } from './social';
import { lobbyData, rules } from './routes/social';
// @ts-ignore plain JS module
import { signPlayToken } from './runtime/game-worker.js';

const BOT_SESSION_S = 2 * 3600;
const ALARM_MS = 10_000;
const FOLLOW_GIVE_UP_MS = 90_000;   // a following bot that searched this long without a match goes back to waiting

export type BotTarget = { kind: 'match'; query: string; label?: string } | { kind: 'room'; room: string; max?: number; label?: string };
interface FleetStart {
  fleet: string; project: string; version: number; owner: string; region: string; platform: string; game: string;
  cfg: any; endsAt: number; seed: number;
}

export class BotFleet extends DurableObject<Env> {
  private bots: any[] = [];
  private info: FleetStart | null = null;
  private log: string[] = [];
  private brain: { worker: any; desc: { think: boolean; actions: boolean; room: boolean; invite: boolean; thinkMs: number } | null; note: string } = { worker: null, desc: null, note: '' };
  private followed: BotTarget | null = null;
  private ended: { at: number; why: string } | null = null;
  private version = 0;   // bumped on every change the panel should see

  private say(line: string) {
    this.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (this.log.length > BOT_LIMITS.maxLog) this.log.shift();
    this.version++;
  }

  /** Loads the game's server/bot.js into a sandbox of its own: a Dynamic Worker with no network and none of our bindings. */
  private async loadBrain(project: string, version: number): Promise<void> {
    const v = await getVersion(this.env, project, version);
    const files: string[] = (() => { try { return JSON.parse(v?.files || '[]').map((f: { path: string }) => f.path); } catch { return []; } })();
    const server = files.filter((p) => (p.startsWith('server/') || p.startsWith('shared/')) && /\.m?js$/.test(p));
    if (!server.includes('server/bot.js')) { this.brain = { worker: null, desc: null, note: 'This version has no server/bot.js: bots join and stay connected, but send no inputs. Add server/bot.js so they play (see the guide).' }; return; }
    if (!this.env.LOADER) { this.brain = { worker: null, desc: null, note: 'Bot logic cannot run on this platform (no Worker Loader binding): bots join and stay connected, but send no inputs.' }; return; }
    const modules: Record<string, string> = { 'bot-runner.js': BOT_RUNNER_SOURCE };
    for (const path of server) { const obj = await this.env.FILES.get(verKey(project, version, path)); if (obj) modules[path] = await obj.text(); }
    const worker = this.env.LOADER.get(`bots:${project}:v${version}:${(BOT_RUNNER_SOURCE.length).toString(36)}`, async () => ({
      compatibilityDate: '2026-10-01', compatibilityFlags: ['disallow_importable_env'], mainModule: 'bot-runner.js', modules, env: {}, globalOutbound: null,
    }));
    try {
      const r = await worker.getEntrypoint().fetch(new Request('https://bot.local/describe'));
      const desc = await r.json() as any;
      if (!r.ok) throw new Error(desc?.error || `status ${r.status}`);
      const has = ['think', 'actions', 'room', 'invite'].filter((k) => desc[k]).map((k) => k + '()');
      this.brain = { worker, desc, note: has.length ? `The game's server/bot.js plays: ${has.join(', ')}.` : 'server/bot.js has none of think(), actions(), room() or invite(): bots stay connected but send nothing.' };
    } catch (e) {
      this.brain = { worker: null, desc: null, note: `server/bot.js failed to load: ${String((e as Error)?.message || e).slice(0, 300)}` };
    }
  }

  // Calls from the bots are gathered for a few milliseconds and sent to the sandbox together.
  private pending: { call: any; resolve: (r: any) => void }[] = [];
  private flushTimer: any = null;
  private think(call: any): Promise<any> {
    if (!this.brain.worker) return Promise.resolve({ input: null });
    return new Promise((resolve) => {
      this.pending.push({ call, resolve });
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 5);
    });
  }
  private async flush() {
    this.flushTimer = null;
    const batch = this.pending.splice(0, 64);
    if (this.pending.length) this.flushTimer = setTimeout(() => this.flush(), 5);
    if (!batch.length) return;
    try {
      const r = await this.brain.worker.getEntrypoint(undefined, { limits: { cpuMs: 200 } }).fetch(new Request('https://bot.local/think', { method: 'POST', body: JSON.stringify({ calls: batch.map((b) => b.call) }) }));
      const j = await r.json() as { results?: any[] };
      batch.forEach((b, i) => b.resolve(j.results?.[i] || { error: 'no answer from server/bot.js' }));
    } catch (e) {
      const msg = `server/bot.js: ${String((e as Error)?.message || e).slice(0, 200)}`;
      for (const b of batch) b.resolve({ error: msg });
    }
  }

  /** A real WebSocket to the platform's (or the game's) public address, opened from here. */
  private async open(url: string, h: { message(d: any): void; close(code: number, reason: string): void }) {
    const res = await fetch(url.replace(/^ws/, 'http'), { headers: { upgrade: 'websocket', 'user-agent': 'HearthCade preview test bot' } });
    const ws = res.webSocket;
    if (!ws) {
      let why = `HTTP ${res.status}`;
      try { const j = await res.json() as { error?: string }; if (j.error) why += `: ${j.error}`; } catch { /* not JSON */ }
      throw new Error(why);
    }
    ws.accept();
    ws.addEventListener('message', (ev) => h.message(ev.data));
    ws.addEventListener('close', (ev) => h.close(ev.code, ev.reason));
    ws.addEventListener('error', () => h.close(1006, 'error'));
    return ws;
  }

  private io() {
    const platform = this.info!.platform;
    return {
      now: () => Date.now(),
      open: (url: string, h: any) => this.open(url, h),
      api: async (path: string, body: unknown) => {
        const r = await fetch(`${platform}/api/rt/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'HearthCade preview test bot' }, body: JSON.stringify(body) });
        const j = await r.json() as any;
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        return j;
      },
      think: (call: any) => this.think(call),
      log: (t: string) => this.say(t),
      changed: () => { this.version++; },
    };
  }

  // ----- RPC from the platform (routes, MCP) ---------------------------------------------------------------------------
  async start(s: FleetStart, tokens: { id: string; token: string }[]): Promise<void> {
    if (this.info && !this.ended) await this.halt('replaced by a new fleet');
    this.info = s; this.ended = null; this.log = []; this.followed = null; this.bots = [];
    await this.ctx.storage.put('info', s);
    await this.loadBrain(s.project, s.version);
    this.say(`fleet ${s.fleet.slice(0, 8)} started: ${s.cfg.bots} bots, ${s.region === 'auto' ? 'near you' : (BOT_REGIONS as Record<string, string>)[s.region]}, ${s.cfg.target}`);
    this.say(this.brain.note);
    const io = this.io(), thinkMs = this.brain.desc?.thinkMs || 250;
    this.bots = tokens.map((t, i) => new BotClient({ id: t.id, name: s.cfg.names[i], token: t.token, platform: s.platform, game: s.game, net: s.cfg.nets[i], skill: s.cfg.skill, seed: (s.seed + i * 104729) >>> 0, thinkMs }, io));
    const t = s.cfg.target;
    if (t === 'queue') {
      const q = s.cfg.queue, qs = new URLSearchParams({ queue: q.queue, players: String(q.players), ...(q.min != null ? { min: String(q.min) } : {}), ...(q.teams != null ? { teams: String(q.teams) } : {}), ...(q.mode ? { mode: q.mode } : {}), wait: '5', settle: '0' });
      this.goAll({ kind: 'match', query: qs.toString(), label: `queue ${q.queue}` });
    } else if (t === 'code') this.goAll({ kind: 'match', query: new URLSearchParams({ code: s.cfg.code, players: String(s.cfg.queue?.players || 8) }).toString(), label: `lobby ${s.cfg.code}` });
    else if (t === 'room') this.goAll({ kind: 'room', room: s.cfg.room, label: `room ${s.cfg.room}` });
    else if (t === 'invite') this.say('waiting for your invites: invite the bots from your game\'s own Invite Friends in the preview (they are your online friends there)');
    else this.say('waiting for you: press your game\'s own Find Match (or open a room) in the preview, and the bots join you');
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  private goAll(target: BotTarget, only?: (b: any) => boolean) {
    let n = 0;
    for (const b of this.bots) if (!only || only(b)) { n++; b.searchStarted = Date.now(); void b.go(target); }
    if (n) this.say(`${n} bot${n === 1 ? '' : 's'} → ${target.label || target.kind}`);
  }

  /** The creator searched or opened a room in this preview: following bots that are free go there too. */
  async follow(target: BotTarget | { kind: 'private' }): Promise<{ sent: number }> {
    if (!this.info || this.ended) return { sent: 0 };
    // a private lobby is entered by invite only, by bots as by anyone: say how
    if (target.kind === 'private') { this.say('you opened a private lobby: invite bots into it from your game\'s Invite Friends (they show there as your online friends)'); return { sent: 0 }; }
    if (this.info.cfg.target !== 'follow') return { sent: 0 };
    this.followed = target;
    const free = (b: any) => ['idle', 'ended', 'out', 'left'].includes(b.phase) || (target.kind === 'room' && b.phase === 'in room' && b.target?.room !== target.room);
    const before = this.bots.filter(free).length;
    this.goAll(target, free);
    return { sent: before };
  }

  /**
   * The creator invited a bot from the game (GCP.friends.invite or the invite picker over the preview). Like a player, it
   * reads the invite for a moment and answers: yes when it is free (it leaves a search or a room for it), no when it is
   * in a match. Yes enters the private lobby through the real invite path (/api/rt/match?invite=), or the room the
   * invite's data names ({ room }), as the game's own join code would.
   */
  async invite(o: { id: string; bot: string; game: unknown; data: Record<string, any> }): Promise<{ ok: true; name: string; status: string }> {
    if (!this.info || this.ended) throw new Error('No test bots are running.');
    const b = this.bots.find((x) => x.id === o.bot);
    if (!b) throw new Error('That test bot is not running.');
    const status = this.friendStatus(b);
    this.say(`${b.name}: got your invite${o.data.label ? ` (${o.data.label})` : ''}`);
    const wait = 700 + Math.floor(Math.random() * 900);
    setTimeout(() => { void this.answer(b, o, status === 'online').catch((e) => this.say(`${b.name}: could not answer the invite: ${String((e as Error)?.message || e).slice(0, 160)}`)); }, wait);
    return { ok: true, name: b.name, status };
  }

  /** How a bot shows in the creator's friends list in the preview: online when free, busy in a match. */
  private friendStatus(b: any): 'online' | 'busy' {
    return ['playing', 'waiting', 'reconnecting', 'away'].includes(b.phase) ? 'busy' : 'online';
  }

  private answers: { id: string; bot: string; name: string; accepted: boolean; at: number; why?: string }[] = [];
  private async answer(b: any, o: { id: string; data: Record<string, any> }, yes: boolean) {
    if (!this.info || this.ended || b.stopped) return;
    const r = await answerBotInvite(this.env.DB, b.id, o.id, yes) as { from: string; game: unknown; join?: any };
    this.answers.push({ id: o.id, bot: b.id, name: b.name, accepted: yes, at: Date.now(), ...(yes ? {} : { why: 'in a match' }) });
    if (this.answers.length > 20) this.answers.shift();
    // the creator's platform page hears it as from a friend (a toast, and the game's GCP.friends.on('answer'))
    await pushTo(this.env, r.from, { kind: 'invite_answer', id: o.id, by: { id: b.id, name: b.name }, accepted: yes, game: r.game, test_bot: true });
    if (!yes) { this.say(`${b.name}: declined your invite (busy in a match)`); return; }
    // where yes leads: the game's own invite(join) in server/bot.js says (it knows how its join becomes a room code);
    // without it, a match invite enters the invited match and data.room is taken as the room's code
    const named = o.data?.data && typeof o.data.data === 'object' ? (o.data.data as any).room : null;
    let go: { match?: boolean; room?: string } | null = o.data?.lobby ? { match: true } : typeof named === 'string' && named ? { room: named } : null;
    if (this.brain.desc?.invite) {
      const x = await this.think({ kind: 'invite', bot: b.id, join: r.join || null, name: b.name, elapsed: 0, memory: b.memory, skill: b.skill, seed: b.seed, calls: b.calls++ });
      if (x.memory) b.memory = x.memory;
      if (x.error) { b.brain.errors++; b.brain.last = x.error; b.stats.error(`bot.js invite(): ${x.error}`); this.say(`${b.name}: server/bot.js invite() failed: ${x.error}`); return; }
      go = x.go || null;
    }
    if (go?.match && o.data?.lobby) {
      b.closeAll(); b.searchStarted = Date.now();
      this.say(`${b.name}: accepted, joining your private lobby`);
      void b.go({ kind: 'match', query: new URLSearchParams({ invite: o.id }).toString(), label: 'your invite' });
    } else if (go?.room) {
      if (b.phase === 'in room' && b.target?.room === go.room) { this.say(`${b.name}: accepted (already in ${go.room})`); return; }
      b.closeAll();
      this.say(`${b.name}: accepted, joining room ${go.room}`);
      void b.go({ kind: 'room', room: go.room, label: `room ${go.room}` });
    } else if (this.brain.desc?.invite) this.say(`${b.name}: accepted; server/bot.js invite() sent it nowhere`);
    else this.say(`${b.name}: accepted, but the invite names no match or room (data.room), so it stays. If your game turns the invite into a room code of its own, add invite(join) to server/bot.js and return { room }.`);
  }

  async act(a: { bot?: string; action: string; ms?: number; extra?: number; net?: unknown; reload?: boolean }): Promise<{ ok: true; bots: number }> {
    if (!this.info || this.ended) throw new Error('No test bots are running.');
    const which = !a.bot || a.bot === 'all' ? this.bots : this.bots.filter((b) => b.id === a.bot || b.name === a.bot);
    if (!which.length) throw new Error(`No bot ${a.bot}.`);
    const ms = Math.max(100, Math.min(Number(a.ms) || 5000, 120_000));
    for (const b of which) {
      switch (a.action) {
        case 'drop': b.drop(ms, false); break;
        case 'reload': b.drop(ms, true); break;
        case 'spike': b.spike(ms, Math.max(10, Math.min(Number(a.extra) || 400, 5000))); break;
        case 'outage': b.outage(ms); break;
        case 'net': b.setNet(typeof a.net === 'string' ? netShape({ profile: a.net }) : netShape(a.net || {})); this.say(`${b.name}: network ${b.up.shape.profile}`); break;
        case 'leave': b.leave(); this.say(`${b.name}: left on purpose`); break;
        case 'rejoin': if (b.target) { b.closeAll(); void b.go(b.target); } else if (this.followed) void b.go(this.followed); break;
        default: throw new Error('action must be drop, reload, spike, outage, net, leave or rejoin.');
      }
    }
    return { ok: true, bots: which.length };
  }

  async status(): Promise<any> {
    const t = Date.now(), info = this.info || await this.ctx.storage.get<FleetStart>('info');
    if (!info) return { running: false };
    const running = !!this.info && !this.ended && this.bots.length > 0;
    // lost its memory (the object was restarted): the bots are gone
    if (!running && !this.ended) return { running: false, fleet: info.fleet, ended: { why: 'the fleet was restarted by the platform; start it again' } };
    return {
      running, fleet: info.fleet, version: this.version, region: info.region, region_name: info.region === 'auto' ? BOT_REGIONS.auto : (BOT_REGIONS as Record<string, string>)[info.region], target: info.cfg.target,
      following: this.followed ? (this.followed.label || this.followed.kind) : null, ends_at: new Date(info.endsAt).toISOString(), seconds_left: Math.max(0, Math.round((info.endsAt - t) / 1000)),
      brain: { note: this.brain.note, kind: this.brain.desc?.think ? 'game' : this.brain.desc?.actions ? 'generic' : 'none', think_ms: this.brain.desc?.thinkMs ?? null, hooks: this.brain.desc ? { think: this.brain.desc.think, actions: this.brain.desc.actions, room: this.brain.desc.room, invite: this.brain.desc.invite } : null },
      needs: this.needs(),
      bots: this.bots.map((b) => ({ ...b.status(t), friend: this.friendStatus(b) })), invites: this.answers.slice(-10).map((x) => ({ ...x, at: new Date(x.at).toISOString() })), log: this.log.slice(-30), ended: this.ended && { at: new Date(this.ended.at).toISOString(), why: this.ended.why },
    };
  }

  /**
   * What the game has not given its bots, seen from what they are doing now: the platform got them in, but only the
   * game's own server/bot.js can take the next step (say hello, mark ready, move). One line each, for the panel.
   */
  private needs(): { hook: string; message: string }[] {
    const d = this.brain.desc, out: { hook: string; message: string }[] = [];
    const inRoom = this.bots.filter((b) => b.phase === 'in room'), inMatch = this.bots.filter((b) => ['waiting', 'playing'].includes(b.phase));
    if (inRoom.length && !d?.room) out.push({ hook: 'room', message: `${inRoom.length === 1 ? inRoom[0].name + ' is' : inRoom.length + ' bots are'} in the room but cannot say anything: ${d ? 'server/bot.js has no room()' : 'this version has no server/bot.js'}. Whatever your game waits for from a player in a room (a hello, ready, a pick) only server/bot.js can send. Ask your agent to add room(ctx) (get_started topic "bots").` });
    if (inMatch.length && !d?.think && !d?.actions) out.push({ hook: 'think', message: `${inMatch.length === 1 ? inMatch[0].name + ' is' : inMatch.length + ' bots are'} in the match but cannot move: ${d ? 'server/bot.js has no think() or actions()' : 'this version has no server/bot.js'}. Ask your agent to add think(view, me, ctx) (get_started topic "bots").` });
    return out;
  }

  async stop(why = 'stopped by the creator'): Promise<any> { return this.halt(why); }

  private async halt(why: string): Promise<any> {
    const info = this.info || await this.ctx.storage.get<FleetStart>('info');
    const t = Date.now(), summary = await this.status().catch(() => null);
    for (const b of this.bots) { try { b.leave(); } catch { /* closed */ } }
    // a moment for the goodbyes to leave through the bots' links, then everything closes
    await new Promise((r) => setTimeout(r, 300));
    for (const b of this.bots) b.stop();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    for (const p of this.pending.splice(0)) p.resolve({ input: null });
    this.ended = { at: t, why };
    if (info) {
      const ms = Math.min(t, info.endsAt) - (await this.env.DB.prepare('SELECT started_at FROM bot_fleets WHERE id = ?').bind(info.fleet).first<{ started_at: number }>().then((r) => r?.started_at ?? t).catch(() => t));
      const brief = summary && summary.bots ? { why, matches: summary.bots.reduce((a: number, b: any) => a + (b.matches_finished || 0), 0), bots: summary.bots.map((b: any) => ({ name: b.name, phase: b.phase, rtt_p50_ms: b.stats.rtt_p50_ms, rtt_p95_ms: b.stats.rtt_p95_ms, reconnects: b.stats.reconnects, errors: b.stats.errors, last_error: b.stats.last_error, brain_errors: b.brain.errors })) } : { why };
      try {
        await this.env.DB.batch([
          this.env.DB.prepare('UPDATE bot_fleets SET ended_at = ?, bot_minutes = ?, summary = ? WHERE id = ? AND ended_at IS NULL').bind(t, botMinutes(info.cfg.bots, ms), JSON.stringify(brief).slice(0, 8000), info.fleet),
          // the bots' sessions end: any connection one of them still has is refused from its next check on
          this.env.DB.prepare("DELETE FROM plays WHERE project_id = ? AND kind = 'bot' AND user_id LIKE ?").bind(info.project, `bot_${info.fleet.slice(0, 8)}_%`),
        ]);
      } catch (e) { console.error('bot fleet end', e); }
    }
    this.say(`fleet stopped: ${why}`);
    this.bots = []; this.followed = null;
    await this.ctx.storage.deleteAlarm();
    return { stopped: true, why, summary };
  }

  async alarm(): Promise<void> {
    const info = this.info;
    if (!info || this.ended) {
      // the object restarted and lost its bots: close the books on that fleet
      const kept = await this.ctx.storage.get<FleetStart>('info');
      if (kept && !this.ended) { this.info = kept; await this.halt('the fleet was restarted by the platform'); }
      return;
    }
    const t = Date.now();
    if (t >= info.endsAt) { await this.halt(`time is up (${info.cfg.minutes} minutes)`); return; }
    if (info.cfg.target === 'follow' || info.cfg.target === 'invite') {
      for (const b of this.bots) if (b.phase === 'searching' && b.searchStarted && t - b.searchStarted > FOLLOW_GIVE_UP_MS) { b.closeAll(); b.set('idle', 'no match came: waiting for your next search'); }
    } else if (info.cfg.target === 'queue' || info.cfg.target === 'code') {
      // a queue or lobby fleet plays on: after a match it looks for the next one
      for (const b of this.bots) if (['ended', 'idle'].includes(b.phase) && b.target && (!b.endedAt || t - b.endedAt > 3000)) { if (b.phase === 'ended' && !b.endedAt) { b.endedAt = t; continue; } b.endedAt = 0; b.searchStarted = t; void b.go(b.target); }
    }
    await this.ctx.storage.setAlarm(t + ALARM_MS);
  }
}

// ----- the service the console and the MCP tool use ------------------------------------------------------------------
const fleetName = (pid: string, owner: string, region: string) => `${pid}:${owner}:${region}`;
const stubOf = (env: Env, name: string, region?: string): any => {
  if (!env.BOTS) throw new AppError(501, 'Test bots are not available on this platform.', 'bots_unavailable');
  const ns = env.BOTS as unknown as DurableObjectNamespace<BotFleet>;
  return ns.get(ns.idFromName(name), region && region !== 'auto' ? { locationHint: region as DurableObjectLocationHint } : undefined);
};
async function activeFleet(env: Env, pid: string, owner: string): Promise<{ id: string; do_name: string; region: string } | null> {
  return env.DB.prepare('SELECT id, do_name, region FROM bot_fleets WHERE project_id = ? AND owner_id = ? AND ended_at IS NULL AND ends_at > ? ORDER BY started_at DESC LIMIT 1')
    .bind(pid, owner, now() - 60_000).first<{ id: string; do_name: string; region: string }>();
}

/** What the creator may choose from, and what they have left today. */
export async function botOptions(env: Env, p: Project, u: User) {
  const s = await getSettings(env), day = now() - 86_400_000;
  const used = await env.DB.prepare('SELECT COALESCE(SUM(bot_minutes), 0) AS m FROM bot_fleets WHERE owner_id = ? AND started_at > ?').bind(u.id, day).first<{ m: number }>();
  const v = p.preview_version ? await getVersion(env, p.id, p.preview_version) : null;
  let files: string[] = []; try { files = JSON.parse(v?.files || '[]').map((f: { path: string }) => f.path); } catch { /* none */ }
  let players: { min?: number; max?: number } = {}, contract: any = null;
  try { const m = JSON.parse(v?.manifest || '{}'); players = m.meta?.meta?.players || {}; contract = m.bots || null; } catch { /* none */ }
  return {
    enabled: !!s.preview_bots_enabled && !!env.BOTS, preview_version: p.preview_version,
    // contract: what the build's checks found (bot-contract.js); needs: what its server/bot.js is missing, in words
    game: { matches: files.includes('server/match.js'), bot_logic: files.includes('server/bot.js'), players, contract, needs: contract ? botIssues(contract).map((i: { message: string; hint: string }) => ({ message: i.message, hint: i.hint })) : [] },
    limits: { bots: s.preview_bots_max, minutes: s.preview_bots_max_minutes, daily_bot_minutes: s.preview_bots_daily_minutes, used_today: used?.m || 0, fleets: s.preview_bots_fleets },
    profiles: Object.fromEntries(Object.entries(NET_PROFILES).map(([k, v]: [string, any]) => [k, { label: v.label, latency_ms: v.latency, jitter_ms: v.jitter, loss_percent: v.loss }])),
    regions: BOT_REGIONS,
  };
}

export async function startBots(env: Env, origin: string, u: User, projectId: string, body: Record<string, unknown>) {
  const p = await ownedProject(env, u, projectId), s = await getSettings(env);
  if (!s.preview_bots_enabled || !env.BOTS) throw new AppError(403, 'Test bots are switched off on this platform.', 'bots_off');
  if (!p.preview_version) throw new AppError(409, 'No preview has been deployed yet. Run deploy_preview first.', 'no_preview');
  const r = fleetRequest(body, { maxBots: s.preview_bots_max, maxMinutes: s.preview_bots_max_minutes }) as { ok: boolean; error?: string; cfg?: any };
  if (!r.ok) throw bad(r.error || 'Bad request.');
  const cfg: any = r.cfg, t = now();
  // at most this many fleets at once, and the day's allowance of bot-minutes (counting what this fleet may use)
  const [running, used] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM bot_fleets WHERE owner_id = ? AND ended_at IS NULL AND ends_at > ? AND project_id != ?').bind(u.id, t, p.id).first<{ n: number }>(),
    env.DB.prepare('SELECT COALESCE(SUM(bot_minutes), 0) AS m FROM bot_fleets WHERE owner_id = ? AND started_at > ? AND ended_at IS NOT NULL').bind(u.id, t - 86_400_000).first<{ m: number }>(),
  ]);
  if ((running?.n || 0) >= s.preview_bots_fleets) throw new AppError(429, `You already have ${running!.n} test-bot fleets running. Stop one first.`, 'bots_busy');
  const want = cfg.bots * cfg.minutes, left = s.preview_bots_daily_minutes - (used?.m || 0);
  if (want > left) {
    const fit = Math.floor(left / cfg.bots);
    throw new AppError(429, left <= 0 ? `You have used today's ${s.preview_bots_daily_minutes} bot-minutes. They come back over the next 24 hours.` : `${cfg.bots} bots for ${cfg.minutes} minutes is ${want} bot-minutes and you have ${left} left today.${fit >= 1 ? ` Try ${fit} minutes.` : ''}`, 'bots_quota');
  }
  // one fleet per creator and game: a new one replaces the old one (in any region)
  const old = await activeFleet(env, p.id, u.id);
  if (old) await stubOf(env, old.do_name, old.region).stop('replaced by a new fleet').catch(() => null);
  const platform = (env.PUBLIC_ORIGIN || origin).replace(/\/$/, '');
  const game = (await gameUrl(env, origin, p.id, 'preview')).split('?')[0].replace(/\/$/, '');
  await launchFleet(env, { project: p.id, version: p.preview_version, owner: u.id, cfg, platform, game, minutes: want });
  return botStatus(env, u, p.id);
}

/** Starts a checked fleet: the bots' play sessions (kind 'bot', preview only, ended when the fleet stops), its record,
    and the Durable Object in its region. platform and game are the public addresses the bots connect to. */
export async function launchFleet(env: Env, o: { project: string; version: number; owner: string; cfg: any; platform: string; game: string; minutes?: number }): Promise<string> {
  const cfg = o.cfg, t = now(), fleet = rid(16), name = fleetName(o.project, o.owner, cfg.region), endsAt = t + cfg.minutes * 60_000;
  const key = await playKey(env, o.project), x = Math.floor(t / 1000) + BOT_SESSION_S, tokens: { id: string; token: string }[] = [], stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < cfg.bots; i++) {
    const id = botId(fleet, i), sid = 'ps_' + rid(16);
    stmts.push(env.DB.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at, ua) VALUES (?, ?, ?, 'preview', ?, 'bot', ?, ?, 'HearthCade preview test bot')").bind(sid, o.project, o.version, id, t, t));
    tokens.push({ id, token: await signPlayToken({ g: o.project, e: 'preview', u: id, n: cfg.names[i], k: 'bot', s: sid, x }, key) });
  }
  stmts.push(env.DB.prepare('INSERT INTO bot_fleets (id, project_id, owner_id, do_name, region, bots, target, started_at, ends_at, bot_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(fleet, o.project, o.owner, name, cfg.region, cfg.bots, cfg.target, t, endsAt, o.minutes ?? cfg.bots * cfg.minutes));
  await env.DB.batch(stmts);
  await stubOf(env, name, cfg.region).start({ fleet, project: o.project, version: o.version, owner: o.owner, region: cfg.region, platform: o.platform, game: o.game, cfg, endsAt, seed: (Math.random() * 2 ** 32) >>> 0 }, tokens);
  return fleet;
}

export async function botStatus(env: Env, u: User, projectId: string) {
  const p = await ownedProject(env, u, projectId);
  const f = await activeFleet(env, p.id, u.id);
  if (!f) {
    const last = await env.DB.prepare('SELECT id, region, bots, target, started_at, ended_at, bot_minutes, summary FROM bot_fleets WHERE project_id = ? AND owner_id = ? ORDER BY started_at DESC LIMIT 1').bind(p.id, u.id).first<any>();
    return { running: false, last: last ? { fleet: last.id, bots: last.bots, target: last.target, region: last.region, started_at: new Date(last.started_at).toISOString(), ended_at: last.ended_at ? new Date(last.ended_at).toISOString() : null, bot_minutes: last.bot_minutes, summary: (() => { try { return JSON.parse(last.summary || 'null'); } catch { return null; } })() } : null };
  }
  const st = await stubOf(env, f.do_name, f.region).status();
  if (!st.running) {
    // the object no longer runs it (it was restarted): close the books so a new fleet can start
    await env.DB.prepare("UPDATE bot_fleets SET ended_at = ?, summary = COALESCE(summary, ?) WHERE id = ? AND ended_at IS NULL").bind(now(), JSON.stringify({ why: st.ended?.why || 'stopped' }), f.id).run();
  }
  return st;
}

export async function actBots(env: Env, u: User, projectId: string, a: Record<string, any>) {
  const p = await ownedProject(env, u, projectId), f = await activeFleet(env, p.id, u.id);
  if (!f) throw new AppError(409, 'No test bots are running for this game.', 'no_bots');
  try { return await stubOf(env, f.do_name, f.region).act({ bot: a.bot, action: String(a.action || ''), ms: a.ms, extra: a.extra, net: a.net }); }
  catch (e) { throw bad(String((e as Error)?.message || e)); }
}

export async function stopBots(env: Env, u: User, projectId: string) {
  const p = await ownedProject(env, u, projectId), f = await activeFleet(env, p.id, u.id);
  if (!f) return { stopped: false, note: 'No test bots were running.' };
  return stubOf(env, f.do_name, f.region).stop('stopped by the creator');
}

/**
 * Called by /api/rt/match and /api/rt/room when the game's owner searches or opens a room in their preview: a running
 * 'follow' fleet sends its free bots after them. Never fails or slows the creator's own request.
 */
export async function followCreator(env: Env, pid: string, owner: string, target: BotTarget | { kind: 'private' }): Promise<void> {
  try {
    if (!env.BOTS) return;
    const f = await activeFleet(env, pid, owner);
    if (f) await stubOf(env, f.do_name, f.region).follow(target);
  } catch (e) { console.error('bots follow', String((e as Error)?.message || e)); }
}

// ----- bots as the creator's friends in the preview ------------------------------------------------------------------
// Real friends never meet a preview, so a creator could not test their game's invite flow. A running fleet's bots show
// in GCP.friends.list() in the owner's preview as online friends (busy while in a match), and an invite to one goes
// through the same invite record a friend's does: the bot answers (GCP.friends.on('answer') in the game, a toast on the
// page) and enters the private lobby with the invite, as a friend's page would with GCP.match.join(join).

/** The running fleet's bots as GCP.friends.list() shows friends, in the owner's preview. [] when none run. */
export async function botFriends(env: Env, pid: string, owner: string): Promise<{ id: string; name: string; status: string; playing: unknown; since: null; joinable: false; invitable: true; test_bot: true }[]> {
  try {
    if (!env.BOTS) return [];
    const f = await activeFleet(env, pid, owner);
    if (!f) return [];
    const st = await stubOf(env, f.do_name, f.region).status();
    if (!st.running) return [];
    return (st.bots || []).map((b: any) => ({ id: b.id, name: b.name, status: b.friend || 'online', playing: b.friend === 'busy' ? { here: true, title: '', detail: 'Test player' } : null, since: null, joinable: false, invitable: true, test_bot: true }));
  } catch (e) { console.error('bot friends', String((e as Error)?.message || e)); return []; }
}

/**
 * The owner invites one of their running test bots (from the game in the preview, the invite picker over it, or the MCP
 * tool). data is what an invite to a friend carries (lobby, label, data), already checked by the caller.
 */
export async function inviteBot(env: Env, pid: string, owner: string, to: string, data: Record<string, unknown>) {
  const f = await activeFleet(env, pid, owner);
  if (!f || !to.startsWith(`bot_${f.id.slice(0, 8)}_`)) throw new AppError(409, 'That test player is not running any more. Start test players again under the preview.', 'not_online');
  const inv = await rules(() => createBotInvite(env.DB, { from: owner, to, project: pid, kind: data.lobby ? 'match' : 'game', data })) as { id: string; expires_at: number };
  const r = await stubOf(env, f.do_name, f.region).invite({ id: inv.id, bot: to, game: pid, data: { ...data } }).catch((e: unknown) => { throw new AppError(409, String((e as Error)?.message || e), 'not_online'); });
  return { ok: true, id: inv.id, status: r.status, expires_at: inv.expires_at, test_bot: true };
}

/** The console's invite (the picker over the preview, and the MCP tool): checks the owner, then as above. */
export async function inviteBotFor(env: Env, u: User, projectId: string, b: Record<string, any>) {
  const p = await ownedProject(env, u, projectId);
  const to = String(b.bot || '');
  if (!/^bot_[a-z0-9]{8}_\d{1,2}$/.test(to)) throw bad('bot must be a test bot\'s id (from the status).');
  const data: Record<string, unknown> = b.lobby ? await lobbyData(env, b.lobby, p.id, 'preview', b.label) : (b.label != null ? { label: String(b.label).slice(0, 60) } : {});
  if (b.data !== undefined) data.data = b.data;
  return inviteBot(env, p.id, u.id, to, data);
}
