// The desktop app's downloads (docs/apps.md). The app is a thin shell that opens https://hearthcade.com, built from
// desktop/ by .github/workflows/desktop.yml and published as a GitHub release of this repository. The site gives its
// files stable addresses, so the Get the app page and the shell's own updater never depend on where they are kept:
//   /download/desktop/windows | mac | linux | linux-deb   the installer for that system (a redirect)
//   /download/desktop/info.json                         the current version, or { available: false }
//   /download/desktop/latest.json                       the shell updater's manifest (204 when there is none)
import { Hono } from 'hono';
import type { Env } from './env';

/** Where the releases live. Only the desktop app is published as a release of this repository. */
export const DESKTOP_RELEASES = 'https://github.com/SanChai20/game-creator-platform/releases/latest/download';

/** The installers, by the name the workflow gives each in every release (the same name each time). */
export const DESKTOP_FILES = {
  windows: 'HearthCade-Windows-x64-setup.exe',
  mac: 'HearthCade-macOS.dmg',
  linux: 'HearthCade-Linux-x86_64.AppImage',
  'linux-deb': 'HearthCade-Linux-amd64.deb',
} as const;
export type DesktopFile = keyof typeof DESKTOP_FILES;
export const DESKTOP_INFO = 'hearthcade-desktop.json', DESKTOP_UPDATER = 'latest.json';

/** The release file behind a /download/desktop/<name> address, or null. */
export function desktopTarget(name: string): string | null {
  if (name === 'info.json') return `${DESKTOP_RELEASES}/${DESKTOP_INFO}`;
  if (name === 'latest.json') return `${DESKTOP_RELEASES}/${DESKTOP_UPDATER}`;
  return Object.hasOwn(DESKTOP_FILES, name) ? `${DESKTOP_RELEASES}/${DESKTOP_FILES[name as DesktopFile]}` : null;
}

export const desktop = new Hono<{ Bindings: Env }>();

// JSON from the release, cached at the edge for a few minutes so a release shows up quickly and GitHub is asked rarely
async function releaseJson(url: string): Promise<unknown | null> {
  const r = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit).catch(() => null);
  if (!r?.ok) return null;
  return r.json().catch(() => null);
}

desktop.get('/info.json', async (c) => {
  const info = await releaseJson(desktopTarget('info.json')!);
  return c.json(info && typeof info === 'object' ? { available: true, ...info } : { available: false }, 200, { 'cache-control': 'public, max-age=300' });
});

// The Tauri updater asks this at launch and every few hours. 204 is "no update" to it.
desktop.get('/latest.json', async (c) => {
  const m = await releaseJson(desktopTarget('latest.json')!);
  return m ? c.json(m, 200, { 'cache-control': 'public, max-age=300' }) : c.body(null, 204);
});

desktop.get('/:name', (c) => {
  const to = desktopTarget(c.req.param('name'));
  return to ? c.redirect(to, 302) : c.notFound();
});
