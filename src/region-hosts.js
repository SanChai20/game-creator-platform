// Hosts that players in some regions cannot reach. A game that loads its font, a library, an analytics tag or a video
// from one of these hangs or loses that part for every player there (mainland China, where Google's and several US
// social networks' domains are blocked, is the big one, and HearthCade's store is in Chinese too). The platform cannot
// fix that for a game, so deploy_preview warns and says what to ship in the bundle instead.
// Plain JavaScript so tests/region-hosts.mjs imports it directly.

/** [host suffix, what it usually is, what to do instead]. A suffix matches the host itself and every subdomain. */
const BLOCKED = [
  ['fonts.googleapis.com', 'Google Fonts', 'Download the font files (woff2) into the bundle and load them with @font-face from a relative path.'],
  ['fonts.gstatic.com', 'Google Fonts', 'Download the font files (woff2) into the bundle and load them with @font-face from a relative path.'],
  ['ajax.googleapis.com', 'Google Hosted Libraries', 'Ship the library file in the bundle, or use the platform-hosted modules ("three", "three/addons/…", "@gcp/…").'],
  ['www.gstatic.com', 'a Google-hosted file', 'Ship the file in the bundle.'],
  ['storage.googleapis.com', 'Google Cloud Storage', 'Ship the file in the bundle, or keep large content in the game\'s own storage.'],
  ['firebasestorage.googleapis.com', 'Firebase Storage', 'Ship the file in the bundle; use GCP.save and GCP.leaderboard for player data.'],
  ['firebaseio.com', 'Firebase', 'Use the platform services (GCP.save, GCP.leaderboard, GCP.room) instead.'],
  ['firebaseapp.com', 'Firebase', 'Use the platform services (GCP.save, GCP.leaderboard, GCP.room) instead.'],
  ['googletagmanager.com', 'Google Tag Manager', 'Leave it out: the platform records plays, play time and scores itself (game_data).'],
  ['google-analytics.com', 'Google Analytics', 'Leave it out: the platform records plays, play time and scores itself (game_data).'],
  ['googlesyndication.com', 'Google ads', 'Leave it out.'],
  ['recaptcha.net', 'reCAPTCHA', 'Leave it out: players are already signed in by the platform.'],
  ['www.google.com', 'a Google service (often reCAPTCHA)', 'Leave it out or ship what it provides in the bundle.'],
  ['youtube.com', 'YouTube', 'Ship the video in the bundle (mp4, webm) and play it with <video>.'],
  ['youtube-nocookie.com', 'YouTube', 'Ship the video in the bundle (mp4, webm) and play it with <video>.'],
  ['ytimg.com', 'YouTube', 'Ship the image or video in the bundle.'],
  ['facebook.net', 'Facebook', 'Leave it out.'],
  ['platform.twitter.com', 'X (Twitter)', 'Leave it out.'],
  ['discord.com', 'Discord', 'Leave it out.'],
];

const URL_RE = /(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/:"'`\s)?#]|$)/gi;

/** The blocked-host entry a host name falls under, or null. */
export function blockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  for (const [suffix, what, instead] of BLOCKED) if (h === suffix || h.endsWith('.' + suffix)) return { host: h, what, instead };
  return null;
}

/**
 * Every URL in a text file (HTML, CSS, JavaScript) that points at a host some regions block, once per host, with the
 * line it is first on. Mentions in comments count too: a scan cannot tell a live tag from a dead one cheaply, and a
 * false warning costs less than a game that never loads in a whole country.
 * @param {string} src @returns {{ host: string, what: string, instead: string, line: number }[]}
 */
export function regionBlockedRefs(src) {
  const out = [], seen = new Set();
  for (const m of String(src || '').matchAll(URL_RE)) {
    const hit = blockedHost(m[1]);
    if (!hit || seen.has(hit.host)) continue;
    seen.add(hit.host);
    out.push({ ...hit, line: src.slice(0, m.index).split('\n').length });
    if (out.length >= 10) break;
  }
  return out;
}

/** The warning deploy_preview shows for one reference. */
export function regionWarning(file, ref) {
  return {
    file, line: ref.line,
    message: `Loads ${ref.what} from ${ref.host}, which players in some regions cannot reach (it is blocked in mainland China). That part of the game will fail or hang for them.`,
    hint: ref.instead,
  };
}
