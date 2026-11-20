// Waiting for a verification browser when the platform is at its Browser Rendering limit (src/verify.ts). No imports,
// so the tests load it.
/** Browser Rendering refuses a launch past the account's concurrent-browser or launch-rate limit (429). */
export const isBrowserLimit = (e: unknown) => /\b429\b|rate.?limit|too many|limit exceeded|concurrent/i.test(String((e as Error)?.message || e));
export const LAUNCH_WAITS_MS = [5_000, 15_000, 30_000, 60_000];
/**
 * Launches the verification browser, waiting and trying again while the platform is at its browser limit (several
 * creators deploying at once), instead of failing the version as "browser unavailable" at the first refusal. Runs in the
 * pipeline's alarm, which may wait this long. Any other error is not retried.
 */
export async function launchWithRetry<T>(launch: () => Promise<T>, waits = LAUNCH_WAITS_MS, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await launch(); }
    catch (e) { if (i >= waits.length || !isBrowserLimit(e)) throw e; await sleep(waits[i] * (0.75 + Math.random() * 0.5)); }
  }
}
