import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './env';
import { getSettings } from './settings';
import { b64, unb64 } from './util';
// @ts-ignore plain JS module shared with the Node test harness
import { applyDeviceResults, verifyDevices, verifyPage } from './verify-core.js';

/** shot: the version's screenshot. frames: small JPEGs taken while the game was played, for the content review. */
export interface VerifyOutcome { report: Record<string, any>; shot: Uint8Array | null; frames: Uint8Array[] }

/** Opens the deployed preview in a real browser and runs the playability check. */
/** guestUrl: the game with a second verifier's play token, for the guest page of the two-player check.
 *  device: what the version says about phones and tablets (requirements.devices and orientation), for the device pass. */
export interface DeviceTarget { devices: string[]; orientation: string }
export async function browserVerify(env: Env & { VERIFIER_URL?: string }, url: string, usesWebGPU: boolean, platformOrigin = '', guestUrl = '', device: DeviceTarget = { devices: ['desktop', 'tablet', 'mobile'], orientation: 'any' }): Promise<VerifyOutcome> {
  const s = await getSettings(env);
  const profiles = String(s.verify_devices || '').split(',').map((x) => x.trim()).filter(Boolean);
  const opts = { readyTimeoutS: s.verify_ready_timeout_s, minFrames: s.verify_min_frames, observeS: s.verify_observe_s, playthroughS: Math.min(45, Math.max(3, s.verify_playthrough_s)), usesWebGPU, platformOrigin, guestUrl, devices: { profiles, ...device } };
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
    // phones and tablets: the same game on an emulated iPhone and iPad, once it passed on the computer (src/verify-core.js)
    if (report.ok && profiles.length && !usesWebGPU) {
      const openDevicePage = async (p: { userAgent: string; deviceScaleFactor: number }, vp: { width: number; height: number }) => {
        const dp = await browser!.newPage();
        await dp.setUserAgent(p.userAgent);
        await dp.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: p.deviceScaleFactor, isMobile: true, hasTouch: true, isLandscape: vp.width > vp.height });
        return dp;
      };
      try { applyDeviceResults(report, await verifyDevices(openDevicePage, url, { profiles, orientation: device.orientation, readyTimeoutS: s.verify_ready_timeout_s }), device.devices); }
      catch (e) { (report.notes as string[]).push('The phone and tablet check could not run: ' + String((e as Error).message || e).slice(0, 160)); }
    }
    const shot: Uint8Array | null = shots.length ? new Uint8Array(shots[0]) : null;   // the full-quality portrait when there is one, otherwise the first picture of the game in play past its loading screen
    return { report: { ...report, browser: 'cloudflare-browser-rendering' }, shot, frames: (frames || []).map((f: Uint8Array) => new Uint8Array(f)) };
  } catch (e) {
    return { report: { ok: false, browser: 'unavailable', summary: `The verification browser could not run: ${(e as Error).message}`, checks: [], errors: [] }, shot: null, frames: [] };
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}
export { b64 };
