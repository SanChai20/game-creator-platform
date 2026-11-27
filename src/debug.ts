// Agent debugging: a real browser on the game's preview that the agent drives step by step through debug_preview. It
// opens the preview under a throwaway verifier identity (never the creator's saves), takes screenshots, and plays it with
// clicks, taps, drags, keys and typing (src/debug-core.js). Between calls the browser stays open: on Cloudflare Browser
// Rendering the Worker disconnects and reconnects to the same session, locally the verifier keeps the page.
//
// It shares Browser Rendering with verification, so it is kept small: one browser per account, a few across the platform
// (debug_max_sessions), a daily allowance per account, a hard lifetime (debug_session_minutes) and an idle timeout, and
// one call at a time per browser. Only the game's owner can open one, on their own preview.
import puppeteer from '@cloudflare/puppeteer';
import { AppError, bad, forbidden, type Env, type Project, type User } from './env';
import { rateLimit } from './auth';
import { gameUrl, playKey } from './deploy';
import { ensurePreview } from './cleanup';
import { logEvent } from './projects';
import { getSettings } from './settings';
import { b64, now, parseJson, rid, unb64 } from './util';
// @ts-ignore plain JS module shared with the local verifier and the tests
import { DEBUG_LIMITS, StepError, callShots, checkSteps, gameState, openGame, runSteps, useViewport, viewportOf } from './debug-core.js';
// @ts-ignore plain JS module
import { signPlayToken } from './runtime/game-worker.js';
// @ts-ignore plain JS module
import { verifierId } from './player-data.js';

const IDLE_MS = 3 * 60000;      // a browser nobody drove for this long is closed (Browser Rendering's keep_alive)
const CALL_MS = 45000;          // longest one call may hold its browser
type DebugEnv = Env & { VERIFIER_URL?: string };

interface Row { id: string; user_id: string; project_id: string; version: number; browser_id: string; play_sid: string; viewport: string; created_at: number; last_at: number; expires_at: number; busy_until: number | null; calls: number; closed_at: number | null }
export interface Shot { label: string; bytes: Uint8Array; type?: string; zoom?: number; note?: string }
export interface DebugResult { session: string; version: number; viewport: { width: number; height: number; touch: boolean; name: string }; log: unknown[]; shots: Shot[]; state: Record<string, unknown>; stopped?: number; expires_at: number; opened?: { started: boolean; ms: number } }

const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof StepError) throw bad(e.message); throw e; } };

// ---- the browser: Browser Rendering, or the local verifier's /debug endpoint in development --------------------------
interface Driver {
  open(url: string, vp: ReturnType<typeof viewportOf>, steps: unknown[]): Promise<{ id: string; opened: { started: boolean; ms: number }; out: Omit<DebugResult, 'session' | 'version' | 'viewport' | 'expires_at'> }>;
  act(id: string, steps: unknown[], vp: ReturnType<typeof viewportOf>): Promise<Omit<DebugResult, 'session' | 'version' | 'viewport' | 'expires_at'>>;
  close(id: string): Promise<void>;
}

async function drive(page: any, steps: unknown[]) {
  const f0 = await gameState(page).catch(() => ({ frames: 0 })), t0 = Date.now();
  const run = await runSteps(page, steps);
  const shots: Shot[] = await callShots(page, steps, run);
  const state = await gameState(page).catch((e: Error) => ({ error: String(e.message || e) }));
  const dt = Date.now() - t0, df = (state.frames ?? 0) - (f0.frames ?? 0);
  // frames per second over the call: how the game ran on this browser (it has no GPU, so 3D games run slowly here)
  if (dt > 600 && typeof state.frames === 'number') state.fps_during_call = Math.round((df * 1000) / dt);
  return { log: run.log, shots, state, ...(run.stopped ? { stopped: run.stopped } : {}) };
}

