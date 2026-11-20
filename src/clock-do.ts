// The play clock at scale (setting "play_clock_do"; see docs/play-clock-scale.md). Check-ins from the page showing a
// game and the game's heartbeats go to the player's PlayClock Durable Object instead of the database, so the database
// does no work per check-in: a player's clock writes their sessions and play record once every few minutes and when a
// session ends, and each game's GameTally writes the day's totals, the game's totals and who is online in one batch
// every 30 seconds. The rules are the database play clock's (src/play-clock.ts), applied by src/clock-core.ts.
//
// A clock can be shut down whenever it is idle, even for the 30 seconds between two check-ins, so it never trusts its
// memory: the book is saved to the object's own storage with every check-in that changed it (one row written), before
// the answer goes back. Heartbeats only change what a lost heartbeat would not miss (frames, the time of the last one),
// so they are saved with the next check-in, unless they change something that matters (the game started, an error).
// Free-trial and verifier sessions never come here: trial time decides access and refunds, so it stays on the exact
// database path.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import {
  BIND_EVERY_MS, FLUSH_EVERY_MS, PERSIST_EVERY_MS, TALLY_EVERY_MS, TALLY_WRITE_EVERY_MS, TALLY_ONLINE_REFRESH_MS, addToTally, beatBook, checkInBook, openInBook, dirtySessions,
  dropIdle, emptyBook, emptyTally, fromRow, idleSessions, markFlushed, onlineOf, scopeOf, takeTally, type Book, type ClockSession, type Tally, type TallyAdd,
} from './clock-core';
import type { CheckinResult, PlayRow } from './play-clock';
// @ts-ignore plain JS module
import { bindingProblem } from './session-binding.js';

const MAX_ERROR_KINDS = 200;
/** A game_online row older than this is from a tally that stopped: nobody is online there (tallies refresh it every TALLY_ONLINE_REFRESH_MS). */
export const CLOCK_ONLINE_FRESH_MS = 6 * 60_000;
const ALARM_EVERY_MS = FLUSH_EVERY_MS;

export type ClockRefusal = { ok: false; reason: 'unknown' | 'too_soon' | 'too_old' | 'ended'; code?: string; message?: string };
export interface BeatIn { sid: string; player: string; frames: unknown; errors: string[]; fatal: boolean; t: number; human_min_seconds: number; tok: { g: string; e: string; u: string; k: string; s: string } }

/** The stub of a player's clock. One per player (account or guest): every session of theirs, in every game, is in it. */
export const playClock = (env: Env, player: string) => env.PLAY_CLOCK!.get(env.PLAY_CLOCK!.idFromName(player)) as unknown as DurableObjectStub<PlayClock>;
export const gameTally = (env: Env, project: string) => env.GAME_TALLY!.get(env.GAME_TALLY!.idFromName(project)) as unknown as DurableObjectStub<GameTally>;

export class PlayClock extends DurableObject<Env> {
  private book: Book | null = null;
  private alarmSet = false;

  private async load(): Promise<Book> {
    if (!this.book) {
      // a new clock owes nothing yet: its first tally and database write are a minute and five minutes away, not now
      this.book = (await this.ctx.storage.get<Book>('book')) || { ...emptyBook(), tallied_at: Date.now(), flushed_at: Date.now() };
      this.alarmSet = (await this.ctx.storage.getAlarm()) != null;
    }
    return this.book;
  }

  /** Brings a session into the book from the database the first time it is seen here. */
  private async session(book: Book, sid: string, player: string, t: number): Promise<ClockSession | null> {
    if (book.sessions[sid]) return book.sessions[sid];
    const db = this.env.DB;
    const row = await db.prepare('SELECT id, project_id, version, env, user_id, kind, started_at, seen_at, seconds, counted, counted_at, trial, trial_seconds, trial_until, last_beat_at, frames, ready, errors FROM plays WHERE id = ? AND user_id = ?')
      .bind(sid, player).first<PlayRow & { counted_at: number | null; last_beat_at: number; frames: number; ready: number; errors: number }>();
    if (!row || row.kind === 'verify' || row.trial) return null;
    await this.scope(book, row.project_id, row.env, player);
    if (!book.sessions[sid]) book.sessions[sid] = { ...fromRow(row, t), bound_at: 0 };
    return book.sessions[sid];
  }

