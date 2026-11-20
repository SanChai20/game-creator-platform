// The play clock's rules, kept in memory (src/clock-do.ts holds one book per player in a Durable Object). These are the
// same rules src/play-clock.ts applies against the database: one clock per player per game, a check-in credits what the
// page saw on screen but never more than the server's clock or MAX_CREDIT_MS, a session counts as a play once it passes
// the minimum, and a player adds at most one counted play per game an hour. Pure: no I/O, so tests run it directly.
import { COUNT_EVERY_MS, MAX_SESSION_MS, MIN_GAP_MS, creditSeconds, type CheckinResult, type PlayRow } from './play-clock';

export interface ClockSession {
  id: string; project_id: string; version: number; env: string; user_id: string; kind: string;
  started_at: number; seen_at: number | null; seconds: number; counted: number; counted_at: number | null;
  last_beat_at: number; frames: number; ready: number; errors: number;
  /** what the database already holds for this session, so a flush writes only what changed */
  saved: { seen_at: number | null; seconds: number; counted: number; last_beat_at: number; frames: number; ready: number; errors: number };
  /** seconds credited to the player's record since the last flush; whether this session still has to add itself to the record */
  record_add: number; record_first: boolean;
  /** when the sign-in this session is bound to was last confirmed */
  bound_at: number; human_ok_sent: boolean;
}
/** Per game scope (the game, or "<game>:preview"): the player's one clock, and when they last added a counted play. */
export interface ClockScope { clock_at: number; last_counted_at: number; clock_saved: number }
/** Play time, counted plays and (sessions the clock was handed at their start) sessions started, for one UTC day. */
export interface DayAdd { seconds: number; plays: number; sessions?: number }
/** What a game's tally is owed: its days, and who was seen playing. */
export interface TallyAdd { project: string; days: Record<string, DayAdd>; seen: { sid: string; env: string; player: string; at: number }[] }

export interface Book {
  sessions: Record<string, ClockSession>;
  scopes: Record<string, ClockScope>;
  tally: Record<string, TallyAdd>;
  persisted_at: number; tallied_at: number; flushed_at: number;
}
export const emptyBook = (): Book => ({ sessions: {}, scopes: {}, tally: {}, persisted_at: 0, tallied_at: 0, flushed_at: 0 });

/** How often a play clock saves its book to its own storage, sends its tallies, and writes to the database. */
export const PERSIST_EVERY_MS = 60_000;
export const TALLY_EVERY_MS = 60_000;
export const FLUSH_EVERY_MS = 5 * 60_000;
/** A session with no check-in or heartbeat for this long is over: written out and dropped from the book. */
export const IDLE_AFTER_MS = 2 * 60_000;
/** The sign-in a session is bound to is confirmed at most this often. */
export const BIND_EVERY_MS = 60_000;

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
export const scopeOf = (game: string, env: string) => `${game}${env === 'preview' ? ':preview' : ''}`;

/** A session row from the database, as the book keeps it. */
export function fromRow(p: PlayRow & { counted_at?: number | null; last_beat_at?: number; frames?: number; ready?: number; errors?: number }, t: number): ClockSession {
  const s = {
    id: p.id, project_id: p.project_id, version: p.version, env: p.env, user_id: p.user_id, kind: p.kind,
    started_at: p.started_at, seen_at: p.seen_at, seconds: p.seconds, counted: p.counted, counted_at: p.counted_at ?? null,
    last_beat_at: p.last_beat_at ?? p.started_at, frames: p.frames ?? 0, ready: p.ready ?? 0, errors: p.errors ?? 0,
  };
  return { ...s, saved: { seen_at: s.seen_at, seconds: s.seconds, counted: s.counted, last_beat_at: s.last_beat_at, frames: s.frames, ready: s.ready, errors: s.errors },
    record_add: 0, record_first: p.seen_at === null, bound_at: t, human_ok_sent: false };
}

function owe(book: Book, s: ClockSession, t: number, add: number, counted: boolean, started = false) {
  const tl = (book.tally[s.project_id] ||= { project: s.project_id, days: {}, seen: [] });
  if (s.kind === 'player' && s.env === 'live' && (add || counted || started)) {
    const d = (tl.days[dayOf(t)] ||= { seconds: 0, plays: 0 });
    d.seconds += add; d.plays += counted ? 1 : 0;
    if (started) d.sessions = (d.sessions || 0) + 1;
  }
  const at = tl.seen.findIndex((x) => x.sid === s.id);
  const seen = { sid: s.id, env: s.env, player: s.user_id, at: t };
  if (at >= 0) tl.seen[at] = seen; else tl.seen.push(seen);
}

/**
 * A check-in from the page showing the game, against the book. The same outcome src/play-clock.ts checkIn gives for the
 * same sequence of check-ins: the session's clock moves, time is credited once across the player's sessions of a game,
 * and the play counts once it passes the minimum (at most once an hour per player and game).
 */
export function checkInBook(book: Book, sid: string, player: string, visibleMs: unknown, t: number, minSeconds: number): CheckinResult {
  const s = book.sessions[sid];
  if (!s || s.user_id !== player || s.kind === 'verify') return { ok: false, reason: 'unknown' };
  if (t - s.started_at > MAX_SESSION_MS) return { ok: false, reason: 'too_old' };
  const prev = s.seen_at ?? s.started_at;
  if (s.seen_at !== null && t - prev < MIN_GAP_MS) return { ok: false, reason: 'too_soon' };
  const sc = book.scopes[scopeOf(s.project_id, s.env)];
  const add = creditSeconds(Math.max(prev, sc.clock_at), t, visibleMs);
  if (add) sc.clock_at = t;
  const total = s.seconds + add;
  const counts = s.kind === 'player' && s.env === 'live';
  const becameCounted = counts && !s.counted && total >= minSeconds && !(sc.last_counted_at > t - COUNT_EVERY_MS);
  s.seen_at = t; s.seconds = total; s.record_add += add;
  if (becameCounted) { s.counted = 1; s.counted_at = t; sc.last_counted_at = t; }
  owe(book, s, t, counts ? add : 0, becameCounted);
  return { ok: true, counted: !!s.counted, seconds: total };
}

