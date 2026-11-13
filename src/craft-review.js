// The craft review: a measured, deterministic look at how finished a game is, beyond "it runs".
// It reads the verifier's screenshots and the SDK's probes (what the page draws, plays and listens to) and
// scores seven things a player notices. Every low score comes with what was measured and a concrete fix.
// It is engine-agnostic: nothing here knows about Three.js or about the platform's own building blocks,
// except the fix texts, which name the block that would raise the number.
import { unzlibSync } from 'fflate';

/** Decodes an 8-bit RGB/RGBA PNG to raw pixels. Returns null for anything else. */
export function decodePng(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let p = 8, w = 0, h = 0, ctype = 0, depth = 0; const idat = [];
  while (p < u.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = u[p + 16]; ctype = u[p + 17]; }
    else if (type === 'IDAT') idat.push(u.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6) || !w || !h) return null;
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
  const all = new Uint8Array(idat.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of idat) { all.set(c, o); o += c.length; }
  const raw = unzlibSync(all), px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v;
    }
  }
  return { w, h, bpp, stride, px };
}

/** Luminance plane (0..255) of a decoded image. */
function lumaOf(img) {
  const { w, h, bpp, stride, px } = img, L = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * stride + x * bpp; L[y * w + x] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8; }
  return L;
}

/**
 * What one screenshot says about surfaces, light and colour.
 *  detail  share of 8x8 blocks with real variation inside them (texture, small shapes, foliage)
 *  flat    share of 8x8 blocks that are one flat colour (untextured faces, an empty sky, a bare background)
 *  range   spread between the dark 5% and the bright 5% of the picture, 0..255
 *  hues    number of the 12 hue families that cover at least 3% of the coloured pixels
 *  sat     mean saturation of the picture, 0..1
 */
export function imageMetrics(img) {
  const { w, h, bpp, stride, px } = img, L = lumaOf(img), n = w * h;
  const hist = new Uint32Array(256); for (let i = 0; i < n; i++) hist[L[i]]++;
  const pct = (q) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * q) return v; } return 255; };
  let flat = 0, detail = 0, blocks = 0;
  for (let by = 0; by + 8 <= h; by += 8) for (let bx = 0; bx + 8 <= w; bx += 8) {
    let s = 0, s2 = 0;
    for (let y = 0; y < 8; y++) { const row = (by + y) * w + bx; for (let x = 0; x < 8; x++) { const v = L[row + x]; s += v; s2 += v * v; } }
    const sd = Math.sqrt(Math.max(0, s2 / 64 - (s / 64) * (s / 64)));
    blocks++; if (sd < 1.1) flat++; else if (sd >= 5) detail++;
  }
  const hue = new Float64Array(12); let satSum = 0, coloured = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = y * stride + x * bpp, r = px[i], g = px[i + 1], b = px[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, sat = mx ? d / mx : 0;
    satSum += sat;
    if (sat > 0.18 && mx > 40) {
      let hh = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; if (hh < 0) hh += 6;
      hue[Math.min(11, Math.floor(hh * 2))]++; coloured++;
    }
  }
  let hues = 0; if (coloured > (n / 4) * 0.03) for (let i = 0; i < 12; i++) if (hue[i] / coloured >= 0.03) hues++;
  return { w, h, detail: detail / blocks, flat: flat / blocks, range: pct(0.95) - pct(0.05), hues, sat: satSum / (n / 4) };
}