  /** The player's one clock for a game (and when they last added a counted play), read once from the database. */
  private async scope(book: Book, project: string, env: string, player: string) {
    const scope = scopeOf(project, env);
    if (book.scopes[scope]) return;
    const r = await this.env.DB.prepare(`SELECT (SELECT clock_at FROM player_games WHERE project_id = ?1 AND user_id = ?2) AS clock_at,
        (SELECT MAX(counted_at) FROM plays WHERE user_id = ?2 AND project_id = ?3 AND env = 'live' AND counted_at IS NOT NULL) AS counted_at`)
      .bind(scope, player, project).first<{ clock_at: number | null; counted_at: number | null }>();
    // another session of this scope may have been credited in the book since the read started
    book.scopes[scope] ||= { clock_at: r?.clock_at ?? 0, last_counted_at: r?.counted_at ?? 0, clock_saved: r?.clock_at ?? 0 };
  }

  /** A session as it starts (POST /play, after the database has it): the clock takes it without reading it back. */
  async open(row: PlayRow, t: number): Promise<void> {
    const book = await this.load();
    if (row.kind === 'verify' || row.trial) return;
    await this.scope(book, row.project_id, row.env, row.user_id);
    if (!book.sessions[row.id]) openInBook(book, row, t);
    await this.after(book, t, true);
  }

  /** The session must still belong to the sign-in (or unclaimed guest) that started it: confirmed at most once a minute. */
  private async bound(s: ClockSession, t: number): Promise<ClockRefusal | null> {
    if (t - s.bound_at < BIND_EVERY_MS) return null;
    const problem = await bindingProblem(this.env.DB, { s: s.id, u: s.user_id, g: s.project_id, e: s.env, k: s.kind === 'verify' ? 'verify' : s.kind }, t);
    if (problem) return { ok: false, reason: 'ended', code: problem.code, message: problem.message };
    s.bound_at = t;
    return null;
  }

  async checkIn(sid: string, player: string, visibleMs: unknown, t: number, minSeconds: number): Promise<CheckinResult | ClockRefusal> {
    const book = await this.load();
    const s = await this.session(book, sid, player, t);
    if (!s) return { ok: false, reason: 'unknown' };
    const refused = await this.bound(s, t);
    if (refused) return refused;
    const r = checkInBook(book, sid, player, visibleMs, t, minSeconds);
    await this.after(book, t, r.ok);
    return r;
  }

