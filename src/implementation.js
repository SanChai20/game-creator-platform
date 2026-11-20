// How a published game was built, told without its code. The platform reads the files of the live version and
// writes down facts: engine, rendering, input, audio, assets, platform services, loop and performance techniques,
// structure and what verification measured. Only names, counts and yes/no answers leave this module, never source
// text, so a card built from it cannot leak code. Plain JavaScript so node tests can import it directly.

const KIND = {
  code: ['js', 'mjs', 'cjs', 'ts'], markup: ['html', 'htm'], styles: ['css'], images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg', 'ktx2', 'basis', 'bmp', 'ico'],
  audio: ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'opus', 'flac', 'webm'], models: ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'vox', 'dae', 'usdz', 'bin'],
  fonts: ['woff', 'woff2', 'ttf', 'otf'], wasm: ['wasm'], shaders: ['glsl', 'wgsl', 'vert', 'frag'], data: ['json', 'txt', 'csv', 'xml', 'tmx', 'tmj', 'tsx', 'pck', 'data', 'mem', 'unityweb', 'atlas', 'fnt', 'md'],
};
const kindOf = (path) => { const e = (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase(); for (const [k, list] of Object.entries(KIND)) if (list.includes(e)) return k; return 'other'; };
export const READABLE = (path) => ['code', 'markup', 'shaders'].includes(kindOf(path)) || /\.json$/i.test(path);

// Engines and frameworks, recognised in any file (an engine's own bundle counts here).
const ENGINES = [
  ['Unity', /createUnityInstance|UnityLoader|unityFramework|\.framework\.js|unityweb/],
  ['Godot', /GODOT_CONFIG|godot\.(?:js|wasm|tools)|\$GODOT|Godot Engine/],
  ['Construct', /c3runtime|C3_RUNTIME|c2runtime|cr_getC2Runtime/],
  ['GameMaker', /GameMaker|GMS_API|html5game\/|gml_Script/],
  ['Defold', /dmloader|Defold|DMLoader/],
  ['Cocos Creator', /cc\.game\.run|cocos2d|CocosEngine|cc\.director/],
  ['PlayCanvas', /pc\.Application|playcanvas/i],
  ['Babylon.js', /BABYLON\.(?:Engine|Scene)|@babylonjs|babylon(?:\.max)?\.js/],
  ['Phaser', /Phaser\.(?:Game|AUTO|Scene|WEBGL|CANVAS)|from\s*["']phaser["']|phaser(?:\.min)?\.js/],
  ['PixiJS', /PIXI\.(?:Application|Sprite|Container)|from\s*["']pixi\.js["']|pixi(?:\.min)?\.m?js/],
  ['Excalibur', /ex\.Engine|from\s*["']excalibur["']/],
  ['KAPLAY / Kaboom', /\bkaplay\s*\(|\bkaboom\s*\(/],
  ['melonJS', /me\.(?:video|game)\.|melonjs/i],
  ['LittleJS', /engineInit\s*\(|littlejs/i],
  ['three.js', /from\s*["']three(?:\/[^"']*)?["']|THREE\.(?:WebGLRenderer|Scene|Mesh)|three(?:\.module)?(?:\.min)?\.js|new\s+\w*WebGLRenderer\s*\(/],
  ['Emscripten / WebAssembly', /emscripten|wasm_bindgen|__wbindgen|Module\[["']asm["']\]/],
];
const LIBRARIES = [
  ['Howler', /\bHowl\s*\(|howler/i], ['Tone.js', /\bTone\.(?:Synth|Transport|start)/], ['Matter.js', /Matter\.(?:Engine|Bodies|World)/], ['cannon-es', /CANNON\.|cannon-es/],
  ['Rapier', /@dimforge\/rapier|RAPIER\./], ['Ammo.js', /\bAmmo\s*\(\)|ammo\.wasm/], ['Box2D / Planck', /box2d|planck\.World/i], ['GSAP', /\bgsap\.(?:to|from|timeline)/],
  ['lil-gui / dat.gui', /lil-gui|dat\.GUI/], ['Socket-free WebRTC', /RTCPeerConnection/],
];

// Read only in the game's own code: an engine bundle mentions every event and technique, which would say nothing.
const FEATURES = {
  rendering: [['WebGPU', /navigator\.gpu|WebGPURenderer|requestAdapter\s*\(/], ['WebGL', /getContext\(\s*["'](?:webgl2?|experimental-webgl)["']|WebGLRenderer|WebGL2RenderingContext/], ['Canvas 2D', /getContext\(\s*["']2d["']/], ['SVG', /<svg[\s>]|createElementNS\([^)]*svg/]],
  graphics: [
    ['3D perspective camera', /PerspectiveCamera|ArcRotateCamera|UniversalCamera|FreeCamera/], ['orthographic camera', /OrthographicCamera/], ['dynamic lights', /DirectionalLight|PointLight|SpotLight|HemisphereLight/],
    ['shadows', /shadowMap\.enabled|castShadow\s*=\s*(?:!0|true)|ShadowGenerator/], ['fog', /scene\.fog|\bFog(?:Exp2)?\s*\(/], ['post-processing', /EffectComposer|RenderPass|UnrealBloomPass|postprocessing|DefaultRenderingPipeline/],
    ['instanced drawing', /InstancedMesh|drawArraysInstanced|drawElementsInstanced|thinInstance|InstancedBufferGeometry/], ['custom shaders', /ShaderMaterial|RawShaderMaterial|gl_FragColor|createShader\s*\(|@fragment|onBeforeCompile|NodeMaterial/],
    ['glTF models', /GLTFLoader|\.glb["'`]|\.gltf["'`]/], ['particles', /particle/i], ['sprite sheets or atlases', /sprite\s*sheet|spritesheet|texture\s*atlas|\.atlas["'`]/i], ['tile maps', /tilewidth|tilemap|tileset|tileSize/i],
    ['procedural textures', /CanvasTexture|DataTexture|createImageData|putImageData/], ['gradients and vector drawing', /createLinearGradient|createRadialGradient|\.arc\s*\(|\.bezierCurveTo\s*\(/], ['screen shake or camera juice', /shake/i], ['tweening', /tween|easeOut|easeIn|lerp\s*\(/i],
  ],
  input: [
    ['keyboard', /keydown|keyup|keypress/], ['mouse', /mousedown|mousemove|mouseup|["']click["']|onclick|["']wheel["']|contextmenu/], ['touch', /touchstart|touchmove|touchend/], ['pointer events', /pointerdown|pointermove|pointerup/],
    ['gamepad', /getGamepads|gamepadconnected/], ['pointer lock (mouse look)', /requestPointerLock/], ['device motion', /deviceorientation|devicemotion/], ['on-screen controls', /joystick|virtual[-_ ]?(?:pad|stick|button)|d-?pad|touch[-_ ]?controls/i],
  ],
  audio: [['Web Audio', /AudioContext|webkitAudioContext/], ['synthesized sound', /createOscillator|OscillatorNode|createBuffer\s*\(/], ['HTML audio', /new\s+Audio\s*\(|<audio[\s>]/], ['music', /music|bgm|soundtrack/i]],
  storage: [['localStorage', /localStorage/], ['IndexedDB', /indexedDB/]],
  loop: [
    ['requestAnimationFrame loop', /requestAnimationFrame|setAnimationLoop|ticker\.add|onBeforeRender/], ['fixed timestep', /accumulator|fixed[_ ]?(?:delta|step|dt|update)|FIXED_(?:DT|STEP)|STEP\s*=\s*1\s*\/\s*\d+/i],
    ['delta-time movement', /\b(?:dt|deltaTime|delta)\b/], ['object pooling', /\bpool\b|Pool\b|pooled/i], ['spatial partitioning', /quadtree|spatial\s*hash|broadphase|uniform\s*grid|bvh/i],
    ['Web Workers', /new\s+Worker\s*\(/], ['OffscreenCanvas', /OffscreenCanvas/], ['pixel ratio capped', /Math\.min\(\s*(?:window\.)?devicePixelRatio|setPixelRatio\(\s*Math\.min|Math\.min\([^)]*devicePixelRatio/],
    ['pauses when hidden', /visibilitychange|document\.hidden/], ['seeded randomness', /seed/i], ['state machine', /state\s*machine|setState\s*\(|switch\s*\(\s*(?:this\.)?(?:state|mode|phase)\b/i], ['level data', /levels?\s*[=:]\s*\[|level\d|stage\s*[=:]\s*\[/i],
  ],
  platform: [
    ['player saves', /\b(?:GCP|G|gcp)\.save\./], ['shared game data', /\b(?:GCP|G|gcp)\.shared\./], ['leaderboards', /\b(?:GCP|G|gcp)\.leaderboard\./], ['multiplayer rooms', /\b(?:GCP|G|gcp)\.room\s*\(/], ['server code', /\b(?:GCP|G|gcp)\.server\b/],
    ['loading progress', /\b(?:GCP|G|gcp)\.progress\s*\(|boot\.step\s*\(/], ['fullscreen', /\b(?:GCP|G|gcp)\.fullscreen\s*\(|requestFullscreen/], ['play-through hook', /\.test\.onPlaythrough/], ['two-player hook', /\.test\.onTwoPlayers/],
  ],
};

// The platform's optional kits (/kits/v1/*.js, imported as @gcp/<kit>.js) and what using each one means.
const KITS = {
  core: { loop: ['requestAnimationFrame loop', 'delta-time movement', 'seeded randomness'] },
  input: { input: ['keyboard', 'mouse', 'touch', 'gamepad', 'on-screen controls'] },
  canvas2d: { rendering: ['Canvas 2D'], graphics: ['sprites baked once to offscreen canvases', 'y-sorted drawing'], loop: ['pixel ratio capped'] },
  'three-kit': { rendering: ['WebGL'], graphics: ['procedural textures'] },
  audio: { audio: ['Web Audio', 'synthesized sound'] }, sound: { audio: ['Web Audio', 'synthesized sound', 'music'] },
  hud: { graphics: ['canvas interface over the game'] }, ui: { graphics: ['canvas interface over the game'] }, net: { platform: ['multiplayer rooms'], loop: ['host-authoritative snapshots with interpolation'] },
  craft: { graphics: ['procedural 3D scenery', 'shadows', 'fog'] }, craft2d: { rendering: ['Canvas 2D'], graphics: ['procedural 2D scenery', 'dynamic lights'] },
  materials: { graphics: ['procedural materials'] }, procgen: { loop: ['seeded randomness'], graphics: ['procedural generation'] }, play: { loop: ['inventory and crafting systems'] },
};
const KIT_IMPORT = /(?:@gcp\/|\/kits\/v\d+\/)([a-z0-9-]+)\.js/g;

const VENDOR_NAME = /(?:^|\/)(?:vendor|vendors|lib|libs|node_modules|third[-_]?party|external)\/|(?:^|\/)(?:three|phaser|pixi|babylon|howler|matter|cannon|playcanvas|ammo|rapier|tone|gsap|lil-gui|dat\.gui|jquery|react|vue)[\w.-]*\.m?js$|\.min\.m?js$/i;
/** True when a file looks like a library or an engine runtime rather than the game's own code. */
export function isVendor(path, text) {
  if (VENDOR_NAME.test(path)) return true;
  if (text && text.length > 150_000) { const lines = text.split('\n').length; if (text.length / lines > 400) return true; }
  return /(?:^|\/)Build\/[^/]+\.(?:framework|loader)\.js$/.test(path);
}

const STEP_OK = (s) => typeof s === 'string' && s.length <= 80 && !/[{};=<>]|=>|function\s*\(|\bvar\b|\bconst\b/.test(s);

/**
 * @param {{ path: string, size: number, text?: string | null }[]} files every file of the version; text for those read
 * @param {any} report the verification report of the version (checks, metrics, playthrough)
 */
export function analyzeBundle(files, report) {
  const kinds = {}, folders = new Map();
  let bytes = 0, ownBytes = 0, ownLines = 0, modules = false;
  const own = [], all = [];
  for (const f of files) {
    const k = kindOf(f.path); kinds[k] = (kinds[k] || 0) + 1; bytes += f.size || 0;
    const top = f.path.includes('/') ? f.path.split('/')[0] : null;
    if (top) folders.set(top, (folders.get(top) || 0) + 1);
    if (typeof f.text !== 'string') continue;
    all.push(f.text);
    if (/^server\//.test(f.path)) continue;
    if (!isVendor(f.path, f.text)) {
      own.push(f.text);
      if (k === 'code' || k === 'markup') { ownBytes += f.text.length; ownLines += f.text.split('\n').length; }
      if (/type\s*=\s*["']module["']|^\s*import\s[^;]*from\s*["']/m.test(f.text)) modules = true;
    }
  }
  const allText = all.join('\n'), ownText = own.join('\n');
  const pick = (list, text) => list.filter(([, re]) => re.test(text)).map(([name]) => name);

  const engines = pick(ENGINES, allText);
  // a full engine wins over a renderer library it may bundle (Unity's loader, Babylon's own three-like names)
  const engine = engines.find((e) => !['three.js', 'Emscripten / WebAssembly'].includes(e)) || engines[0] || 'none: hand-written on browser APIs';
  const f = {};
  for (const [key, list] of Object.entries(FEATURES)) f[key] = pick(list, key === 'platform' ? allText : ownText);
  const kits = [...new Set([...ownText.matchAll(KIT_IMPORT)].map((x) => x[1]).filter((k) => KITS[k]))];
  for (const k of kits) for (const [key, vals] of Object.entries(KITS[k])) for (const v of vals) if (!f[key].includes(v)) f[key].push(v);
  const serverCode = files.some((x) => /^server\/index\.m?js$/.test(x.path));
  if (serverCode && !f.platform.includes('server code')) f.platform.push('server code');
  if (!f.rendering.length) f.rendering = ['WebGL', 'Babylon.js', 'PlayCanvas', 'three.js', 'Unity', 'Godot', 'PixiJS', 'Phaser', 'Cocos Creator', 'Defold'].includes(engine) ? ['WebGL'] : /<canvas/i.test(ownText) ? ['Canvas'] : ['DOM and CSS'];
  if (['three.js', 'Babylon.js', 'PlayCanvas'].includes(engine) && !f.rendering.includes('WebGL') && !f.rendering.includes('WebGPU')) f.rendering.unshift('WebGL');
  if ((kinds.models || 0) > 0 && !f.graphics.includes('glTF models') && files.some((x) => /\.(glb|gltf)$/i.test(x.path))) f.graphics.push('glTF models');
  if ((kinds.shaders || 0) > 0 && !f.graphics.includes('custom shaders')) f.graphics.push('custom shaders');
  if (!f.audio.length && (kinds.audio || 0) > 0) f.audio.push('audio files');

  const images = kinds.images || 0, audio = kinds.audio || 0, models = kinds.models || 0;
  const play = report && report.playthrough, m = (report && report.metrics) || {};
  const steps = play && Array.isArray(play.steps) ? play.steps.filter(STEP_OK).slice(0, 12) : [];
  const facts = {
    engine, libraries: pick(LIBRARIES, allText), platform_kits: kits,
    rendering: f.rendering, graphics: f.graphics, input: f.input, audio: f.audio,
    assets: {
      images, audio_files: audio, models, fonts: kinds.fonts || 0,
      approach: images + models === 0 ? 'procedural: no image or model files, everything is drawn or generated in code' : images + models < 6 ? 'mostly procedural, with a few image or model files' : 'file-based art: images or models loaded from the bundle',
    },
    platform_services: f.platform, storage: f.storage, loop_and_performance: f.loop,
    structure: {
      files: files.length, bytes, by_kind: kinds, own_code_kb: Math.round(ownBytes / 1024), own_code_lines: ownLines,
      modules: modules ? 'ES modules' : 'classic scripts', wasm: (kinds.wasm || 0) > 0, server_code: serverCode,
      folders: [...folders].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, files: n })),
    },
    gameplay: { playthrough_steps: steps, playthrough_verified: !!(play && play.ok), two_players_verified: !!(report && report.two_players && report.two_players.ok) },
    verified: { measured_on: 'the platform verifier, a software GPU: real devices are faster', load_ms: m.loadMs ?? null, fps_in_check: m.fps ?? null, canvas: m.canvas ? `${m.canvas.w || m.canvas.width || '?'}x${m.canvas.h || m.canvas.height || '?'}` : null },
  };
  facts.keywords = keywordsOf(facts);
  return facts;
}

/** Lower-case words that find_implementations matches against. */
export function keywordsOf(facts) {
  const words = new Set();
  const add = (s) => String(s).toLowerCase().split(/[^a-z0-9.+-]+/).filter((w) => w.length > 1).forEach((w) => words.add(w));
  [facts.engine, ...facts.libraries, ...(facts.platform_kits || []), ...facts.rendering, ...facts.graphics, ...facts.input, ...facts.audio, ...facts.platform_services, ...facts.storage, ...facts.loop_and_performance].forEach(add);
  if (facts.platform_services.includes('multiplayer rooms')) ['multiplayer', 'online', 'rooms'].forEach((w) => words.add(w));
  if (facts.graphics.includes('3D perspective camera') || ['three.js', 'Babylon.js', 'PlayCanvas'].includes(facts.engine)) words.add('3d');
  else words.add('2d');
  return [...words].slice(0, 80);
}

const list = (a, max = 6) => { const x = a.slice(0, max); return x.length <= 1 ? x.join('') : `${x.slice(0, -1).join(', ')} and ${x[x.length - 1]}`; };

/** A summary written from the facts alone, used when no AI summary is available. */
export function ruleSummary(listing, facts) {
  const tags = (listing.tags || []).slice(0, 3).join(', ');
  const s = [];
  s.push(`${listing.title} is a ${tags ? tags + ' ' : ''}web game ${facts.engine.startsWith('none') ? 'written directly on browser APIs without an engine' : `built with ${facts.engine}`}${facts.libraries.length ? ` plus ${list(facts.libraries)}` : ''}, rendering with ${list(facts.rendering)}.`);
  if (facts.platform_kits && facts.platform_kits.length) s.push(`It builds on the platform's ${list(facts.platform_kits)} kit${facts.platform_kits.length > 1 ? 's' : ''}, which anyone can import from /kits/v1.`);
  if (facts.graphics.length) s.push(`On screen it uses ${list(facts.graphics, 7)}.`);
  s.push(`Art is ${facts.assets.approach}${facts.assets.images || facts.assets.models ? ` (${facts.assets.images} images, ${facts.assets.models} models)` : ''}.`);
  if (facts.input.length) s.push(`Players control it with ${list(facts.input)}.`);
  if (facts.audio.length) s.push(`Sound comes from ${list(facts.audio)}${facts.assets.audio_files ? ` with ${facts.assets.audio_files} audio files` : ''}.`);
  if (facts.loop_and_performance.length) s.push(`The game loop uses ${list(facts.loop_and_performance, 7)}.`);
  if (facts.platform_services.length) s.push(`From the platform it uses ${list(facts.platform_services, 8)}.`);
  const st = facts.structure;
  s.push(`The build is ${st.files} files (${Math.round(st.bytes / 1024)} KB) written as ${st.modules}, about ${st.own_code_lines} lines of the game's own code${st.wasm ? ' plus WebAssembly' : ''}.`);
  if (facts.gameplay.playthrough_steps.length) s.push(`Its verified play-through goes: ${facts.gameplay.playthrough_steps.join(' → ')}.`);
  if (facts.verified.load_ms != null) s.push(`In the platform's check it loaded in ${facts.verified.load_ms} ms and ran at ${facts.verified.fps_in_check} fps on a software GPU.`);
  return s.join(' ');
}

/** Removes anything code-like from model output: fences, inline code, and lines dense with code punctuation. */
export function scrubSummary(text) {
  let s = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, (m) => m.slice(1, -1).replace(/[(){};=<>]/g, ' '));
  s = s.split('\n').filter((l) => { const sym = (l.match(/[{}();=<>[\]]/g) || []).length; return !(sym > 6 && sym / Math.max(1, l.length) > 0.04) && !/^\s*(?:const|let|var|function|import|export|class)\s/.test(l); }).join('\n');
  return s.replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2400);
}

/** What the patterns across several open games look like, for "how are games of this type built". */
export function aggregate(factsList) {
  const n = factsList.length, count = (pick) => { const m = new Map(); for (const f of factsList) for (const v of new Set(pick(f))) m.set(v, (m.get(v) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, games]) => ({ name, games, share: Math.round((games / n) * 100) })); };
  return {
    games: n,
    engine: count((f) => [f.engine]), rendering: count((f) => f.rendering), graphics: count((f) => f.graphics), input: count((f) => f.input), audio: count((f) => f.audio),
    art: count((f) => [f.assets.approach.split(':')[0]]), platform_services: count((f) => f.platform_services), loop_and_performance: count((f) => f.loop_and_performance),
    median_own_code_lines: n ? factsList.map((f) => f.structure.own_code_lines).sort((a, b) => a - b)[Math.floor(n / 2)] : 0,
  };
}