/** Share of 16x16 blocks that changed between two screenshots of the same size. */
export function motionBetween(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return 0;
  const A = lumaOf(a), B = lumaOf(b), { w, h } = a; let moved = 0, blocks = 0;
  for (let by = 0; by + 16 <= h; by += 16) for (let bx = 0; bx + 16 <= w; bx += 16) {
    let d = 0;
    for (let y = 0; y < 16; y += 2) { const row = (by + y) * w + bx; for (let x = 0; x < 16; x += 2) d += Math.abs(A[row + x] - B[row + x]); }
    blocks++; if (d / 64 > 2.5) moved++;
  }
  return blocks ? moved / blocks : 0;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
const logRamp = (v, lo, hi) => clamp01((Math.log(Math.max(v, 1)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));
const pctText = (v) => `${Math.round(v * 100)}%`;
const num = (v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

/**
 * @param m  { stills: [imageMetrics…] (the game at rest and after input), idleMotion, inputChange (bool),
 *             probe (window.__GCP.probe), ui: { texts, chars }, playthrough: report.playthrough, warnings: n }
 * @returns { score, level, summary, dimensions: [{ id, label, score, max, measured, fix }], next: [string] }
 */
export function craftReview(m) {
  const P = m.probe || {}, gl = P.gl && P.gl.frames ? P.gl : null, c2 = P.c2d && P.c2d.frames ? P.c2d : null;
  const stills = (m.stills || []).filter(Boolean), dims = [];
  const best = (k) => (stills.length ? Math.max(...stills.map((s) => s[k])) : 0), least = (k) => (stills.length ? Math.min(...stills.map((s) => s[k])) : 1);
  const add = (id, label, max, share, measured, fix) => dims.push({ id, label, max, score: Math.round(max * clamp01(share)), measured, fix: clamp01(share) >= 0.8 ? '' : fix });
  const is3d = !!gl;

  // 1. surfaces: do things have texture and small-scale shape, or are they flat fills?
  const detail = best('detail'), flat = least('flat');
  const textures = gl ? gl.textures : c2 ? c2.baked : 0;
  const texShare = ramp(textures, 0, 8);
  add('surfaces', 'Surfaces have detail', 25, 0.55 * ramp(detail, 0.12, 0.45) + 0.2 * (1 - ramp(flat, 0.3, 0.7)) + 0.25 * texShare,
    `${pctText(detail)} of the picture has fine detail, ${pctText(flat)} is flat single colour; ${textures} ${is3d ? 'painted or loaded textures in use' : 'pre-painted sprites or tiles'}`,
    is3d ? 'Most faces are an untextured flat colour. Give the ground, bark, stone, wood and metal a painted texture with surface(kind) from @gcp/craft.js, and build props from several shaped parts instead of one primitive (tree(), rock(), bush(), grassField()).'
      : 'Large areas are flat fills. Paint tiles and sprites once on off-screen canvases (bake() in @gcp/canvas2d.js) with shading, outlines and small marks, and scatter ground details.');

  // 2. light and colour: tonal range, a palette with more than one family, shadows or other lighting passes
  const range = best('range'), hues = best('hues'), passes = gl ? gl.maxPasses : 0;
  add('light', 'Light and colour', 15, (is3d ? 0.45 : 0.65) * ramp(range, 70, 160) + (is3d ? 0.25 : 0.35) * ramp(hues, 1, 3) + (is3d ? 0.3 * (passes > 0 ? 1 : 0) : 0),
    `tonal range ${range} of 255, ${hues} colour ${hues === 1 ? 'family' : 'families'}${is3d ? `, ${passes ? `${passes} extra render pass${passes > 1 ? 'es' : ''} (shadows or effects)` : 'no shadow or effect pass'}` : ''}`,
    is3d ? 'The picture is tonally flat or nearly one colour. Use createStage({ mood }) from @gcp/craft.js for a sky gradient, a warm sun against cool ambient light, matching fog and a shadow pass, and give gameplay objects an accent colour that is not in the scenery.'
      : 'The picture is tonally flat or nearly one colour. Darken the edges or add a light gradient, shade sprites from one light direction, and pick an accent colour for things the player must notice.');

  // 3. world: how much is on screen
  if (is3d) {
    const tris = gl.sumTris / gl.frames, calls = gl.sumCalls / gl.frames, kinds = gl.kinds || Math.round(calls);
    add('world', 'The world is furnished', 15, 0.5 * logRamp(kinds, 6, 60) + 0.25 * ramp(gl.programs, 3, 14) + 0.25 * logRamp(tris, 3000, 100000),
      `${kinds} different shapes on screen, ${gl.programs} different materials, ${num(tris)} triangles in ${Math.round(calls)} draw calls a frame${gl.instanced ? ' (instancing in use)' : ''}`,
      'The scene is made of few kinds of things. Add more kinds, not more copies: several species from tree(), rock(), bush(), flowers and grassField(), props that fit the setting from prop(kind), water(), and scatter() to place them (it instances, so hundreds of copies stay cheap).');
  } else {
    const ops = c2 ? c2.sumOps / c2.frames : 0, images = c2 ? c2.sumImages / c2.frames : 0;
    add('world', 'The world is furnished', 15, 0.6 * logRamp(images, 4, 80) + 0.4 * logRamp(ops, 20, 300),
      `${Math.round(images)} sprites and ${Math.round(ops)} drawing operations a frame`,
      'Little is drawn each frame. Add scenery layers (ground marks, plants, stones, shadows under things), more than one kind of each, and something in the background.');
  }

  // 4. motion: is anything alive when the player does nothing, and does the picture answer input?
  const idle = m.idleMotion || 0;
  add('motion', 'The world moves', 12, 0.6 * ramp(idle, 0.004, 0.06) + 0.4 * (m.inputChange ? 1 : 0),
    `${pctText(idle)} of the picture changes while nothing is pressed; the picture ${m.inputChange ? 'changes' : 'does not change'} after input`,
    is3d ? 'The scene is a still image until the player acts. Add ambient motion: wind in foliage and grass (on by default in tree(), grassField()), moving water(), drifting motes or weather (createStage({ weather })), bobbing or spinning pickups, an idle animation on the character (actor.animate).'
      : 'The scene is a still image until the player acts. Animate idle sprites, drift particles, sway plants, scroll a background layer.');

  // 5. sound
  const au = P.audio || { contexts: 0, starts: 0 };
  add('sound', 'It has sound', 10, au.starts >= 1 ? 1 : au.contexts ? 0.7 : 0,
    au.starts ? `${au.starts} sounds played during the check` : au.contexts ? 'a sound system exists, but nothing played when keys were pressed, the pointer clicked or the play-through ran' : 'no sound at all',
    'Silent games feel unfinished. createSound() from @gcp/craft.js gives ready effects with no files (sound.play("pickup"), "jump", "hit", "step", "win", "lose", "click") and looping ambience (sound.ambience("wind")). Start sound on the first key or pointer press; browsers block it before that.');

  // 6. interface: a HUD, loading feedback, and input on every kind of device
  const Ls = P.listeners || {}, ui = m.ui || { texts: 0, chars: 0 };
  const touch = !!(Ls.touchstart || Ls.pointerdown), keys = !!Ls.keydown;
  add('interface', 'Interface and input', 13, 0.4 * ramp(ui.texts, 0, 6) + 0.15 * ((P.progress || 0) >= 2 ? 1 : 0) + 0.25 * (touch ? 1 : 0) + 0.1 * (keys ? 1 : 0) + 0.1 * (Ls.resize ? 1 : 0),
    `${ui.texts} on-screen text elements; loading progress ${(P.progress || 0) >= 2 ? 'reported' : 'not reported'}; listens for ${[keys && 'keyboard', (Ls.pointerdown || Ls.mousedown) && 'pointer', Ls.touchstart && 'touch', Ls.gamepadconnected && 'gamepad', Ls.resize && 'resize'].filter(Boolean).join(', ') || 'nothing'}`,
    'Players need to see the goal, their progress and how to play, on a phone too. Use createHud() from @gcp/craft.js for counters, bars, a timer, hints, a title and an end screen; createInput() from @gcp/input.js for keyboard, pointer and an on-screen stick; and report loading with GCP.progress or run() from @gcp/core.js.');

  // 7. proof: the rules were actually played
  const pt = m.playthrough;
  add('proof', 'Proven playable to the end', 10, (pt && pt.ok ? 0.5 + 0.3 * ramp(pt.steps.length, 1, 5) : 0) + 0.2 * (m.warnings ? 0 : 1),
    `${pt && pt.ok ? `play-through of ${pt.steps.length} steps passed` : 'no play-through registered'}; ${m.warnings || 0} console warnings`,
    'Nothing has played the rules through. Register GCP.test.onPlaythrough with five or more steps (score, win or lose, the end screen, restart); see the platform-contract guide.');

  const score = dims.reduce((a, d) => a + d.score, 0);
  const level = score >= 80 ? 'rich' : score >= 62 ? 'solid' : score >= 42 ? 'basic' : 'bare';
  const weakest = dims.filter((d) => d.fix).sort((a, b) => (b.max - b.score) - (a.max - a.score)).slice(0, 3);
  return {
    score, level, dimensions: dims,
    summary: `Craft ${score}/100 (${level}). ${weakest.length ? `Weakest: ${weakest.map((d) => `${d.label.toLowerCase()} ${d.score}/${d.max}`).join(', ')}.` : 'Nothing stands out as weak.'}`,
    next: weakest.map((d) => `${d.label} (${d.score}/${d.max}; measured: ${d.measured}). ${d.fix}`),
  };
}