function browserRendering(env: DebugEnv): Driver {
  if (!env.BROWSER) throw new AppError(503, 'No browser is configured on this deployment.', 'unavailable');
  const B = env.BROWSER as any;
  const pageOf = async (browser: any) => { const pages = await browser.pages(); const p = pages.find((x: any) => !x.url().startsWith('about:')) || pages[0]; if (!p) throw new AppError(410, 'The debug browser lost its page. Open a new session.', 'gone'); return p; };
  return {
    async open(url, vp, steps) {
      const browser = await puppeteer.launch(B, { keep_alive: IDLE_MS });
      try {
        const page = await browser.newPage();
        const opened = await openGame(page, url, vp);
        const out = await drive(page, steps);
        const id = browser.sessionId();
        await browser.disconnect();
        return { id, opened, out };
      } catch (e) { await browser.close().catch(() => {}); throw e; }
    },
    async act(id, steps, vp) {
      let browser: any;
      try { browser = await puppeteer.connect(B, id); } catch { throw new AppError(410, 'The debug browser has closed (it closes after 3 idle minutes). Open a new session.', 'gone'); }
      try { const page = await pageOf(browser); await useViewport(page, vp); return await drive(page, steps); } finally { await browser.disconnect().catch(() => {}); }
    },
    async close(id) {
      try { const browser = await puppeteer.connect(B, id); await browser.close(); } catch { /* already closed */ }
    },
  };
}

function localVerifier(env: DebugEnv): Driver {
  const call = async (body: Record<string, unknown>) => {
    const r = await fetch(new URL('/debug', env.VERIFIER_URL).toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json<any>().catch(() => ({}));
    if (r.status === 410) throw new AppError(410, 'The debug browser has closed. Open a new session.', 'gone');
    if (!r.ok) throw new AppError(502, `Local verifier error: ${j.error || r.status}`, 'unavailable');
    return j;
  };
  const back = (j: any) => ({ log: j.log, state: j.state, shots: (j.shots || []).map((s: any) => ({ label: s.label, bytes: unb64(s.b64), type: s.type, zoom: s.zoom, note: s.note })), ...(j.stopped ? { stopped: j.stopped } : {}) });
  return {
    async open(url, vp, steps) { const j = await call({ op: 'open', url, viewport: vp, steps }); return { id: j.id, opened: j.opened, out: back(j) }; },
    async act(id, steps) { return back(await call({ op: 'act', id, steps })); },
    async close(id) { await call({ op: 'close', id }).catch(() => {}); },
  };
}
const driverOf = (env: DebugEnv): Driver => (env.VERIFIER_URL ? localVerifier(env) : browserRendering(env));

// ---- sessions ------------------------------------------------------------------------------------------------------
async function openRow(env: Env, user: User, sid?: string): Promise<Row | null> {
  const t = now();
  return env.DB.prepare(`SELECT * FROM debug_sessions WHERE user_id = ? AND closed_at IS NULL AND expires_at > ? AND last_at > ? ${sid ? 'AND id = ?' : ''} ORDER BY created_at DESC LIMIT 1`)
    .bind(...[user.id, t, t - IDLE_MS, ...(sid ? [sid] : [])]).first<Row>();
}
async function markClosed(env: Env, id: string) { await env.DB.prepare('UPDATE debug_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL').bind(now(), id).run(); }

/** Opens a new debug browser on the project's preview (closing this account's previous one) and runs the first steps. */
export async function openDebug(env: DebugEnv, origin: string, user: User, p: Project, o: { viewport?: unknown; autostart?: boolean; steps?: unknown }, actor: string): Promise<DebugResult> {
  const s = await getSettings(env);
  if (!s.debug_enabled) throw new AppError(403, 'Agent debugging is switched off on this platform.', 'disabled');
  if (p.owner_id !== user.id) throw forbidden('Only the game\'s creator can debug its preview.');
  if (!p.preview_version) throw new AppError(409, 'No preview has been deployed yet.', 'no_preview', 'Call deploy_preview first.');
  const vp = wrap(() => viewportOf(o.viewport)), steps = wrap(() => checkSteps(o.steps, vp));
  const old = await openRow(env, user);
  if (old) { await markClosed(env, old.id); await driverOf(env).close(old.browser_id).catch(() => {}); }
  const t = now();
  const busy = await env.DB.prepare('SELECT COUNT(*) AS n FROM debug_sessions WHERE closed_at IS NULL AND expires_at > ? AND last_at > ?').bind(t, t - IDLE_MS).first<{ n: number }>();
  if ((busy?.n || 0) >= Math.max(1, s.debug_max_sessions)) throw new AppError(429, 'Every debug browser on the platform is in use right now.', 'busy', 'Try again in a few minutes. deploy_preview still verifies the game meanwhile.');
  await rateLimit(env, 'debug:' + user.id, Math.max(1, s.debug_sessions_per_day), 86400);
  await ensurePreview(env, origin, p);   // a preview Worker removed for being idle is deployed again first
  const life = Math.min(10, Math.max(1, s.debug_session_minutes)) * 60000;
  // the game runs as a verifier: its own empty save, kept apart from the creator's and players' data, cleaned up daily
  const sid = 'vf_' + rid(12), key = await playKey(env, p.id), x = Math.floor((t + life) / 1000) + 120;
  await env.DB.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, ?, ?, 'preview', ?, 'verify', ?, ?)").bind(sid, p.id, p.preview_version, p.owner_id, t, t).run();
  // dbg: the agent is testing, so what the game submits (leaderboard scores) is kept on the preview's boards, under "Debugger"
  const token = await signPlayToken({ g: p.id, e: 'preview', u: verifierId(sid), n: 'Debugger', k: 'verify', s: sid, x, dbg: 1 }, key);
  const url = `${await gameUrl(env, origin, p.id, 'preview')}?gcp_t=${token}${o.autostart ? '&gcp_autostart=1' : ''}`;
  let opened;
  try { opened = await driverOf(env).open(url, vp, steps); }
  catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(503, `The debug browser could not start: ${String((e as Error).message || e).slice(0, 200)}`, 'unavailable', 'Try again in a minute.');
  }
  const id = 'dbg_' + rid(12), exp = t + life;
  await env.DB.prepare('INSERT INTO debug_sessions (id, user_id, project_id, version, browser_id, play_sid, viewport, created_at, last_at, expires_at, calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
    .bind(id, user.id, p.id, p.preview_version, opened.id, sid, JSON.stringify(vp), t, now(), exp).run();
  await logEvent(env, p.id, 'debug_opened', `Your agent opened the preview in a debug browser (${vp.width} × ${vp.height})`, p.preview_version, actor);
  return { session: id, version: p.preview_version, viewport: vp, expires_at: exp, opened: opened.opened, ...opened.out };
}

