// Game analytics for creators: who is playing right now, and how the game has been played over a window of days.
// Every number is the platform's own observation (src/play-clock.ts): sessions are started by the platform, play time and
// players online come from check-ins of the page that shows the game (on the platform's origin, never the game's), the
// device comes from that page's request, and rooms are counted by the room servers. What the game reports about itself
// (that it started, the errors it hit) is kept apart under reported_by_game and never feeds the other numbers.
// Only real players of the live game are counted in the history; the creator's own plays and the verifier are not.
import type { Env } from './env';
import { addDays, dayOf, now } from './util';
import { getSettings } from './settings';
// @ts-ignore plain JS module
import { eventDaily, eventSummary, funnel, retentionOf } from './events.js';
export { retentionOf };

export const ONLINE_WINDOW_MS = 90_000;        // three check-ins of the page showing the game missed and a player no longer counts as online
const ROOM_STALE_MS = 12 * 3600_000;    // presence rows older than this are from a room that never said goodbye

export type Device = 'phone' | 'tablet' | 'desktop' | 'other';
/** A coarse, privacy-friendly reading of a User-Agent: the kind of device and the browser family, nothing finer. */
export function readAgent(ua: string | null | undefined): { device: Device; browser: string; os: string } {
  const s = String(ua || '');
  if (!s) return { device: 'other', browser: 'Unknown', os: 'Unknown' };
  const tablet = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s), phone = !tablet && /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(s);
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /CriOS|Chrome\/|Chromium/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Other';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'Other';
  return { device: tablet ? 'tablet' : phone ? 'phone' : /Windows|Macintosh|X11|CrOS|Linux/.test(s) ? 'desktop' : 'other', browser, os };
}

const LENGTHS: [string, number][] = [['under 30 s', 30], ['30 s to 2 min', 120], ['2 to 5 min', 300], ['5 to 15 min', 900], ['15 to 30 min', 1800], ['over 30 min', Infinity]];

/** Players online now: a session whose page checked in under a minute ago. */
export async function onlineNow(env: Env, pid: string) {
  const t = now(), since = t - ONLINE_WINDOW_MS, atScale = (await getSettings(env)).play_clock_do;
  const [online, rooms] = await Promise.all([
    // at scale the game's tally keeps the numbers (src/clock-do.ts); otherwise they come from the sessions' check-ins
    atScale ? env.DB.prepare("SELECT 'live' AS env, live_players AS players, live_sessions AS sessions FROM game_online WHERE project_id = ?1 AND updated_at > ?2 UNION ALL SELECT 'preview', preview_players, 0 FROM game_online WHERE project_id = ?1 AND updated_at > ?2").bind(pid, t - 6 * 60_000).all<{ env: string; players: number; sessions: number }>() :
    env.DB.prepare("SELECT env, COUNT(DISTINCT user_id) AS players, COUNT(*) AS sessions FROM plays WHERE project_id = ? AND seen_at > ? AND kind != 'verify' GROUP BY env").bind(pid, since).all<{ env: string; players: number; sessions: number }>(),
    env.DB.prepare('SELECT env, room, players, updated_at FROM room_presence WHERE project_id = ? AND players > 0 AND updated_at > ? ORDER BY players DESC, updated_at DESC LIMIT 100').bind(pid, t - ROOM_STALE_MS).all<{ env: string; room: string; players: number; updated_at: number }>(),
  ]);
  const of = (e: string) => online.results.find((r) => r.env === e) || { players: 0, sessions: 0 };
  const liveRooms = rooms.results.filter((r) => r.env === 'live');
  return {
    at: new Date(t).toISOString(),
    online: { live: of('live').players, preview: of('preview').players, live_sessions: of('live').sessions },
    rooms: { live: liveRooms.length, players_in_rooms: liveRooms.reduce((a, r) => a + r.players, 0), busiest: rooms.results.map((r) => ({ room: r.room, env: r.env, players: r.players, since: new Date(r.updated_at).toISOString() })) },
    note: 'Online means the page showing the game checked in with the platform in the last 90 seconds (it does every 30 seconds while the game is open). The game\'s own heartbeats do not count. Rooms count players connected to GCP.room right now, as the room servers see them.',
  };
}