/**
 * A session handed to the clock as it starts (POST /play): the clock never has to read it back, its sign-in was checked
 * just now, and the game's tally counts it in the day's sessions (instead of a database write per start).
 */
export function openInBook(book: Book, row: PlayRow, t: number): ClockSession {
  const s = (book.sessions[row.id] = fromRow(row, t));
  owe(book, s, t, 0, false, true);
  return s;
}

/** The game's heartbeat: it started, its frame count and how many errors it reported. It moves no play number. */
export function beatBook(book: Book, sid: string, frames: unknown, newErrors: number, t: number): ClockSession | null {
  const s = book.sessions[sid];
  if (!s) return null;
  s.last_beat_at = t; s.frames = Number(frames) || 0; s.ready = 1; s.errors += Math.max(0, newErrors);
  owe(book, s, t, 0, false);
  return s;
}

/** The sessions whose database row is out of date, and those that are over (idle for IDLE_AFTER_MS). */
export function dirtySessions(book: Book): ClockSession[] {
  return Object.values(book.sessions).filter((s) => s.record_add || s.record_first && s.seen_at !== null
    || s.seen_at !== s.saved.seen_at || s.seconds !== s.saved.seconds || s.counted !== s.saved.counted
    || s.last_beat_at !== s.saved.last_beat_at || s.frames !== s.saved.frames || s.errors !== s.saved.errors || s.ready !== s.saved.ready);
}
export const lastActive = (s: ClockSession) => Math.max(s.seen_at ?? s.started_at, s.last_beat_at);
export const idleSessions = (book: Book, t: number) => Object.values(book.sessions).filter((s) => t - lastActive(s) > IDLE_AFTER_MS);

/** Marks a flush as written: what the database holds now equals the book. */
export function markFlushed(book: Book, written: ClockSession[], t: number) {
  for (const s of written) {
    s.saved = { seen_at: s.seen_at, seconds: s.seconds, counted: s.counted, last_beat_at: s.last_beat_at, frames: s.frames, ready: s.ready, errors: s.errors };
    s.record_add = 0; if (s.seen_at !== null) s.record_first = false;
  }
  for (const sc of Object.values(book.scopes)) sc.clock_saved = sc.clock_at;
  book.flushed_at = t;
}

/** Takes what the tallies are owed (sent once, then forgotten). */
export function takeTally(book: Book, t: number): TallyAdd[] {
  const out = Object.values(book.tally).filter((x) => Object.keys(x.days).length || x.seen.length);
  book.tally = {}; book.tallied_at = t;
  return out;
}

/** Drops sessions that are over (after they were written out) and scopes no session uses any more. */
export function dropIdle(book: Book, t: number) {
  for (const s of idleSessions(book, t)) delete book.sessions[s.id];
  const used = new Set(Object.values(book.sessions).map((s) => scopeOf(s.project_id, s.env)));
  for (const k of Object.keys(book.scopes)) if (!used.has(k)) delete book.scopes[k];
}

// ----- the game tally -------------------------------------------------------------------------------------------------
/** One game's running totals between database writes, and who was seen playing it lately. */
export interface Tally { days: Record<string, DayAdd>; seen: Record<string, { env: string; player: string; at: number }>; written_at: number; online_written: string; online_at?: number }
export const emptyTally = (): Tally => ({ days: {}, seen: {}, written_at: 0, online_written: '', online_at: 0 });
/** Players count as online this long after they were last seen (play clocks report every TALLY_EVERY_MS). */
export const TALLY_ONLINE_MS = 90_000;
export const TALLY_WRITE_EVERY_MS = 30_000;
/** Who is online is written again after this long even when the numbers did not change, so readers can tell it is fresh. */
export const TALLY_ONLINE_REFRESH_MS = 5 * 60_000;

export function addToTally(tl: Tally, a: TallyAdd) {
  for (const [day, d] of Object.entries(a.days)) {
    const x = (tl.days[day] ||= { seconds: 0, plays: 0 }); x.seconds += d.seconds; x.plays += d.plays;
    if (d.sessions) x.sessions = (x.sessions || 0) + d.sessions;
  }
  for (const s of a.seen) { const old = tl.seen[s.sid]; if (!old || old.at < s.at) tl.seen[s.sid] = { env: s.env, player: s.player, at: s.at }; }
}
/** Who is online now, per environment (distinct players and sessions); forgets sessions not seen in the window. */
export function onlineOf(tl: Tally, t: number) {
  const out = { live: new Set<string>(), preview: new Set<string>(), live_sessions: 0 };
  for (const [sid, s] of Object.entries(tl.seen)) {
    if (t - s.at > TALLY_ONLINE_MS) { delete tl.seen[sid]; continue; }
    if (s.env === 'live') { out.live.add(s.player); out.live_sessions++; } else out.preview.add(s.player);
  }
  return { live: out.live.size, preview: out.preview.size, live_sessions: out.live_sessions };
}
