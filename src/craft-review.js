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
 *  edges   share of pixels where brightness steps sharply to the next pixel: crisp outlines and fine marks (a blurred or
 *          low-resolution picture has few)
 *  lum     mean brightness, 0..255
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
  let sharp = 0, lumSum = 0;
  for (let y = 0; y < h - 1; y++) { const row = y * w; for (let x = 0; x < w - 1; x++) { const v = L[row + x]; lumSum += v; if (Math.abs(L[row + x + 1] - v) > 24 || Math.abs(L[row + w + x] - v) > 24) sharp++; } }
  return { w, h, detail: detail / blocks, flat: flat / blocks, range: pct(0.95) - pct(0.05), hues, sat: satSum / (n / 4), edges: sharp / ((w - 1) * (h - 1)), lum: lumSum / ((w - 1) * (h - 1)) };
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
 * @param m  { stills: [imageMetrics…] (the full-quality portrait when there is one, else the game at rest and after
 *             input), portrait (bool), idleMotion, inputChange (bool), probe (window.__GCP.probe of the checked run),
 *             look (the probe's gl part from the portrait run, when there is one), ui: { texts, chars },
 *             playthrough: report.playthrough, warnings: n }
 * @returns { score, look, level, summary, dimensions: [{ id, label, score, max, measured, fix }], next: [string] }
 *
 * The weights and the "full marks from" values are calibrated on finished games: a hand-made open-world survival game
 * with a deferred renderer (ambient occlusion, bloom, cascaded shadows, 390k triangles a frame) earns 94% of the
 * picture points below; a scene of bare primitives earns under a third.
 */
export function craftReview(m) {
  const P = m.probe || {}, glRun = P.gl && P.gl.frames ? P.gl : null, gl = m.look && m.look.frames ? m.look : glRun, c2 = P.c2d && P.c2d.frames ? P.c2d : null;
  const stills = (m.stills || []).filter(Boolean), dims = [];
  const best = (k) => (stills.length ? Math.max(...stills.map((s) => s[k] || 0)) : 0), least = (k) => (stills.length ? Math.min(...stills.map((s) => s[k])) : 1);
  const VIEWS = m.portrait ? 'This is read from the portrait: the opening view, drawn once more at full quality as a device with a graphics card draws it. Only what is on screen there counts.'
    : 'This is read from the two pictures the check takes, the opening view and the view after its input, so only what is on screen there counts.';
  // A dimension is a weighted sum of parts: [weight, share 0..1, what to do when this part is short]. The advice a
  // creator gets is built from the parts that are actually short, largest loss first, so it names a number they can
  // move; `general` leads only when the whole dimension is weak.
  const add = (id, label, max, parts, measured, general) => {
    const share = clamp01(parts.reduce((a, p) => a + p[0] * clamp01(+p[1]), 0)), score = Math.round(max * share);
    const short = parts.filter((p) => clamp01(+p[1]) < 0.85 && p[2]).sort((a, b) => b[0] * (1 - clamp01(+b[1])) - a[0] * (1 - clamp01(+a[1]))).map((p) => p[2]);
    dims.push({ id, label, max, score, measured, fix: score >= max ? '' : [share < 0.5 ? general : '', ...short].filter(Boolean).join(' ') });
  };
  const is3d = !!gl;

  // 1. surfaces: do things have texture, small-scale shape and crisp edges, or are they flat or blurred fills?
  const detail = best('detail'), flat = least('flat'), edges = best('edges');
  const textures = gl ? Math.max(gl.textures, glRun ? glRun.textures : 0) : c2 ? c2.baked : 0;
  add('surfaces', 'Surfaces have detail', 22, [
    [0.45, ramp(detail, 0.15, 0.5), `Fine detail covers ${pctText(detail)} of the picture; full marks from 50%. ${VIEWS} ${is3d
      ? 'Open ground and large plain faces are what hold it down: cover the ground with grassField({ land }) and groundCover(), paint large faces with surface(kind, { relief: 2 }), and stand more shaped things (tree(), rock(), bush(), prop(kind)) close to the start, in front of the camera.'
      : 'Give tiles and sprites shading, outlines and small marks, and scatter ground details over open areas.'}`],
    [0.2, ramp(edges, 0.02, 0.055), `${(edges * 100).toFixed(1)}% of the pixels sit on a crisp edge; full marks from 5.5%. A soft or low-resolution picture scores low here. ${is3d
      ? 'Draw at the full pixel ratio when GCP.portrait is true (createStage does), keep shapes faceted or outlined, and avoid one stretched texture over a large area.'
      : 'Draw at the device pixel ratio and give sprites a darker outline.'}`],
    [0.2, ramp(textures, 0, 8), `${textures} ${is3d ? 'textures' : 'pre-painted sprites or tiles'} in use; full marks from 8. ${is3d ? 'surface(kind) paints one with nothing to download; list_blocks {group: "surfaces"} names every kind.' : 'bake() in @gcp/canvas2d.js paints one once on an off-screen canvas.'}`],
    [0.15, 1 - ramp(flat, 0.3, 0.7), `${pctText(flat)} of the picture is a single flat colour; full marks under 30%. ${is3d ? 'That is usually an empty sky or a bare floor: createStage({ mood }) paints a sky gradient with clouds or stars, and a faceted or textured ground removes the rest.' : 'Paint a background layer instead of one fill.'}`],
  ],
    `${pctText(detail)} of the picture has fine detail, ${(edges * 100).toFixed(1)}% of its pixels are crisp edges, ${pctText(flat)} is flat single colour; ${textures} ${is3d ? 'painted or loaded textures in use' : 'pre-painted sprites or tiles'}`,
    is3d ? 'Most faces are an untextured flat colour. Give the ground, bark, stone, wood and metal a painted texture with surface(kind) from @gcp/craft.js, and build props from several shaped parts instead of one primitive (tree(), rock(), bush(), grassField()).'
      : 'Large areas are flat fills. Paint tiles and sprites once on off-screen canvases (bake() in @gcp/canvas2d.js) with shading, outlines and small marks, and scatter ground details.');

  // 2. light and colour: tonal range, exposure, a palette with more than one family, and how much lighting work a frame gets
  const range = best('range'), hues = best('hues'), lum = best('lum'), passes = gl ? gl.maxPasses : 0;
  add('light', 'Light and colour', 22, [
    [is3d ? 0.3 : 0.45, ramp(range, 70, 165), `Tonal range is ${range} of 255; full marks from 165. The brightest and darkest parts of the picture are close together. ${is3d
      ? 'Widen it: a brighter mood or a stronger sun against deeper shadow, and in dark scenes things that give light (prop("lantern"), prop("campfire"), glowing pickups).'
      : 'Widen it: darken the edges, add a light gradient, and shade sprites from one light direction.'}`],
    [is3d ? 0.3 : 0, passes >= 1 ? 0.4 + 0.6 * ramp(passes, 1, 7) : 0, passes
      ? `${passes} lighting or effect pass${passes > 1 ? 'es' : ''} a frame; full marks from 7. Shadows alone are one. The finishing passes add the rest: ambient occlusion where things meet, bloom on bright things, a colour grade and edge smoothing (createStage does all of it by default on a graphics card; stage.enableFinish() for your own choices).`
      : 'No shadow or effect pass was drawn. createStage() adds a shadow pass and the finishing passes (ambient occlusion, bloom, colour grade) by itself; with your own renderer turn on renderer.shadowMap, one shadow-casting light and an EffectComposer.'],
    [is3d ? 0.15 : 0.2, ramp(lum, 35, 75), `Mean brightness is ${Math.round(lum)} of 255; full marks from 75. The picture is murky. Night and dusk scenes still need a readable middle: raise the ambient light or the exposure of the mood, or light the play area.`],
    [is3d ? 0.25 : 0.35, ramp(hues, 1, 3), `${hues} colour ${hues === 1 ? 'family' : 'families'} in the picture; full marks from 3. Give the things the player must notice (pickups, the hero, the goal) an accent colour that is not in the scenery.`],
  ],
    `tonal range ${range} of 255, mean brightness ${Math.round(lum)}, ${hues} colour ${hues === 1 ? 'family' : 'families'}${is3d ? `, ${passes ? `${passes} lighting or effect pass${passes > 1 ? 'es' : ''} a frame` : 'no shadow or effect pass'}` : ''}`,
    is3d ? 'The picture is tonally flat, murky or nearly one colour. Use createStage({ mood }) from @gcp/craft.js for a sky gradient, a warm sun against cool ambient light, matching fog, a shadow pass and the finishing passes.'
      : 'The picture is tonally flat, murky or nearly one colour.');

  // 3. world: how much is on screen
  if (is3d) {
    const tris = gl.sumTris / gl.frames, calls = gl.sumCalls / gl.frames, kinds = gl.kinds || Math.round(calls);
    add('world', 'The world is furnished', 18, [
      [0.45, logRamp(kinds, 6, 250), `${kinds} different shapes on screen; full marks from 250. This counts what is drawn in the frames of the check, so things far from the start or behind the camera do not count. Add more kinds and more of them: several species from tree(), rock(), bush(), groundCover() and prop(kind), placed with scatter() (it instances, so hundreds of copies stay cheap).`],
      [0.35, logRamp(tris, 5000, 300000), `${num(tris)} triangles a frame; full marks from 300k. A dense, shaped world has many: more scenery near the start, grassField({ land }), models built from several parts.`],
      [0.2, ramp(gl.programs, 3, 16), `${gl.programs} different materials; full marks from 16. Mix surfaces (wood, stone, metal, cloth), water() and things that glow.`],
    ],
      `${kinds} different shapes on screen, ${gl.programs} different materials, ${num(tris)} triangles in ${Math.round(calls)} draw calls a frame${gl.instanced ? ' (instancing in use)' : ''}`,
      'The scene is made of few kinds of things.');
  } else {
    const ops = c2 ? c2.sumOps / c2.frames : 0, images = c2 ? c2.sumImages / c2.frames : 0;
    add('world', 'The world is furnished', 18, [
      [0.6, logRamp(images, 4, 80), `${Math.round(images)} sprites drawn a frame; full marks from 80. Add scenery layers (ground marks, plants, stones, shadows under things) and more than one kind of each.`],
      [0.4, logRamp(ops, 20, 300), `${Math.round(ops)} drawing operations a frame; full marks from 300. Put something in the background and in the foreground.`],
    ],
      `${Math.round(images)} sprites and ${Math.round(ops)} drawing operations a frame`,
      'Little is drawn each frame.');
  }

  // 4. motion: is anything alive when the player does nothing, and does the picture answer input?
  const idle = m.idleMotion || 0;
  add('motion', 'The world moves', 8, [
    [0.6, ramp(idle, 0.004, 0.06), `${pctText(idle)} of the picture changes while nothing is pressed; full marks from 6%. ${is3d
      ? 'Add ambient motion: wind in foliage and grass (on by default in tree() and grassField()), moving water(), weather (createStage({ weather })), bobbing or spinning pickups, creatures that wander(), an idle animation on the character.'
      : 'Animate idle sprites, drift particles, sway plants, scroll a background layer.'}`],
    [0.4, m.inputChange ? 1 : 0, 'The picture did not change after keys and pointer input. Make the hero or the camera answer the first press.'],
  ],
    `${pctText(idle)} of the picture changes while nothing is pressed; the picture ${m.inputChange ? 'changes' : 'does not change'} after input`,
    'The scene is a still image until the player acts.');

  // 5. sound
  const au = P.audio || { contexts: 0, starts: 0 };
  add('sound', 'It has sound', 8, [
    [1, au.starts >= 1 ? 1 : au.contexts ? 0.7 : 0, au.contexts
      ? 'A sound system exists but nothing played during the check. Play a sound on the first key or pointer press and on the events of the play-through (sound.play("pickup"), sound.ambience("wind")).'
      : 'Silent games feel unfinished. createSound() from @gcp/craft.js gives ready effects with no files (sound.play("pickup"), "jump", "hit", "step", "win", "lose", "click") and looping ambience (sound.ambience("wind")). Start sound on the first key or pointer press; browsers block it before that.'],
  ],
    au.starts ? `${au.starts} sounds played during the check` : au.contexts ? 'a sound system exists, but nothing played when keys were pressed, the pointer clicked or the play-through ran' : 'no sound at all',
    '');

  // 6. interface: a HUD, loading feedback, and input on every kind of device
  const Ls = P.listeners || {}, ui = m.ui || { texts: 0, chars: 0 };
  const touch = !!(Ls.touchstart || Ls.pointerdown), keys = !!Ls.keydown;
  add('interface', 'Interface and input', 12, [
    [0.4, ramp(ui.texts, 0, 6), `${ui.texts} on-screen text elements; full marks from 6. Show the goal, the progress, the time and how to play: createHud() from @gcp/craft.js has counters, bars, a timer, hints, a title and an end screen.`],
    [0.25, touch ? 1 : 0, 'Nothing listens for touch or the pointer, so the game cannot be played on a phone. createInput() from @gcp/input.js adds an on-screen stick.'],
    [0.15, (P.progress || 0) >= 2 ? 1 : 0, 'Loading progress is not reported. Use run() from @gcp/core.js with boot.step(), or call GCP.progress(0..1) while loading.'],
    [0.1, keys ? 1 : 0, 'Nothing listens for the keyboard.'],
    [0.1, Ls.resize ? 1 : 0, 'Nothing listens for resize, so the picture will not follow the window.'],
  ],
    `${ui.texts} on-screen text elements; loading progress ${(P.progress || 0) >= 2 ? 'reported' : 'not reported'}; listens for ${[keys && 'keyboard', (Ls.pointerdown || Ls.mousedown) && 'pointer', Ls.touchstart && 'touch', Ls.gamepadconnected && 'gamepad', Ls.resize && 'resize'].filter(Boolean).join(', ') || 'nothing'}`,
    'Players need to see the goal, their progress and how to play, on a phone too.');

  // 7. proof: the rules were actually played
  const pt = m.playthrough, played = !!(pt && pt.ok);
  add('proof', 'Proven playable to the end', 10, [
    [0.5, played ? 1 : 0, 'Nothing has played the rules through. Register GCP.test.onPlaythrough with five or more steps (score, win or lose, the end screen, restart); see the platform-contract guide.'],
    [0.3, played ? ramp(pt.steps.length, 1, 5) : 0, played ? `The play-through has ${pt.steps.length} step${pt.steps.length === 1 ? '' : 's'}; full marks from 5. Add steps for the parts it skips (scoring, winning, losing, the end screen, restart).` : ''],
    [0.2, m.warnings ? 0 : 1, `${m.warnings || 0} console warnings during the run; the report lists them under warnings.`],
  ],
    `${played ? `play-through of ${pt.steps.length} steps passed` : 'no play-through registered'}; ${m.warnings || 0} console warnings`,
    '');

  const score = dims.reduce((a, d) => a + d.score, 0);
  // the picture alone, out of 100: surfaces, light, world and motion. This is the number to hold against a reference game.
  const LOOK = ['surfaces', 'light', 'world', 'motion'], lk = dims.filter((d) => LOOK.includes(d.id)), look = Math.round(100 * lk.reduce((a, d) => a + d.score, 0) / lk.reduce((a, d) => a + d.max, 0));
  const level = score >= 80 ? 'rich' : score >= 62 ? 'solid' : score >= 42 ? 'basic' : 'bare';
  // what to work on: every dimension that lost two points or more, largest loss first
  const weakest = dims.filter((d) => d.fix && d.max - d.score >= 2).sort((a, b) => (b.max - b.score) - (a.max - a.score)).slice(0, 3);
  return {
    score, look, level, dimensions: dims, portrait: !!m.portrait,
    summary: `Craft ${score}/100 (${level}); the picture alone ${look}/100. ${weakest.length ? `Weakest: ${weakest.map((d) => `${d.label.toLowerCase()} ${d.score}/${d.max}`).join(', ')}.` : 'Nothing stands out as weak.'}`,
    next: weakest.map((d) => `${d.label} (${d.score}/${d.max}). ${d.fix}`),
  };
}
