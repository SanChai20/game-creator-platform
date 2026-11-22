// Per-game storage: how much a game's files may add up to, and what to say when a change does not fit.
// Pure functions over plain rows and the settings, so tests/storage.mjs runs them without a Worker.
// The platform default is the bundle_max_bytes setting; projects.storage_bytes sets a different amount for one game.

export const MB = 1024 * 1024;
export const mb = (n: number) => n > 0 && n < MB / 10 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${n >= 10 * MB ? Math.round(n / MB) : Math.round((n / MB) * 10) / 10} MB`;

interface StorageSettings { bundle_max_bytes: number; bundle_max_files: number; file_max_bytes: number }
export interface Budget { bytes: number; files: number; file: number; source: 'default' | 'game' }
export interface FileSize { path: string; size: number }

/** What one game may store: its own amount when an admin set one, otherwise the platform default. */
export function budgetOf(p: { storage_bytes?: number | null }, s: StorageSettings): Budget {
  const own = typeof p.storage_bytes === 'number' && p.storage_bytes >= 0;
  return { bytes: own ? p.storage_bytes! : s.bundle_max_bytes, files: s.bundle_max_files, file: s.file_max_bytes, source: own ? 'game' : 'default' };
}

export const totalOf = (files: FileSize[]) => files.reduce((a, f) => a + f.size, 0);

export interface Refusal { kind: 'file' | 'files' | 'bytes'; message: string; before: number; after: number; limit: number; path?: string }

/**
 * The workspace after writing `writes` and deleting `deletes`, checked against the budget. Only growth is refused: a game
 * that is already over (its storage was lowered after upload) can always delete or shrink files.
 */
export function checkChange(files: FileSize[], writes: FileSize[], deletes: string[], b: Budget): Refusal | null {
  for (const w of writes) {
    if (w.size > b.file) return { kind: 'file', path: w.path, before: 0, after: w.size, limit: b.file, message: `${w.path} is ${mb(w.size)}; the largest file a game can hold is ${mb(b.file)}.` };
  }
  const next = new Map(files.map((f) => [f.path, f.size]));
  for (const d of deletes) next.delete(d);
  for (const w of writes) next.set(w.path, w.size);
  const before = totalOf(files), after = [...next.values()].reduce((a, n) => a + n, 0);
  if (next.size > b.files && next.size > files.length) return { kind: 'files', before: files.length, after: next.size, limit: b.files, message: `This would bring the game to ${next.size} files; a game can hold ${b.files}.` };
  if (after > b.bytes && after > before) {
    return { kind: 'bytes', before, after, limit: b.bytes, message: `This would bring the game's files to ${mb(after)}, over its ${mb(b.bytes)} of storage (${mb(Math.max(0, b.bytes - before))} free before this change).` };
  }
  return null;
}

const KINDS: [string, RegExp][] = [
  ['models', /\.(glb|gltf|bin|obj|fbx|vox)$/i],
  ['textures and images', /\.(png|jpe?g|webp|gif|avif|ktx2|hdr|ico|svg)$/i],
  ['audio', /\.(mp3|ogg|wav|m4a|opus|flac)$/i],
  ['video', /\.(mp4|webm)$/i],
  ['engine data (wasm, pck, data)', /\.(wasm|pck|data)$/i],
  ['code', /\.(m?js|html|css|wgsl|glsl|map)$/i],
  ['fonts', /\.(woff2?|ttf|otf)$/i],
];
export const kindOf = (path: string) => KINDS.find(([, re]) => re.test(path))?.[0] ?? 'other';

/** Where a game's storage goes: totals per kind of file, and the largest files. */
export function breakdown(files: FileSize[], top = 8) {
  const by: Record<string, { files: number; bytes: number }> = {};
  for (const f of files) { const k = kindOf(f.path); (by[k] ??= { files: 0, bytes: 0 }).files++; by[k].bytes += f.size; }
  return {
    by_kind: Object.entries(by).sort((a, b) => b[1].bytes - a[1].bytes).map(([kind, v]) => ({ kind, files: v.files, size: mb(v.bytes), bytes: v.bytes })),
    largest: [...files].sort((a, b) => b.size - a.size).slice(0, top).map((f) => ({ path: f.path, size: mb(f.size), bytes: f.size })),
  };
}

