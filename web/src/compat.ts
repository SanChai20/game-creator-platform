// Game compatibility: what a game needs from the player's browser and device, and whether this browser has it.
// One module, no imports, so the Worker (declaring, detecting and storing requirements), the web app (the store page's
// Compatibility section and the verdict before launch) and the tests share the same rules.
//
//   Requirements  what one version of a game needs. Declared by its creator in gcp.json "requirements" (the MCP tool
//                 `compatibility` writes it), merged with what the platform detects in the code, frozen with the version.
//   Probe         what the player's browser and device have (web/src/compat-probe.ts measures it in the browser).
//   evaluate()    compares the two, row by row: ok, no, or unknown when a browser cannot tell.

export type Graphics = 'none' | 'canvas' | 'webgl' | 'webgl2' | 'webgpu';
export type Input = 'keyboard' | 'mouse' | 'touch' | 'gamepad';
export type Device = 'desktop' | 'tablet' | 'mobile';
export type Orientation = 'any' | 'landscape' | 'portrait';
export type BrowserId = 'chrome' | 'edge' | 'firefox' | 'safari' | 'samsung' | 'opera';
export type OsId = 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'ios';

/** The graphics APIs, weakest first. A game names the weakest one it can run with. */
export const GRAPHICS: readonly Graphics[] = ['none', 'canvas', 'webgl', 'webgl2', 'webgpu'];
export const INPUTS: readonly Input[] = ['keyboard', 'mouse', 'touch', 'gamepad'];
export const DEVICES: readonly Device[] = ['desktop', 'tablet', 'mobile'];
export const ORIENTATIONS: readonly Orientation[] = ['any', 'landscape', 'portrait'];
export const BROWSERS: readonly BrowserId[] = ['chrome', 'edge', 'firefox', 'safari', 'samsung', 'opera'];
export const OSES: readonly OsId[] = ['windows', 'macos', 'linux', 'chromeos', 'android', 'ios'];

/** Browser features a game can need. `platform: false` means the platform cannot give it to games today. */
export const FEATURES = {
  'webassembly': { label: 'WebAssembly', platform: true },
  'wasm-simd': { label: 'WebAssembly SIMD', platform: true },
  'wasm-threads': { label: 'WebAssembly threads (SharedArrayBuffer)', platform: false },
  'webgpu': { label: 'WebGPU', platform: true },
  'web-audio': { label: 'Web Audio', platform: true },
  'audio-worklet': { label: 'Audio worklets', platform: true },
  'pointer-lock': { label: 'Pointer lock', platform: true },
  'fullscreen': { label: 'Fullscreen', platform: true },
  'web-workers': { label: 'Web workers', platform: true },
  'offscreen-canvas': { label: 'OffscreenCanvas', platform: true },
  'indexeddb': { label: 'IndexedDB', platform: true },
  'webxr': { label: 'WebXR (VR/AR)', platform: true },
  'webrtc': { label: 'WebRTC', platform: true },
  'es-modules': { label: 'JavaScript modules', platform: true },
  'import-maps': { label: 'Import maps', platform: true },
  'device-motion': { label: 'Motion sensors', platform: true },
} as const;
export type Feature = keyof typeof FEATURES;
export const FEATURE_IDS = Object.keys(FEATURES) as Feature[];

export interface KnownIssue { browser?: BrowserId; os?: OsId; severity: 'broken' | 'degraded'; note: string }

/** What one version of a game needs. Every field is always present once normalised. */
export interface Requirements {
  graphics: Graphics;                       // the weakest graphics API the game runs with
  gpu: 'any' | 'hardware';                  // hardware: needs a real GPU, not a software renderer
  features: Feature[];                      // must have
  optional: Feature[];                      // used when present, works without (e.g. WebGPU with a WebGL 2 fallback)
  input: Input[];                           // what the game can be played with; any one is enough
  devices: Device[];                        // the kinds of device it plays on: all of them, a platform requirement
  orientation: Orientation;
  memory_gb: number | null;                 // minimum device memory, when the game is heavy
  browsers: Partial<Record<BrowserId, number>>; // minimum major versions, when the creator knows them
  known_issues: KnownIssue[];               // browsers or systems where it is known not to work well
  notes: string;                            // anything else, in the creator's words
}

/** What is stored with a version (manifest.compat) and served to the store page. */
export interface Compat {
  v: 1;
  requirements: Requirements;               // what the store page shows and players are checked against
  declared: boolean;                        // the creator declared requirements (otherwise: all detected)
  detected: Requirements;                   // what the platform found in the code on its own
  evidence: Record<string, string>;         // why each detected item was detected ("webgl2": "three.js (src/main.js)")
  download_bytes: number;
}

