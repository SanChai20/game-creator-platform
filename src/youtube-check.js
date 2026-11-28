// Exporting a verified version as a YouTube Playables package (src/youtube-export.ts does the storage side). This module
// decides what the package is: whether the version can go at all (blockers), what will not work inside YouTube
// (warnings: there is no HearthCade sign-in there, so no multiplayer, friends, shared levels or HearthCade leaderboards),
// which platform files the game loads (three.js, the game kits) so they can travel inside the zip, and the index.html
// YouTube runs. Pure: no I/O, tested in tests/youtube-export.mjs.

/** YouTube's SDK, loaded before ours so window.ytgame is there when the HearthCade SDK starts. */
export const YT_SDK = 'https://www.youtube.com/game_api/v1';
/** Where the platform files go inside the package. */
export const LOCAL_DIR = 'gcp/';
/** Above this the package is flagged as large: YouTube limits a Playable's size, and a phone on a slow network waits. */
export const LARGE_BYTES = 30 * 1024 * 1024;
const PLATFORM_PATH = /^\/(vendor|kits)\//;
const TEXT_FILE = /\.(html?|m?js|css|json)$/i;

/** SDK services that need HearthCade's servers and a signed-in player, and what a player sees inside YouTube instead. */
const NEEDS_PLATFORM = [
  [/\bGCP\.room\s*\(/, 'GCP.room', 'Rooms (live multiplayer) need HearthCade: inside YouTube a room opens as a single local player.'],
  [/\bGCP\.match\b/, 'GCP.match', 'Server-run matches need HearthCade: inside YouTube GCP.match ends at once with code "standalone".'],
  [/\bGCP\.friends\b/, 'GCP.friends', 'Friends need a HearthCade account: inside YouTube GCP.friends answers code "standalone".'],
  [/\bGCP\.levels\b/, 'GCP.levels', 'Shared levels live on HearthCade: inside YouTube GCP.levels answers code "standalone". Levels the player makes can still be kept with GCP.save.'],
  [/\bGCP\.leaderboard\.top\b/, 'GCP.leaderboard.top', 'HearthCade leaderboards are not reachable from YouTube: GCP.leaderboard.top resolves with an empty list. Scores still go to YouTube.'],
  [/\bGCP\.presence\b/, 'GCP.presence', 'Presence (who is online) needs HearthCade and does nothing inside YouTube.'],
  [/\bGCP\.achievements\b/, 'GCP.achievements', 'HearthCade achievements are not reachable from YouTube: unlock and list resolve with null there.'],
  [/\bGCP\.shared\b/, 'GCP.shared', 'Shared game data (GCP.shared) comes from HearthCade and resolves with null inside YouTube.'],
];

/** Import specifiers in a JS (or an HTML page's inline module): static imports and exports, side-effect imports, import(). */
export function specifiers(text) {
  const out = new Set(), src = String(text || '');
  const re = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']|(?:^|[^\w$.])import\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1] || m[2]);
  return [...out];
}

/** Resolves a specifier through an import map (exact keys, then the longest key ending in "/"); null when it is not mapped. */
export function mapSpecifier(spec, imports) {
  if (Object.prototype.hasOwnProperty.call(imports, spec)) return imports[spec];
  let best = null;
  for (const k of Object.keys(imports)) if (k.endsWith('/') && spec.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? imports[best] + spec.slice(best.length) : null;
}

/** The platform path (/vendor/... or /kits/...) a URL points to, when it is one of the platform's own files; else null. */
export function platformPath(url, origin) {
  if (!/^https?:\/\//i.test(String(url))) return null;
  let u, o;
  try { o = new URL(origin); u = new URL(url, o.origin + '/'); } catch { return null; }
  // a version deployed before the platform moved keeps its old origin in its import map (as src/runtime/game-worker.js rehome)
  const ours = u.hostname === o.hostname || u.hostname === 'www.' + o.hostname || /^game-creator-platform\.[a-z0-9-]+\.workers\.dev$/i.test(u.hostname);
  if (!ours || !PLATFORM_PATH.test(u.pathname)) return null;
  return u.pathname;
}

/** The import map inside the package: platform URLs become ./gcp/... paths, the rest stays as the game wrote it. */
export function localImports(imports, origin) {
  const out = {};
  for (const [k, v] of Object.entries(imports || {})) {
    const p = typeof v === 'string' ? platformPath(v, origin) : null;
    out[k] = p ? './' + LOCAL_DIR + p.slice(1) : v;
  }
  return out;
}

/** A game's own import map in its index.html, when it wrote one. */
export function ownImportMap(html) {
  const m = String(html || '').match(/<script[^>]+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { const j = JSON.parse(m[1]); return j && typeof j.imports === 'object' ? j.imports : {}; } catch { return null; }
}

const esc = (s) => String(s).replace(/</g, '\\u003c');
/**
 * The package's index.html: YouTube's SDK, then the marker that tells the HearthCade SDK it runs inside YouTube, then the
 * SDK itself, all at the top of <head> so they run before the game. The import map points at the files in the package (a
 * game's own import map is rewritten in place, since a browser honours only the first one).
 */
export function packageHtml(html, imports, origin) {
  let page = String(html || '');
  // the game's own copies of the SDK script: the package carries its own at gcp/gcp.js
  page = page.replace(/<script[^>]+src=["'][^"']*\/sdk\/gcp\.js["'][^>]*>\s*<\/script>/gi, '');
  let head = `<script src="${YT_SDK}"></script><script>window.__GCP_HOST='youtube'</script><script src="./${LOCAL_DIR}gcp.js"></script>`;
  const own = ownImportMap(page);
  if (own) {
    page = page.replace(/(<script[^>]+type=["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/i, (_, a, _b, c) => a + esc(JSON.stringify({ imports: localImports(own, origin) })) + c);
  } else if (imports && Object.keys(imports).length) {
    head += `<script type="importmap">${esc(JSON.stringify({ imports: localImports(imports, origin) }))}</script>`;
  }
  const m = page.match(/<head[^>]*>/i);
  if (m) return page.slice(0, m.index + m[0].length) + head + page.slice(m.index + m[0].length);
  const d = page.match(/<!doctype[^>]*>/i);
  return d ? page.slice(0, d.index + d[0].length) + head + page.slice(d.index + d[0].length) : head + page;
}

/** Whether a package file is text the check reads (and the exporter scans for imports). */
export const isText = (path) => TEXT_FILE.test(path);

/** Files that stay out of the package: server code runs only on HearthCade, and the game's own notes to the platform. */
export const leftOut = (path) => /^server\//.test(path);

/**
 * Whether the version can go to YouTube, and what to tell the creator first.
 * input: { verified, files: [{ path, size }], texts: { path: text } (the game's HTML and JS), manifest, age, extraBytes }
 * Returns { blockers: [{ code, message }], warnings: [{ code, message }], bytes }.
 * @param {{ verified?: boolean, files?: { path: string, size: number }[], texts?: Record<string, string>, manifest?: any, age?: number | null, extraBytes?: number }} input
 */
export function check({ verified, files = [], texts = {}, manifest = {}, age = null, extraBytes = 0 }) {
  const blockers = [], warnings = [];
  const block = (code, message) => blockers.push({ code, message }), warn = (code, message) => warnings.push({ code, message });
  if (!verified) block('not_verified', 'Only a verified version can be exported. Deploy the game and let verification finish first.');
  const kept = files.filter((f) => !leftOut(f.path));
  if (!kept.some((f) => f.path === 'index.html')) block('no_index', 'The version has no index.html at its top level, which YouTube starts the game from.');
  if (manifest.hasServer || manifest.hasMatch) warn('server_code', 'The game has server code (server/). It runs only on HearthCade and is left out of the package: whatever it does will not happen inside YouTube.');
  const code = Object.entries(texts).filter(([p]) => /\.(m?js|html?)$/i.test(p) && !leftOut(p)).map(([, t]) => t).join('\n');
  for (const [re, name, message] of NEEDS_PLATFORM) if (re.test(code)) warn('needs_platform:' + name, message);
  // other servers: YouTube runs Playables offline from their package and expects no outside requests
  const hosts = new Set();
  for (const m of code.matchAll(/\b(?:fetch|import|WebSocket|EventSource|XMLHttpRequest)[^\n]{0,80}?["'`](https?|wss?):\/\/([a-z0-9.-]+)/gi)) hosts.add(m[2].toLowerCase());
  for (const m of code.matchAll(/<(?:script|link|img|audio|video|source)[^>]+(?:src|href)=["']https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  hosts.delete('www.youtube.com');
  if (hosts.size) warn('outside_requests', `The game loads from other servers (${[...hosts].slice(0, 5).join(', ')}${hosts.size > 5 ? ', …' : ''}). YouTube expects a Playable to load everything from its own package: copy those files into the game.`);
  if (age != null && Number(age) >= 18) warn('adults_only', 'The game is rated for adults on HearthCade. YouTube Playables reach a general audience: check YouTube\'s content rules before you submit it.');
  if (/\bnavigator\.gpu\b|three\/webgpu/.test(code) || manifest.webgpu) warn('webgpu', 'The game uses WebGPU, which not every phone YouTube runs on has. Make sure it falls back to WebGL.');
  const bytes = kept.reduce((n, f) => n + (f.size || 0), 0) + extraBytes;
  if (bytes > LARGE_BYTES) warn('large', `The package is ${Math.round(bytes / 1048576)} MB. YouTube limits a Playable's size and a phone on a slow network waits for all of it: check the current limit, and shrink textures and audio if you can.`);
  return { blockers, warnings, bytes };
}

/** The checklist that goes into the package (PLAYABLES.md). */
export function readme({ title, version, origin, warnings }) {
  const lines = [
    `# ${title}: YouTube Playables package`,
    '',
    `Exported from HearthCade (${origin}), version ${version}.`,
    '',
    'What this package already does:',
    '',
    '- Loads YouTube\'s Playables SDK first, then the HearthCade SDK (gcp/gcp.js), which talks to YouTube instead of HearthCade.',
    '- Tells YouTube when the first frame is drawn (firstFrameReady) and when the game is playable (gameReady, from GCP.ready()).',
    '- Pauses the game when YouTube pauses it (GCP.paused and GCP.onPause, as with the HearthCade menu) and mutes it when YouTube\'s sound is off.',
    '- Keeps GCP.save in YouTube\'s cloud save (loadData and saveData), so progress follows the player.',
    '- Sends scores to YouTube (sendScore) from GCP.leaderboard.submit (higher-is-better boards) and GCP.gameOver({ score }).',
    '- Follows the language YouTube gives (GCP.lang).',
    '- Carries the platform files the game loads (three.js, the game kits) under gcp/, with an import map pointing at them.',
    '',
    'Before you submit:',
    '',
    '1. Open index.html from a local web server (for example `npx serve .`) to check it starts. Outside YouTube, ytgame is missing and the game runs as a plain local page.',
    '2. Test it in YouTube\'s Playables test suite, which YouTube gives Playables developers.',
    '3. Submit the zip through YouTube\'s Playables submission, with the cover art and description YouTube asks for.',
    '4. Inside YouTube there is no HearthCade sign-in: GCP.host is "youtube", and a game can hide its multiplayer, friends and leaderboard screens when it is.',
  ];
  if (warnings.length) { lines.push('', 'What the export noticed:', ''); for (const w of warnings) lines.push('- ' + w.message); }
  return lines.join('\n') + '\n';
}