/** How to keep a game inside its storage, in the order worth trying. Shown with every refusal and by game_storage. */
export const KEEP_SMALL = [
  'Generate it: build meshes, terrain, textures, sound effects and music from code at boot, from a seed. A generated forest costs a few kilobytes of code instead of megabytes of models.',
  'Load it at run time: keep large or optional content (extra levels, music, high-resolution textures, cutscenes, big models) on a host you control and fetch it while the game runs. The game page may fetch from any HTTPS host that sends CORS headers; there is no allow-list to ask for. game_storage {project} explains how.',
  'Compress what ships: glTF with Draco or Meshopt geometry, KTX2 or WebP textures sized to how big they are drawn, AAC (.m4a) or MP3 audio at 96 kbps or less (Opus or Ogg only with an .m4a or .mp3 fallback: Safari on iPhone and iPad plays Ogg only from iOS 18.4), and no duplicate or unused files (list_files shows the largest).',
  'Use what the platform already hosts: Three.js and the @gcp/ modules come from the import map and do not count against the game\'s storage.',
];

export const storageHint = (requestsOpen: boolean) =>
  `Keep the game small instead of shipping more files: generate meshes, textures and sound from code, load large or optional content at run time from a host you control (CORS), and compress what ships. game_storage {project} shows where the storage goes and every way to save it.${requestsOpen ? ' If the game truly needs more after that, ask: game_storage {project, action: "request", megabytes, reason}.' : ''}`;

/** The run-time loading notes an agent needs before moving assets out of the bundle. */
export const RUNTIME_LOADING = {
  allowed: 'The game page has no Content-Security-Policy restricting connections or media: fetch(), XHR, <img>, <audio>, <video>, Three.js loaders and WebAssembly streaming may load from any HTTPS host.',
  cors: 'The host must send Access-Control-Allow-Origin (\'*\' or the game\'s address) for fetch(), WebGL/WebGPU textures and audio decoded with Web Audio. Set crossOrigin = "anonymous" on images and loaders (THREE.TextureLoader().setCrossOrigin("anonymous")). Object storage with public CORS (R2, S3, GCS) or a CDN works; a file sharing page does not.',
  boot: 'Call GCP.ready() once the core game is playable, then stream the rest with GCP.progress(f, label) or an in-game loading state. The verification browser loads everything the game requests and fails on requests that return errors, so the host must be reliable and every URL must work at verification time.',
  cache: 'Cache downloads with the Cache Storage API or IndexedDB keyed by a versioned URL, so returning players do not download them again; use immutable, versioned file names.',
  fallback: 'Handle a failed or slow download: retry, fall back to generated content, or show a clear message with GCP.fatal() if the game cannot run without it.',
  rules: 'Content loaded at run time is part of the game: the same content rules apply. Load data and media with plain GET requests, not scripts (the static checks warn about imports from other hosts). Never put the player\'s play token or identity in those requests, and do not hold a WebSocket to another server from a background worker: the publish checks refuse both.',
};

/** Share of a game's storage at which every answer starts warning the agent (and, through it, the developer). */
export const WARN_AT = 0.8;

/**
 * The compact storage line every upload, deploy and project answer carries, so an agent always knows where the game stands
 * and can tell the developer before the limit stops them. `warning` appears from 80% used, and when over.
 */
export function storageStatus(used: number, b: Budget, requestsOpen: boolean) {
  const pct = b.bytes ? Math.round((used / b.bytes) * 100) : 100, free = Math.max(0, b.bytes - used);
  const out: { used: string; storage: string; free: string; percent_used: number; warning?: string } = { used: mb(used), storage: mb(b.bytes), free: mb(free), percent_used: pct };
  if (used > b.bytes) out.warning = `Over storage: the game's files add up to ${mb(used)} of its ${mb(b.bytes)}. New versions cannot be deployed or published until it fits. Tell the developer, then delete or shrink files. ${storageHint(requestsOpen)}`;
  else if (used >= b.bytes * WARN_AT) out.warning = `The game has used ${pct}% of its ${mb(b.bytes)} storage (${mb(free)} left). Tell the developer now, and plan the rest of the game around generating content from code or loading it at run time rather than adding large files. game_storage {project} shows where the space goes.`;
  return out;
}