export interface CompatIssue { level: 'error' | 'warning'; field: string; message: string; hint?: string }

// ---------------------------------------------------------------------------------------------
// Normalising and validating a declaration
// ---------------------------------------------------------------------------------------------
const uniq = <T,>(a: T[]) => [...new Set(a)];
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);
const ALIASES: Record<string, string> = {
  webgl1: 'webgl', 'webgl 1': 'webgl', 'webgl 2': 'webgl2', 'webgl2.0': 'webgl2', 'webgl 2.0': 'webgl2', canvas2d: 'canvas', '2d': 'canvas', dom: 'none', css: 'none',
  wasm: 'webassembly', simd: 'wasm-simd', threads: 'wasm-threads', sharedarraybuffer: 'wasm-threads', 'shared-memory': 'wasm-threads', webaudio: 'web-audio', audio: 'web-audio',
  audioworklet: 'audio-worklet', pointerlock: 'pointer-lock', workers: 'web-workers', 'web-worker': 'web-workers', offscreencanvas: 'offscreen-canvas', modules: 'es-modules',
  importmap: 'import-maps', 'import-map': 'import-maps', xr: 'webxr', vr: 'webxr', accelerometer: 'device-motion', gyroscope: 'device-motion',
  phone: 'mobile', phones: 'mobile', tablets: 'tablet', pc: 'desktop', computer: 'desktop', controller: 'gamepad', pointer: 'mouse', keyboards: 'keyboard',
  both: 'any', 'landscape and portrait': 'any', 'portrait and landscape': 'any',
  mac: 'macos', osx: 'macos', iphone: 'ios', ipad: 'ios', ipados: 'ios', win: 'windows', 'chrome os': 'chromeos', 'mobile safari': 'safari', 'samsung internet': 'samsung',
};
const norm = (v: unknown) => { const s = String(v ?? '').trim().toLowerCase(); return ALIASES[s] ?? s; };

export function emptyRequirements(): Requirements {
  return { graphics: 'canvas', gpu: 'any', features: [], optional: [], input: ['keyboard', 'mouse'], devices: [...DEVICES], orientation: 'any', memory_gb: null, browsers: {}, known_issues: [], notes: '' };
}