/** The full picture for the console's analytics tab and the get_stats tool. */
export async function gameAnalytics(env: Env, pid: string, daysIn = 30, funnelSteps?: string[]) {
  const days = Math.max(1, Math.min(90, Math.round(daysIn) || 30)), t = now(), today = dayOf(t), firstDay = addDays(today, -(days - 1));
  const since = Date.parse(firstDay + 'T00:00:00Z'), db = env.DB;
  const base = "FROM plays WHERE project_id = ?1 AND env = 'live' AND kind = 'player' AND started_at >= ?2";
  const [live, totals, daily, firsts, hourly, lengths, versions, agents, errors, errorTotals] = await Promise.all([
    onlineNow(env, pid),
    db.prepare(`SELECT COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS players, COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(counted), 0) AS plays, COALESCE(SUM(CASE WHEN errors > 0 THEN 1 ELSE 0 END), 0) AS error_sessions, COALESCE(SUM(CASE WHEN ready = 0 THEN 1 ELSE 0 END), 0) AS never_started ${base}`).bind(pid, since).first<{ sessions: number; players: number; seconds: number; plays: number; error_sessions: number; never_started: number }>(),
    db.prepare(`SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day, COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS players, COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(counted), 0) AS plays ${base} GROUP BY day ORDER BY day`).bind(pid, since).all<{ day: string; sessions: number; players: number; seconds: number; plays: number }>(),
    // each player's first live session ever, to tell new players from returning ones
    db.prepare("SELECT user_id, MIN(started_at) AS first_at, COUNT(DISTINCT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch')) AS active_days FROM plays WHERE project_id = ?1 AND env = 'live' AND kind = 'player' GROUP BY user_id HAVING MAX(started_at) >= ?2").bind(pid, since).all<{ user_id: string; first_at: number; active_days: number }>(),
    db.prepare(`SELECT CAST((started_at - ?3) / 3600000 AS INTEGER) AS h, COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS players FROM plays WHERE project_id = ?1 AND env = 'live' AND kind = 'player' AND started_at >= ?3 GROUP BY h`).bind(pid, since, t - 24 * 3600_000).all<{ h: number; sessions: number; players: number }>(),
    db.prepare(`SELECT seconds ${base}`).bind(pid, since).all<{ seconds: number }>(),
    db.prepare(`SELECT version, COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS players, COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(CASE WHEN errors > 0 THEN 1 ELSE 0 END), 0) AS error_sessions ${base} GROUP BY version ORDER BY version DESC LIMIT 200`).bind(pid, since).all<{ version: number; sessions: number; players: number; seconds: number; error_sessions: number }>(),
    db.prepare(`SELECT ua, COUNT(*) AS sessions, COALESCE(SUM(seconds), 0) AS seconds ${base} GROUP BY ua ORDER BY sessions DESC LIMIT 500`).bind(pid, since).all<{ ua: string | null; sessions: number; seconds: number }>(),
    db.prepare("SELECT version, message, count, first_at, last_at FROM client_errors WHERE project_id = ? AND env = 'live' AND last_at >= ? ORDER BY count DESC, last_at DESC LIMIT 15").bind(pid, since).all<{ version: number; message: string; count: number; first_at: number; last_at: number }>(),
    db.prepare("SELECT COUNT(*) AS kinds, COALESCE(SUM(count), 0) AS total FROM client_errors WHERE project_id = ? AND env = 'live' AND last_at >= ?").bind(pid, since).first<{ kinds: number; total: number }>(),
  ]);
  const [cohort, firstLens, views, events, eventDays, declared] = await Promise.all([
    // every player whose first live session is in the window: when they first played and the last time they did
    db.prepare("SELECT user_id, MIN(started_at) AS first_at, MAX(started_at) AS last_at FROM plays WHERE project_id = ?1 AND env = 'live' AND kind = 'player' GROUP BY user_id HAVING MIN(started_at) >= ?2").bind(pid, since).all<{ user_id: string; first_at: number; last_at: number }>(),
    // how long each of those players' first session lasted
    db.prepare("SELECT seconds FROM (SELECT seconds, started_at, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY started_at) AS rn FROM plays WHERE project_id = ?1 AND env = 'live' AND kind = 'player') WHERE rn = 1 AND started_at >= ?2").bind(pid, since).all<{ seconds: number }>(),
    db.prepare('SELECT COALESCE(SUM(views), 0) AS views FROM game_daily WHERE project_id = ? AND day >= ?').bind(pid, firstDay).first<{ views: number }>(),
    eventSummary(db, pid, since) as Promise<{ name: string; count: number; players: number; total: number; average: number }[]>,
    eventDaily(db, pid, since) as Promise<{ day: string; name: string; count: number }[]>,
    funnelSteps ? Promise.resolve(null) : db.prepare("SELECT json_extract(v.manifest, '$.funnel') AS f FROM projects p JOIN versions v ON v.project_id = p.id AND v.n = p.live_version WHERE p.id = ?").bind(pid).first<{ f: string | null }>(),
  ]);
  const tot = totals || { sessions: 0, players: 0, seconds: 0, plays: 0, error_sessions: 0, never_started: 0 };

  const newPlayers = firsts.results.filter((f) => f.first_at >= since), returning = firsts.results.filter((f) => f.first_at < since || f.active_days > 1);
  const newByDay = new Map<string, number>();
  for (const f of newPlayers) { const d = dayOf(f.first_at); newByDay.set(d, (newByDay.get(d) || 0) + 1); }
  const byDay = new Map(daily.results.map((r) => [r.day, r]));
  const series = Array.from({ length: days }, (_, i) => {
    const day = addDays(firstDay, i), r = byDay.get(day);
    return { day, sessions: r?.sessions || 0, players: r?.players || 0, new_players: newByDay.get(day) || 0, plays: r?.plays || 0, minutes: Math.round((r?.seconds || 0) / 60) };
  });
  const hours = Array.from({ length: 24 }, (_, h) => { const r = hourly.results.find((x) => x.h === h); return { hour: new Date(t - 24 * 3600_000 + h * 3600_000).toISOString().slice(0, 13) + ':00Z', sessions: r?.sessions || 0, players: r?.players || 0 }; });

  const secs = lengths.results.map((r) => r.seconds).sort((a, b) => a - b);
  const median = secs.length ? secs[Math.floor(secs.length / 2)] : 0;
  const buckets = LENGTHS.map(([label, max], i) => ({ label, sessions: secs.filter((s) => s < max && s >= (i ? LENGTHS[i - 1][1] : 0)).length }));

  const tally = (key: 'device' | 'browser' | 'os') => {
    const m = new Map<string, { sessions: number; seconds: number }>();
    for (const a of agents.results) { const k = readAgent(a.ua)[key], v = m.get(k) || { sessions: 0, seconds: 0 }; v.sessions += a.sessions; v.seconds += a.seconds; m.set(k, v); }
    return [...m].map(([name, v]) => ({ name, sessions: v.sessions, share: tot.sessions ? Math.round((v.sessions / tot.sessions) * 1000) / 10 : 0, avg_minutes: v.sessions ? Math.round((v.seconds / v.sessions / 60) * 10) / 10 : 0 })).sort((a, b) => b.sessions - a.sessions);
  };

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const retention = retentionOf(cohort.results, t);
  const first = firstLens.results.map((r) => r.seconds);
  const quitCurve = Array.from({ length: 16 }, (_, m) => ({ minute: m, still_playing: pct(first.filter((s) => s >= m * 60).length, first.length) }));
  const counted = await db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM plays WHERE project_id = ?1 AND env = 'live' AND kind = 'player' AND started_at >= ?2 AND counted = 1").bind(pid, since).first<{ n: number }>();
  const steps = funnelSteps?.length ? funnelSteps : (() => { try { const f = JSON.parse(declared?.f || 'null'); return Array.isArray(f) ? f as string[] : []; } catch { return []; } })();
  return {
    now: live,
    window: { days, from: firstDay, to: today },
    totals: {
      sessions: tot.sessions, players: tot.players, new_players: newPlayers.length, returning_players: returning.length, returning_share: pct(returning.length, firsts.results.length),
      counted_plays: tot.plays, minutes_played: Math.round(tot.seconds / 60), avg_session_minutes: tot.sessions ? Math.round((tot.seconds / tot.sessions / 60) * 10) / 10 : 0, median_session_minutes: Math.round((median / 60) * 10) / 10,
      sessions_per_player: tot.players ? Math.round((tot.sessions / tot.players) * 10) / 10 : 0,
    },
    daily: series,
    last_24_hours: hours,
    session_lengths: buckets,
    versions: versions.results.map((v) => ({ version: v.version, sessions: v.sessions, players: v.players, avg_minutes: v.sessions ? Math.round((v.seconds / v.sessions / 60) * 10) / 10 : 0 })),
    devices: tally('device'), browsers: tally('browser'), systems: tally('os'),
    // Do players come back? Of the players who first played in this window, the share who played again N days or more later.
    retention,
    // How long new players' first session lasted: the share still playing at each minute (minute 0 is everyone).
    first_session: { players: first.length, median_minutes: first.length ? Math.round(([...first].sort((a, b) => a - b)[Math.floor(first.length / 2)] / 60) * 10) / 10 : 0, quick_quit_share: pct(first.filter((s) => s < 60).length, first.length), curve: quitCurve },
    // From the store page to a player who stays: page loads, players who pressed Play, who played long enough to count, who came back.
    store_funnel: [
      { step: 'store_page_loads', count: views?.views || 0 },
      { step: 'players_started', count: tot.players },
      { step: 'players_counted', count: counted?.n || 0 },
      { step: 'players_returned', count: retention.returned },
    ],
    // What the game counts with GCP.track(name, value), and its funnel (gcp.json "funnel", or the steps asked for).
    events: { names: events, daily: eventDays, funnel: steps.length ? await funnel(db, pid, steps, since) as { step: string; players: number; share: number; from_previous: number }[] : [], funnel_steps: steps },
    // What the game says about itself, through its heartbeat. Useful for finding bugs; never used for any number above.
    reported_by_game: {
      note: 'Reported by the game through its heartbeat, not observed by the platform. Shown to help find bugs; the play numbers above never use it.',
      sessions_with_errors: tot.error_sessions, error_session_share: pct(tot.error_sessions, tot.sessions), never_started: tot.never_started,
      versions: versions.results.map((v) => ({ version: v.version, error_session_share: pct(v.error_sessions, v.sessions) })),
      errors: { kinds: errorTotals?.kinds || 0, total: errorTotals?.total || 0, top: errors.results.map((e) => ({ message: e.message, version: e.version, count: e.count, first_seen: new Date(e.first_at).toISOString(), last_seen: new Date(e.last_at).toISOString() })) },
    },
    definitions: {
      session: 'One launch of the live game by a signed-in player, started by the platform when they press Play (your own plays and the verifier are left out).',
      play_time: 'Time the game was on screen on the page that shows it, measured by the platform from that page\'s check-ins every 30 seconds, never from the game. Sessions from before the platform measured it this way used the game\'s heartbeats.',
      counted_play: 'A session with at least the platform\'s minimum play time, at most one per player an hour (a player\'s sessions open side by side share one clock); this is what the marketplace counts.',
      returning_player: 'A player in this window who had played on an earlier day too.',
      device: 'From the browser that pressed Play on the platform\'s page.',
      never_started: 'Reported by the game: sessions where it never said it was running (it did not reach GCP.ready, or the player left first).',
      retention: 'Of the players whose first session was in this window, the share who started another session N days or more after it (rolling retention). Only players who first played at least N days ago are counted for day N.',
      store_page_loads: 'Loads of the game\'s store page by anyone but its creator, counted by the platform.',
      events: 'Counted from GCP.track(name, value) calls by signed-in players of the live game: reported by the game. Unique players reached the event in this window.',
    },
  };
}
