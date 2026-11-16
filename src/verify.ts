import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './env';
import { getSettings } from './settings';
import { b64, unb64 } from './util';
// @ts-ignore plain JS module shared with the Node test harness
import { verifyPage } from './verify-core.js';

/** shot: the version's screenshot. frames: small JPEGs taken while the game was played, for the content review. */
export interface VerifyOutcome { report: Record<string, any>; shot: Uint8Array | null; frames: Uint8Array[] }

/** Opens the deployed preview in a real browser and runs the playability check. */
export async function browserVerify(env: Env & { VERIFIER_URL?: string }, url: string, usesWebGPU: boolean, platformOrigin = ''): Promise<VerifyOutcome> {
  const s = await getSettings(env);
  const opts = { readyTimeoutS: s.verify_ready_timeout_s, minFrames: s.verify_min_frames, observeS: s.verify_observe_s, playthroughS: Math.min(45, Math.max(3, s.verify_playthrough_s)), usesWebGPU, platformOrigin };
  if (env.VERIFIER_URL) { // local development: a Playwright process runs the same check
    const r = await fetch(env.VERIFIER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, opts }) });
    if (!r.ok) return { report: { ok: false, browser: 'unavailable', summary: `Local verifier error ${r.status}`, checks: [], errors: [] }, shot: null, frames: [] };
    const j = await r.json<{ report: Record<string, any>; shot: string | null; frames?: string[] }>();
    return { report: { ...j.report, browser: 'local-playwright' }, shot: j.shot ? unb64(j.shot) : null, frames: (j.frames || []).map(unb64) };
  }
  if (!env.BROWSER) return { report: { ok: false, browser: 'unavailable', summary: 'No verification browser is configured on this deployment.', checks: [], errors: [] }, shot: null, frames: [] };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as any, { keep_alive: 60000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
    // a game with rooms is opened in two more pages of this browser, which meet in one room (GCP.test.onTwoPlayers)
    const openPage = async () => { const p = await browser!.newPage(); await p.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 }); return p; };
    const { report, shots, frames } = await verifyPage(page, url, { ...opts, openPage });
    const shot: Uint8Array | null = shots.length ? new Uint8Array(shots[0]) : null;   // the full-quality portrait when there is one, otherwise the first picture of the game in play past its loading screen
    return { report: { ...report, browser: 'cloudflare-browser-rendering' }, shot, frames: (frames || []).map((f: Uint8Array) => new Uint8Array(f)) };
  } catch (e) {
    return { report: { ok: false, browser: 'unavailable', summary: `The verification browser could not run: ${(e as Error).message}`, checks: [], errors: [] }, shot: null, frames: [] };
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}
export { b64 };
