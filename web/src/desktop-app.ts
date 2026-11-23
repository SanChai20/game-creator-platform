// HearthCade's desktop app for Windows, macOS and Linux (desktop/, docs/apps.md): a window that opens this site, so
// nothing here is written for it. This file only answers two questions for the Get the app page and the install popup:
// is this page open inside the app, and which computer is this.

/** What the desktop app tells the page about itself (desktop/src-tauri/src/main.rs), or null in a browser. */
export interface DesktopShell { kind: 'desktop'; os: 'windows' | 'macos' | 'linux'; version: string }
export const desktopShell = (): DesktopShell | null =>
  (typeof window !== 'undefined' && (window as Window & { hearthcadeShell?: DesktopShell }).hearthcadeShell) || null;

export type DesktopOs = 'windows' | 'mac' | 'linux';
/** The computer the page is on, for the right download, or null on a phone or tablet (an iPad says it is a Mac). */
export function desktopOs(d: { userAgent: string; maxTouchPoints: number }): DesktopOs | null {
  const ua = d.userAgent;
  if (/Android|iPhone|iPad|iPod|CrOS/.test(ua)) return null;
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return d.maxTouchPoints > 1 ? null : 'mac';
  if (/Linux|X11/.test(ua)) return 'linux';
  return null;
}

/** The installers' addresses on this site (src/desktop.ts sends them on to the current release). */
export const DOWNLOAD = { windows: '/download/desktop/windows', mac: '/download/desktop/mac', linux: '/download/desktop/linux', 'linux-deb': '/download/desktop/linux-deb' } as const;