/** Runs more steps in the account's open debug browser. */
export async function actDebug(env: DebugEnv, user: User, p: Project, sid: string | undefined, steps: unknown): Promise<DebugResult> {
  const row = await openRow(env, user, sid);
  if (!row || row.project_id !== p.id) throw new AppError(404, 'No open debug session for this project.', 'no_session', 'Call debug_preview {project, action: "open"} first. A session closes after 3 idle minutes and at most ' + (await getSettings(env)).debug_session_minutes + ' minutes after it opened.');
  const vp = parseJson(row.viewport, { width: 960, height: 540, touch: false, name: 'desktop' }), checked = wrap(() => checkSteps(steps, vp));
  const t = now();
  const lock = await env.DB.prepare('UPDATE debug_sessions SET busy_until = ?, calls = calls + 1 WHERE id = ? AND (busy_until IS NULL OR busy_until < ?)').bind(t + CALL_MS, row.id, t).run();
  if (!lock.meta.changes) throw new AppError(409, 'Another call is driving this debug browser right now.', 'busy', 'Wait for it to finish, then call again. Calls on one session run one at a time.');
  try {
    const out = await driverOf(env).act(row.browser_id, checked, vp);
    return { session: row.id, version: row.version, viewport: vp, expires_at: row.expires_at, ...out };
  } catch (e) {
    if (e instanceof AppError && e.status === 410) await markClosed(env, row.id);
    throw e;
  } finally {
    await env.DB.prepare('UPDATE debug_sessions SET busy_until = NULL, last_at = ? WHERE id = ?').bind(now(), row.id).run();
  }
}

export async function closeDebug(env: DebugEnv, user: User, sid?: string, projectId?: string) {
  const row = await openRow(env, user, sid);
  if (!row || (projectId && row.project_id !== projectId)) return { closed: false, note: 'No debug session was open.' };
  await markClosed(env, row.id);
  await driverOf(env).close(row.browser_id);
  return { closed: true, session: row.id };
}

/** Frequent cron: sessions past their lifetime are closed in the browser too (an idle one closes by itself). */
export async function reapDebugSessions(env: DebugEnv) {
  const t = now();
  const rows = await env.DB.prepare('SELECT id, browser_id FROM debug_sessions WHERE closed_at IS NULL AND (expires_at <= ? OR last_at <= ?) LIMIT 20').bind(t, t - IDLE_MS).all<{ id: string; browser_id: string }>();
  for (const r of rows.results) { await markClosed(env, r.id); await driverOf(env).close(r.browser_id).catch(() => {}); }
  await env.DB.prepare('DELETE FROM debug_sessions WHERE created_at < ?').bind(t - 30 * 86400000).run();
  return rows.results.length;
}

export { b64, DEBUG_LIMITS };