/** Checks a declared requirements object (gcp.json "requirements" or the MCP tool's argument). Returns what it understood and what was wrong. */
export function parseRequirements(raw: unknown): { value: Partial<Requirements>; issues: CompatIssue[] } {
  const issues: CompatIssue[] = [], value: Partial<Requirements> = {};
  const e = (field: string, message: string, hint?: string) => issues.push({ level: 'error', field, message, hint });
  if (raw === undefined || raw === null) return { value, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) { e('requirements', 'requirements must be an object.', 'Example: {"graphics": "webgl2", "input": ["keyboard", "mouse", "touch"], "devices": ["desktop", "tablet", "mobile"]}'); return { value, issues }; }
  const r = raw as Record<string, unknown>;
  const known = ['graphics', 'gpu', 'features', 'optional', 'input', 'devices', 'orientation', 'memory_gb', 'browsers', 'known_issues', 'notes'];
  for (const k of Object.keys(r)) if (!known.includes(k)) e(k, `Unknown field "${k}".`, `Fields: ${known.join(', ')}.`);
  if (r.graphics !== undefined) {
    const g = norm(r.graphics) as Graphics;
    if (GRAPHICS.includes(g)) value.graphics = g; else e('graphics', `graphics "${r.graphics}" is not one of ${GRAPHICS.join(', ')}.`, 'Name the weakest graphics API the game still runs with: a WebGPU game with a WebGL 2 fallback is "webgl2" with "webgpu" under optional.');
  }
  if (r.gpu !== undefined) { const g = norm(r.gpu); if (g === 'any' || g === 'hardware') value.gpu = g; else e('gpu', 'gpu must be "any" or "hardware".', '"hardware" means the game is unplayable with a software renderer (no GPU acceleration).'); }
  for (const key of ['features', 'optional'] as const) {
    if (r[key] === undefined) continue;
    const got: Feature[] = [];
    for (const f of list(r[key])) { const id = norm(f) as Feature; if (FEATURE_IDS.includes(id)) got.push(id); else e(key, `Unknown feature "${f}".`, `Features: ${FEATURE_IDS.join(', ')}.`); }
    value[key] = uniq(got);
  }
  if (value.features && value.optional) { const both = value.features.filter((f) => value.optional!.includes(f)); if (both.length) e('optional', `${both.join(', ')} cannot be both required and optional.`); }
  if (value.features?.includes('webgpu') && value.graphics && value.graphics !== 'webgpu') e('features', '"webgpu" is required under features but graphics is not "webgpu".', 'Set graphics to "webgpu" when the game cannot run without it, or move "webgpu" to optional.');
  for (const f of value.features || []) if (!FEATURES[f].platform) e('features', `${FEATURES[f].label} is not available to games on this platform: games are not served cross-origin isolated, so SharedArrayBuffer does not exist in the page.`, 'Build without threads (Emscripten: no -pthread; Godot 4: export with threads off; Unity: leave Native C/C++ Multithreading off).');
  if (r.input !== undefined) {
    const got: Input[] = [];
    for (const f of list(r.input)) { const id = norm(f) as Input; if (INPUTS.includes(id)) got.push(id); else e('input', `Unknown input "${f}".`, `Input: ${INPUTS.join(', ')}.`); }
    if (!got.length && !issues.some((i) => i.field === 'input')) e('input', 'input must name at least one way to play.', `One or more of ${INPUTS.join(', ')}.`);
    value.input = uniq(got);
  }
  if (r.devices !== undefined) {
    const got: Device[] = [];
    for (const f of list(r.devices)) { const id = norm(f) as Device; if (DEVICES.includes(id)) got.push(id); else e('devices', `Unknown device "${f}".`, `Devices: ${DEVICES.join(', ')}.`); }
    if (!got.length && !issues.some((i) => i.field === 'devices')) e('devices', 'devices must name at least one kind of device.', `One or more of ${DEVICES.join(', ')}.`);
    value.devices = uniq(got);
  }
  if (r.orientation !== undefined) { const o = norm(r.orientation) as Orientation; if (ORIENTATIONS.includes(o)) value.orientation = o; else e('orientation', 'orientation must be "landscape", "portrait" or "both" ("any" means both).', 'game_standards {action: "get", id: "orientation"} has the rules for each.'); }
  if (r.memory_gb !== undefined && r.memory_gb !== null) { const m = Number(r.memory_gb); if (Number.isFinite(m) && m >= 0.5 && m <= 64) value.memory_gb = Math.round(m * 2) / 2; else e('memory_gb', 'memory_gb must be a number from 0.5 to 64.', 'Leave it out unless the game needs a lot of memory; browsers report device memory only roughly.'); }
  else if (r.memory_gb === null) value.memory_gb = null;
  if (r.browsers !== undefined) {
    const b: Partial<Record<BrowserId, number>> = {};
    if (!r.browsers || typeof r.browsers !== 'object' || Array.isArray(r.browsers)) e('browsers', 'browsers must map a browser to its minimum major version, e.g. {"safari": 17, "chrome": 113}.');
    else for (const [k, v] of Object.entries(r.browsers as Record<string, unknown>)) {
      const id = norm(k) as BrowserId, n = Number(v);
      if (!BROWSERS.includes(id)) e('browsers', `Unknown browser "${k}".`, `Browsers: ${BROWSERS.join(', ')}.`);
      else if (!Number.isInteger(n) || n < 1 || n > 999) e('browsers', `${k}: the minimum version must be a whole major version number.`);
      else b[id] = n;
    }
    value.browsers = b;
  }
  if (r.known_issues !== undefined) {
    const out: KnownIssue[] = [];
    const items = list(r.known_issues);
    if (items.length > 12) e('known_issues', 'At most 12 known issues.');
    for (const it of items.slice(0, 12)) {
      if (!it || typeof it !== 'object') { e('known_issues', 'Each known issue is an object: {"browser": "safari", "os": "ios", "severity": "broken", "note": "…"}.'); continue; }
      const x = it as Record<string, unknown>, browser = x.browser !== undefined ? norm(x.browser) as BrowserId : undefined, os = x.os !== undefined ? norm(x.os) as OsId : undefined;
      const sev = x.severity === undefined ? 'degraded' : norm(x.severity), note = String(x.note ?? '').trim();
      if (browser && !BROWSERS.includes(browser)) { e('known_issues', `Unknown browser "${x.browser}".`, `Browsers: ${BROWSERS.join(', ')}.`); continue; }
      if (os && !OSES.includes(os)) { e('known_issues', `Unknown os "${x.os}".`, `Systems: ${OSES.join(', ')}.`); continue; }
      if (!browser && !os) { e('known_issues', 'A known issue names a browser, an os, or both.'); continue; }
      if (sev !== 'broken' && sev !== 'degraded') { e('known_issues', 'severity is "broken" (does not work there) or "degraded" (works, but worse).'); continue; }
      if (!note) { e('known_issues', 'Each known issue needs a short note for players.'); continue; }
      out.push({ ...(browser ? { browser } : {}), ...(os ? { os } : {}), severity: sev, note: note.slice(0, 200) });
    }
    value.known_issues = out;
  }
  if (r.notes !== undefined) { const n = String(r.notes ?? '').trim(); if (n.length > 300) e('notes', 'notes must be 300 characters or fewer.'); value.notes = n.slice(0, 300); }
  return { value, issues };
}