  async beat(b: BeatIn): Promise<{ ok: true; seconds: number } | ClockRefusal> {
    const book = await this.load();
    const s = await this.session(book, b.sid, b.player, b.t);
    if (!s || s.project_id !== b.tok.g) return { ok: false, reason: 'unknown' };
    const refused = await this.bound(s, b.t);
    if (refused) return refused;
    const errs = b.errors.slice(0, 5).map((e) => String(e).slice(0, 500));
    const wasReady = s.ready, newErrors = errs.length + (b.fatal ? 1 : 0);
    beatBook(book, b.sid, b.frames, newErrors, b.t);
    const db = this.env.DB, stmts: D1PreparedStatement[] = [];
    // New error messages and a creator qualifying a preview are rare and are written at once, as before.
    for (const m of errs) {
      stmts.push(db.prepare(`INSERT INTO client_errors (project_id, version, env, message, first_at, last_at) SELECT ?1, ?2, ?3, ?4, ?5, ?5
        WHERE (SELECT COUNT(*) FROM client_errors WHERE project_id = ?1 AND version = ?2 AND env = ?3) < ?6
           OR EXISTS (SELECT 1 FROM client_errors WHERE project_id = ?1 AND version = ?2 AND env = ?3 AND message = ?4)
        ON CONFLICT(project_id, version, env, message) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).bind(s.project_id, s.version, s.env, m, b.t, MAX_ERROR_KINDS));
    }
    if (s.kind === 'owner' && s.env === 'preview' && !s.human_ok_sent && (b.t - s.started_at) / 1000 >= b.human_min_seconds && s.errors === 0) {
      stmts.push(db.prepare('UPDATE versions SET human_ok = 1 WHERE project_id = ? AND n = ? AND human_ok = 0').bind(s.project_id, s.version));
      s.human_ok_sent = true;
    }
    if (stmts.length) await db.batch(stmts);
    await this.after(book, b.t, !wasReady || newErrors > 0 || stmts.length > 0);
    return { ok: true, seconds: s.seconds };
  }

  /** Writes everything this player's clock holds to the database now (before a refund reads the play time). */
  async flush(t = Date.now()): Promise<void> {
    const book = await this.load();
    await this.writeOut(book, t, true);
    await this.persist(book, t);
  }

  /** What is due after a check-in or heartbeat: tallies, the database, saving the book, and the alarm that ends sessions.
      `changed`: the book holds something a restart must not lose (credited time, a counted play, the game starting). */
  private async after(book: Book, t: number, changed: boolean) {
    // What was sent to a tally or written to the database is saved in the same turn too: a book restored from storage
    // must never owe again what was already paid (that would count it twice).
    let sent = false;
    if (t - book.tallied_at >= TALLY_EVERY_MS) { await this.sendTallies(book, t); sent = true; }
    if (t - book.flushed_at >= FLUSH_EVERY_MS) sent = (await this.writeOut(book, t, false)) || sent;
    if (changed || sent || t - book.persisted_at >= PERSIST_EVERY_MS) await this.persist(book, t);
    if (!this.alarmSet) { await this.ctx.storage.setAlarm(t + ALARM_EVERY_MS); this.alarmSet = true; }
  }

  private async persist(book: Book, t: number) { book.persisted_at = t; await this.ctx.storage.put('book', book); }

  private async sendTallies(book: Book, t: number) {
    const adds = takeTally(book, t);
    await Promise.all(adds.map((a) => gameTally(this.env, a.project).add(a).catch((e: unknown) => {
      // not lost: owed again with the next check-in
      console.error('tally failed', a.project, String((e as Error)?.message || e));
      const back = (book.tally[a.project] ||= { project: a.project, days: {}, seen: [] });
      for (const [d, v] of Object.entries(a.days)) { const x = (back.days[d] ||= { seconds: 0, plays: 0 }); x.seconds += v.seconds; x.plays += v.plays; if (v.sessions) x.sessions = (x.sessions || 0) + v.sessions; }
      back.seen.push(...a.seen);
    })));
  }

  /** Writes changed sessions and the player's records in one batch. `all` also writes sessions that are still going. */
  private async writeOut(book: Book, t: number, all: boolean): Promise<boolean> {
    const dirty = dirtySessions(book);
    if (!dirty.length) { book.flushed_at = t; return false; }
    const db = this.env.DB, stmts: D1PreparedStatement[] = [];
    for (const s of dirty) {
      stmts.push(db.prepare('UPDATE plays SET seen_at = ?, seconds = ?, counted = ?, counted_at = ?, last_beat_at = ?, frames = ?, ready = MAX(ready, ?), errors = ? WHERE id = ?')
        .bind(s.seen_at, s.seconds, s.counted, s.counted_at, s.last_beat_at, s.frames, s.ready, s.errors, s.id));
      if (s.kind !== 'verify' && (s.record_add || (s.record_first && s.seen_at !== null))) {
        const scope = scopeOf(s.project_id, s.env), sc = book.scopes[scope], at = s.seen_at ?? t;
        stmts.push(db.prepare(`INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, last_version, clock_at) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)
          ON CONFLICT(project_id, user_id) DO UPDATE SET last_at = MAX(player_games.last_at, excluded.last_at), sessions = player_games.sessions + excluded.sessions,
            seconds = player_games.seconds + excluded.seconds, last_version = excluded.last_version, clock_at = MAX(COALESCE(player_games.clock_at, 0), excluded.clock_at)`)
          .bind(scope, s.user_id, at, s.record_first ? 1 : 0, s.record_add, s.version, sc?.clock_at ?? at));
      }
    }
    if (!all && !stmts.length) return false;
    await db.batch(stmts);
    markFlushed(book, dirty, t);
    return true;
  }

  async alarm(): Promise<void> {
    const t = Date.now(), book = await this.load();
    this.alarmSet = false;
    try {
      await this.sendTallies(book, t);
      await this.writeOut(book, t, true);
      dropIdle(book, t);
    } finally {
      await this.persist(book, t);
      // keep ticking while any session is still open, so the last minutes of a session reach the database
      if (Object.keys(book.sessions).length) { await this.ctx.storage.setAlarm(t + ALARM_EVERY_MS); this.alarmSet = true; }
    }
  }

  /** For tests and the admin: how many sessions this clock holds and whether any is over. */
  async stats(t = Date.now()) { const b = await this.load(); return { sessions: Object.keys(b.sessions).length, idle: idleSessions(b, t).length }; }
}

/** One game's tally: running totals from its players' clocks, written to the database every TALLY_WRITE_EVERY_MS. */
export class GameTally extends DurableObject<Env> {
  private tally: Tally | null = null;
  private project = '';
  private alarmAt: number | null | undefined;

  private async load(): Promise<Tally> {
    return (this.tally ??= (await this.ctx.storage.get<Tally>('tally')) || emptyTally());
  }

  // Each player's clock adds here about once a minute. The object can be shut down between two adds, so each add is
  // saved before it is acknowledged (the clock that sent it has already forgotten it), and the alarm writes it out.
  async add(a: TallyAdd): Promise<void> {
    const tl = await this.load(), t = Date.now();
    this.project ||= (await this.ctx.storage.get<string>('project')) || '';
    if (this.project !== a.project) { this.project = a.project; await this.ctx.storage.put('project', a.project); }
    addToTally(tl, a);
    if (t - tl.written_at >= TALLY_WRITE_EVERY_MS) await this.write(tl, t);
    else { await this.ctx.storage.put('tally', tl); await this.alarmBy(tl.written_at + TALLY_WRITE_EVERY_MS); }
  }

  private async alarmBy(at: number) {
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (this.alarmAt == null) { await this.ctx.storage.setAlarm(at); this.alarmAt = at; }
  }

  private async write(tl: Tally, t: number) {
    const pid = this.project || (await this.ctx.storage.get<string>('project')) || '';
    if (!pid) return;
    const db = this.env.DB, stmts: D1PreparedStatement[] = [];
    let seconds = 0, plays = 0;
    for (const [day, d] of Object.entries(tl.days)) {
      if (!d.seconds && !d.plays && !d.sessions) continue;
      seconds += d.seconds; plays += d.plays;
      stmts.push(db.prepare('INSERT INTO game_daily (project_id, day, sessions, plays, seconds) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, day) DO UPDATE SET sessions = sessions + excluded.sessions, plays = plays + excluded.plays, seconds = seconds + excluded.seconds')
        .bind(pid, day, d.sessions || 0, d.plays, d.seconds));
    }
    if (seconds || plays) stmts.push(db.prepare('UPDATE projects SET seconds = seconds + ?, plays = plays + ? WHERE id = ?').bind(seconds, plays, pid));
    const on = onlineOf(tl, t), key = `${on.live}/${on.preview}/${on.live_sessions}`;
    // who is online changes the database only when the numbers change (and is refreshed now and then, so it never looks stale)
    if (key !== tl.online_written || t - (tl.online_at || 0) >= TALLY_ONLINE_REFRESH_MS) {
      stmts.push(db.prepare(`INSERT INTO game_online (project_id, live_players, preview_players, live_sessions, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET live_players = excluded.live_players, preview_players = excluded.preview_players, live_sessions = excluded.live_sessions, updated_at = excluded.updated_at`)
        .bind(pid, on.live, on.preview, on.live_sessions, t));
      stmts.push(db.prepare('UPDATE projects SET playing = ? WHERE id = ? AND playing != ?').bind(on.live, pid, on.live));
      tl.online_at = t;
    }
    if (stmts.length) await db.batch(stmts);
    tl.days = {}; tl.written_at = t; tl.online_written = key;
    await this.ctx.storage.put('tally', tl);
    // keep counting players down to zero, then stop
    if (Object.keys(tl.seen).length || on.live || on.preview) { await this.ctx.storage.setAlarm(t + TALLY_WRITE_EVERY_MS); this.alarmAt = t + TALLY_WRITE_EVERY_MS; }
  }

  async alarm(): Promise<void> { this.alarmAt = null; await this.write(await this.load(), Date.now()); }
}