// ---------------------------------------------------------------------------------------------
// Detecting requirements from a bundle's code
// ---------------------------------------------------------------------------------------------
export interface DetectInput { texts: Map<string, string> | Record<string, string>; paths: string[]; bareImports?: boolean; orientation?: string }

const RX = {
  webgpu: /navigator\s*\.\s*gpu\b|\brequestAdapter\s*\(/,
  threeWebgpu: /three\/webgpu|WebGPURenderer/,
  three: /from\s*["']three(?:\/[^"']*)?["']|import\(\s*["']three["']\s*\)|\bTHREE\.(?:WebGLRenderer|Scene)\b|three(?:\.module)?(?:\.min)?\.js/,
  gl2: /getContext\(\s*["']webgl2["']/,
  gl1: /getContext\(\s*["'](?:webgl|experimental-webgl)["']/,
  glEngine: /\bBABYLON\.Engine\b|from\s*["']@babylonjs\/|\bpc\.Application\b|from\s*["']playcanvas["']|\bPIXI\.(?:Application|Renderer)\b|from\s*["']pixi\.js["']/,
  unity: /createUnityInstance\s*\(/,
  godot: /GODOT_CONFIG|new\s+Engine\s*\(\s*GODOT|godot\.(?:tools\.)?js/,
  phaser: /Phaser\.(?:Game|AUTO|WEBGL|CANVAS)\b|from\s*["']phaser["']/,
  canvas2d: /getContext\(\s*["']2d["']/,
  canvasTag: /<canvas\b|createElement\(\s*["']canvas["']/,
  wasm: /WebAssembly\s*\.\s*(?:instantiate|instantiateStreaming|compile|compileStreaming|Module)\b/,
  threads: /\bSharedArrayBuffer\b|\bAtomics\s*\.\s*wait\b/,
  audio: /\b(?:webkit)?AudioContext\b/,
  worklet: /audioWorklet\s*\.\s*addModule|\bAudioWorkletNode\b/,
  pointerLock: /requestPointerLock\s*\(/,
  workers: /new\s+(?:Shared)?Worker\s*\(/,
  offscreen: /\bOffscreenCanvas\b|transferControlToOffscreen\s*\(/,
  idb: /\bindexedDB\s*\.\s*open\s*\(/,
  xr: /navigator\s*\.\s*xr\b|requestSession\s*\(\s*["']immersive-/,
  rtc: /\bRTCPeerConnection\b/,
  motion: /\bDevice(?:Motion|Orientation)Event\b|["']device(?:motion|orientation)["']/,
  module: /<script[^>]+type=["']module["']|^\s*(?:import|export)\s/m,
  keyboard: /["']key(?:down|up|press)["']|\bonkey(?:down|up)\b|\bKeyboardEvent\b|\.keyboard\b|isKeyDown\s*\(/,
  mouse: /["'](?:mouse(?:down|up|move)|click|dblclick|contextmenu|wheel|pointer(?:down|up|move))["']|\bonmouse(?:down|move)\b|\bonclick\b|\.(?:activePointer|mousePointer)\b/,
  touch: /["']touch(?:start|end|move)["']|\bontouchstart\b|["']pointer(?:down|up|move)["']|\bTouchEvent\b|maxTouchPoints|\.(?:activePointer|pointer1)\b/,
  gamepad: /getGamepads\s*\(|["']gamepadconnected["']|\.gamepad\b/,
};

// The platform-hosted @gcp/ modules live outside the bundle, so what using each one implies is listed here.
const KIT_IMPORT = /(?:@gcp\/|\/kits\/v\d+\/)([a-z0-9-]+)\.js/g;
const ALL_INPUT: Input[] = ['keyboard', 'mouse', 'touch', 'gamepad'];
const KITS: Record<string, { graphics?: Graphics; input?: Input[]; features?: Feature[] }> = {
  input: { input: ALL_INPUT }, craft: { graphics: 'webgl2', input: ALL_INPUT }, 'three-kit': { graphics: 'webgl2' }, materials: { graphics: 'webgl2' },
  canvas2d: { graphics: 'canvas' }, craft2d: { graphics: 'canvas' }, audio: { features: ['web-audio'] }, sound: { features: ['web-audio'] },
};

/** What a bundle's code shows it needs, with the reason for each item. Pattern-based: a creator's declaration overrides it. */
export function detectRequirements(input: DetectInput): { requirements: Requirements; evidence: Record<string, string>; warnings: CompatIssue[] } {
  const texts = input.texts instanceof Map ? input.texts : new Map(Object.entries(input.texts));
  const ev: Record<string, string> = {}, warnings: CompatIssue[] = [];
  const firstFile = (rx: RegExp) => { for (const [f, s] of texts) if (!f.startsWith('server/') && rx.test(s)) return f; return null; };
  const hit = (key: string, rx: RegExp, why: string) => { const f = firstFile(rx); if (f && !ev[key]) ev[key] = `${why} (${f})`; return !!f; };
  const r = emptyRequirements(); r.input = [];
  const kits = new Map<string, string>();
  for (const [f, src] of texts) if (!f.startsWith('server/')) for (const m of src.matchAll(KIT_IMPORT)) if (KITS[m[1]] && !kits.has(m[1])) kits.set(m[1], f);
  const kitWhy = (k: string) => `@gcp/${k}.js (${kits.get(k)})`;
  const kitGraphics = [...kits.keys()].map((k) => KITS[k].graphics).filter(Boolean) as Graphics[];

  // graphics: the weakest API the code still runs with
  const webgpu = hit('webgpu', RX.webgpu, 'navigator.gpu'), threeGpu = hit('webgpu', RX.threeWebgpu, 'three.js WebGPURenderer');
  const three = hit('webgl2', RX.three, 'three.js (needs WebGL 2 since r163)'), unity = hit('engine', RX.unity, 'Unity web export'), godot = hit('engine', RX.godot, 'Godot web export');
  const gl2 = hit('webgl2', RX.gl2, 'getContext("webgl2")'), gl1 = hit('webgl', RX.gl1, 'getContext("webgl")'), glEngine = hit('webgl', RX.glEngine, 'a WebGL engine (Babylon.js, PlayCanvas or PixiJS)');
  const phaser = hit('canvas', RX.phaser, 'Phaser'), c2d = hit('canvas', RX.canvas2d, 'getContext("2d")'), ctag = hit('canvas', RX.canvasTag, 'a <canvas>');
  if (godot) ev.webgl2 ??= ev.engine;
  for (const k of kits.keys()) { const g = KITS[k].graphics; if (g) ev[g] ??= kitWhy(k); }
  const kitGL2 = kitGraphics.includes('webgl2'), kitCanvas = kitGraphics.includes('canvas');
  if (unity) ev.webgl ??= ev.engine;
  if (webgpu && !threeGpu && !three && !gl2 && !gl1 && !glEngine && !unity && !godot && !phaser && !c2d) r.graphics = 'webgpu';
  else if (gl1 || glEngine || unity) r.graphics = 'webgl';   // a WebGL 1 context anywhere: assume it is the fallback
  else if (three || threeGpu || gl2 || godot || kitGL2) r.graphics = 'webgl2';
  else if (phaser || c2d || ctag || kitCanvas) r.graphics = 'canvas';
  else r.graphics = 'none';
  if (r.graphics === 'webgl' && (three || threeGpu) && !gl1 && !glEngine && !unity) r.graphics = 'webgl2';
  if ((webgpu || threeGpu) && r.graphics !== 'webgpu') r.optional.push('webgpu');

  const need = (f: Feature, rx: RegExp, why: string) => { if (hit(f, rx, why)) r.features.push(f); };
  if (input.paths.some((p) => p.endsWith('.wasm')) || unity || godot) { r.features.push('webassembly'); ev.webassembly = ev.engine || `a .wasm file (${input.paths.find((p) => p.endsWith('.wasm'))})`; }
  else need('webassembly', RX.wasm, 'WebAssembly.instantiate');
  if (hit('wasm-threads', RX.threads, 'SharedArrayBuffer')) warnings.push({ level: 'warning', field: 'features', message: `The code mentions SharedArrayBuffer (${ev['wasm-threads']}). Games are not served cross-origin isolated, so it does not exist in the page.`, hint: 'Fine if the code only checks for it. A build that needs threads will not start: rebuild it single-threaded.' });
  need('web-audio', RX.audio, 'AudioContext');
  for (const k of kits.keys()) for (const f of KITS[k].features || []) { r.features.push(f); ev[f] ??= kitWhy(k); }
  need('audio-worklet', RX.worklet, 'an audio worklet');
  need('pointer-lock', RX.pointerLock, 'requestPointerLock()');
  need('web-workers', RX.workers, 'new Worker()');
  need('offscreen-canvas', RX.offscreen, 'OffscreenCanvas');
  need('indexeddb', RX.idb, 'indexedDB.open()');
  need('webxr', RX.xr, 'navigator.xr');
  need('webrtc', RX.rtc, 'RTCPeerConnection');
  need('device-motion', RX.motion, 'device motion events');
  need('es-modules', RX.module, 'JavaScript modules');
  if (input.bareImports) { r.features.push('import-maps'); ev['import-maps'] = 'bare imports resolved by the platform import map'; if (!r.features.includes('es-modules')) r.features.push('es-modules'); }
  // pointer lock is usually a nicety on top of mouse look; the creator can move it to required
  if (r.features.includes('pointer-lock')) { r.features = r.features.filter((f) => f !== 'pointer-lock'); r.optional.push('pointer-lock'); }

  for (const i of INPUTS) if (hit(`input:${i}`, RX[i], i === 'mouse' ? 'mouse or pointer events' : i === 'touch' ? 'touch or pointer events' : `${i} events`)) r.input.push(i);
  for (const k of kits.keys()) for (const i of KITS[k].input || []) if (!r.input.includes(i)) { r.input.push(i); ev[`input:${i}`] ??= kitWhy(k); }
  r.input = INPUTS.filter((i) => r.input.includes(i));
  if (!r.input.length) { r.input = unity || godot || phaser ? ['keyboard', 'mouse'] : ['mouse']; }
  // every game plays on every kind of device (a platform requirement): keyboard and mouse games get the platform's
  // on-screen controls and mouse events from the finger on touch screens
  r.devices = [...DEVICES];
  if (input.orientation === 'landscape' || input.orientation === 'portrait') r.orientation = input.orientation;
  r.features = uniq(r.features); r.optional = uniq(r.optional).filter((f) => !r.features.includes(f));
  delete ev.engine;
  return { requirements: r, evidence: ev, warnings };
}

/**
 * The requirements a version goes out with: the creator's declaration where they gave one, detected values where they did not.
 * Required features the code uses but the declaration never mentions are added (the creator can list them under optional).
 * Where the declaration claims less than the code seems to need, the declaration stands and a warning says so.
 */
export function mergeRequirements(declared: Partial<Requirements> | null, detected: Requirements): { requirements: Requirements; issues: CompatIssue[] } {
  const issues: CompatIssue[] = [];
  const w = (field: string, message: string, hint?: string) => issues.push({ level: 'warning', field, message, hint });
  if (!declared || !Object.keys(declared).length) {
    w('requirements', 'No requirements are declared, so the store page shows what the platform detected in the code.', 'Check them with the compatibility tool (action "check") and declare them (action "declare"), so players see exactly what the game needs.');
    return { requirements: { ...detected, features: [...detected.features], optional: [...detected.optional] }, issues };
  }
  const r: Requirements = { ...emptyRequirements(), ...detected, ...declared } as Requirements;
  r.features = [...(declared.features ?? [])]; r.optional = [...(declared.optional ?? [])];
  const mentioned = new Set([...r.features, ...r.optional]);
  const added = detected.features.filter((f) => !mentioned.has(f)), addedOpt = detected.optional.filter((f) => !mentioned.has(f));
  if (added.length) { r.features.push(...added); w('features', `The code uses ${added.map((f) => FEATURES[f].label).join(', ')}, which the declaration does not mention, so they were added as required.`, 'Declare them under features, or under optional if the game works without them.'); }
  if (addedOpt.length) r.optional.push(...addedOpt);
  if (declared.graphics && GRAPHICS.indexOf(declared.graphics) < GRAPHICS.indexOf(detected.graphics))
    w('graphics', `Declared graphics "${declared.graphics}", but the code looks like it needs "${detected.graphics}".`, `If the game has no fallback to ${declared.graphics}, declare "${detected.graphics}" so players without it are told before they launch.`);
  if (declared.input && detected.input.length) {
    const extra = declared.input.filter((i) => !detected.input.includes(i));
    if (extra.length) w('input', `Declared input ${extra.join(', ')}, but no code for it was found.`, 'Make sure it really works with that input before promising it to players.');
  }
  // devices that leave a kind out are a platform requirement, reported by deploy_preview and refused by publish
  // (src/platform-requirements.js), not a compatibility warning
  if (r.graphics === 'webgpu' && r.optional.includes('webgpu')) r.optional = r.optional.filter((f) => f !== 'webgpu');
  r.features = uniq(r.features); r.optional = uniq(r.optional).filter((f) => !r.features.includes(f));
  return { requirements: r, issues };
}

/** Builds the stored compatibility record of a version. */
export function buildCompat(declaredRaw: unknown, detect: DetectInput, downloadBytes: number): { compat: Compat; issues: CompatIssue[] } {
  const parsed = parseRequirements(declaredRaw), found = detectRequirements(detect);
  const declared = declaredRaw === undefined || declaredRaw === null ? null : parsed.value;
  const merged = mergeRequirements(declared, found.requirements);
  return {
    compat: { v: 1, requirements: merged.requirements, declared: !!declared && Object.keys(parsed.value).length > 0, detected: found.requirements, evidence: found.evidence, download_bytes: downloadBytes },
    issues: [...parsed.issues, ...merged.issues, ...found.warnings],
  };
}

// ---------------------------------------------------------------------------------------------
// The player's side: what this browser has, and the verdict
// ---------------------------------------------------------------------------------------------
export type Tri = boolean | null;   // null: the browser cannot tell
export interface Probe {
  graphics: Record<Exclude<Graphics, 'none'>, Tri>;
  gpu: 'hardware' | 'software' | null;  // from the WebGL renderer string
  renderer: string;
  features: Partial<Record<Feature, Tri>>;
  input: Record<Input, Tri>;
  device: Device;
  browser: { id: BrowserId | null; name: string; version: number | null };
  os: OsId | null;
  memory_gb: number | null;           // navigator.deviceMemory (Chromium only, capped at 8)
  orientation: 'landscape' | 'portrait';
}

export type RowState = 'ok' | 'no' | 'unknown' | 'info';
export interface Row { id: string; kind: 'graphics' | 'gpu' | 'feature' | 'optional' | 'input' | 'device' | 'orientation' | 'memory' | 'browser' | 'issue' | 'download'; state: RowState; need: string; have?: string; issue?: KnownIssue }
export interface Verdict { verdict: 'ok' | 'maybe' | 'no'; rows: Row[]; blockers: Row[]; doubts: Row[] }

/** Parses a user agent into a browser, its major version and the operating system. */
export function parseUA(ua: string, touchPoints = 0): { browser: Probe['browser']; os: OsId | null } {
  const m = (rx: RegExp) => { const x = ua.match(rx); return x ? Number(x[1]) : null; };
  let id: BrowserId | null = null, name = 'Unknown browser', version: number | null = null;
  if (/SamsungBrowser\//.test(ua)) { id = 'samsung'; name = 'Samsung Internet'; version = m(/SamsungBrowser\/(\d+)/); }
  else if (/\bEdg(?:e|A|iOS)?\//.test(ua)) { id = 'edge'; name = 'Edge'; version = m(/\bEdg(?:e|A|iOS)?\/(\d+)/); }
  else if (/\bOPR\//.test(ua)) { id = 'opera'; name = 'Opera'; version = m(/\bOPR\/(\d+)/); }
  else if (/Firefox\/|FxiOS\//.test(ua)) { id = 'firefox'; name = 'Firefox'; version = m(/(?:Firefox|FxiOS)\/(\d+)/); }
  else if (/Chrome\/|CriOS\//.test(ua)) { id = 'chrome'; name = 'Chrome'; version = m(/(?:Chrome|CriOS)\/(\d+)/); }
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) { id = 'safari'; name = 'Safari'; version = m(/Version\/(\d+)/); }
  const os: OsId | null = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'ios' : /Android/.test(ua) ? 'android' : /CrOS/.test(ua) ? 'chromeos'
    : /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'macos' : /Linux/.test(ua) ? 'linux' : null;
  return { browser: { id, name, version }, os };
}

const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Compares a game's requirements with what this browser has. */
export function evaluate(req: Requirements, p: Probe, downloadBytes = 0): Verdict {
  const rows: Row[] = [];
  const tri = (v: Tri): RowState => (v === true ? 'ok' : v === false ? 'no' : 'unknown');
  if (req.graphics !== 'none') {
    const have = (GRAPHICS.slice(1) as Exclude<Graphics, 'none'>[]).filter((g) => p.graphics[g]).pop();
    rows.push({ id: req.graphics, kind: 'graphics', state: tri(p.graphics[req.graphics]), need: req.graphics, have: have || 'none' });
  }
  if (req.gpu === 'hardware') rows.push({ id: 'gpu', kind: 'gpu', state: p.gpu === 'hardware' ? 'ok' : p.gpu === 'software' ? 'no' : 'unknown', need: 'hardware', have: p.renderer || undefined });
  for (const f of req.features) rows.push({ id: f, kind: 'feature', state: f === 'webgpu' ? tri(p.graphics.webgpu) : tri(p.features[f] ?? null), need: f });
  for (const f of req.optional) rows.push({ id: f, kind: 'optional', state: (f === 'webgpu' ? p.graphics.webgpu : p.features[f] ?? null) === true ? 'ok' : 'info', need: f });
  // input: any one way to play is enough
  const ins = req.input.map((i) => p.input[i]);
  rows.push({ id: 'input', kind: 'input', state: ins.some((x) => x === true) ? 'ok' : ins.every((x) => x === false) ? 'no' : 'unknown', need: req.input.join(','), have: INPUTS.filter((i) => p.input[i]).join(',') });
  rows.push({ id: 'device', kind: 'device', state: req.devices.includes(p.device) ? 'ok' : 'no', need: req.devices.join(','), have: p.device });
  if (req.orientation !== 'any') rows.push({ id: 'orientation', kind: 'orientation', state: p.device === 'desktop' || p.orientation === req.orientation ? 'ok' : 'info', need: req.orientation, have: p.orientation });
  if (req.memory_gb) rows.push({ id: 'memory', kind: 'memory', state: p.memory_gb == null ? 'unknown' : p.memory_gb >= req.memory_gb || p.memory_gb >= 8 ? 'ok' : 'no', need: String(req.memory_gb), have: p.memory_gb == null ? undefined : String(p.memory_gb) });
  const minV = p.browser.id ? req.browsers[p.browser.id] : undefined;
  if (minV) rows.push({ id: 'browser', kind: 'browser', state: p.browser.version == null ? 'unknown' : p.browser.version >= minV ? 'ok' : 'no', need: `${p.browser.id} ${minV}`, have: p.browser.version == null ? undefined : `${p.browser.name} ${p.browser.version}` });
  for (const k of req.known_issues) {
    const hits = (!k.browser || k.browser === p.browser.id) && (!k.os || k.os === p.os);
    if (hits) rows.push({ id: `issue:${k.browser || ''}:${k.os || ''}`, kind: 'issue', state: k.severity === 'broken' ? 'no' : 'unknown', need: k.note, issue: k });
  }
  if (downloadBytes) rows.push({ id: 'download', kind: 'download', state: 'info', need: fmtBytes(downloadBytes) });
  const blockers = rows.filter((r) => r.state === 'no'), doubts = rows.filter((r) => r.state === 'unknown');
  return { verdict: blockers.length ? 'no' : doubts.length ? 'maybe' : 'ok', rows, blockers, doubts };
}

/** One line per requirement, for agents and the console. */
export function describeRequirements(r: Requirements): string[] {
  const G: Record<Graphics, string> = { none: 'No graphics API (DOM and CSS)', canvas: 'Canvas 2D', webgl: 'WebGL 1', webgl2: 'WebGL 2', webgpu: 'WebGPU' };
  return [
    `Graphics: ${G[r.graphics]} or better${r.gpu === 'hardware' ? ', with a hardware GPU' : ''}`,
    ...(r.features.length ? [`Needs: ${r.features.map((f) => FEATURES[f].label).join(', ')}`] : []),
    ...(r.optional.length ? [`Uses when available: ${r.optional.map((f) => FEATURES[f].label).join(', ')}`] : []),
    `Input: ${r.input.join(', ')}`, `Devices: ${r.devices.join(', ')}`,
    ...(r.orientation !== 'any' ? [`Orientation: ${r.orientation}`] : []),
    ...(r.memory_gb ? [`Memory: ${r.memory_gb} GB or more`] : []),
    ...(Object.keys(r.browsers).length ? [`Browsers: ${Object.entries(r.browsers).map(([b, v]) => `${b} ${v}+`).join(', ')}`] : []),
    ...r.known_issues.map((k) => `Known issue (${[k.browser, k.os].filter(Boolean).join(' on ')}, ${k.severity}): ${k.note}`),
    ...(r.notes ? [`Notes: ${r.notes}`] : []),
  ];
}

/**
 * Requirements the workspace declares (gcp.json) that a version does not carry, because it was deployed before they were
 * declared: build fields are frozen with a version, so publishing it shows the older values on the store page. Only the
 * fields the workspace names are compared; the answer is what publish and its dry run tell the agent.
 */
export function requirementsDrift(declared: Partial<Requirements>, version: Requirements): { field: string; declared: string; version: string }[] {
  const show = (k: string, v: unknown) => k === 'orientation' && v === 'any' ? 'both' : Array.isArray(v) ? [...v].map(String).sort().join(', ') || 'none' : v == null ? 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const out: { field: string; declared: string; version: string }[] = [];
  for (const k of ['orientation', 'devices', 'input', 'graphics', 'gpu', 'features', 'optional', 'memory_gb'] as const) {
    if (declared[k] === undefined) continue;
    const a = show(k, declared[k]), b = show(k, version[k]);
    if (a !== b) out.push({ field: k, declared: a, version: b });
  }
  return out;
}
