// The Vault: the home page's exhibition hall, a real-time three.js scene built from the platform's own procedural
// materials kit (@gcp/materials.js, the same one games use). A dark gallery with a marble floor, plum plaster walls and
// a wood and brass wainscot; every game stands on a black-marble plinth with brass trim, a velvet top and an engraved plaque,
// inside a glass case, as a floating collectible card lit by a moving spotlight with dust in the beam.
//
// This file is bundled by Vite into its own chunk and only loaded on capable devices (see Vault.tsx). Everything the
// page needs to read stays in the DOM; the scene is the picture behind it.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clearMaterials, glowingMaterial, labelMaterial, material, parts, plane } from '../../public/kits/v1/materials.js';

const S = 2.3;                       // metres between exhibits
const CARD = [0.44, 0.62, 0.012];    // a collectible card: width, height, thickness
const CARD_Y = 1.42;
const INK = 0x0a0910;
const FONT_D = '"Space Grotesk", "Inter", system-ui, sans-serif', FONT_M = '"JetBrains Mono", ui-monospace, monospace';
const nextTick = () => new Promise((r) => setTimeout(r, 0));
const ease = (k) => 1 - Math.pow(1 - k, 3);

/**
 * Builds the hall into a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {{ exhibits: Exhibit[], tier: 'full'|'lite'|'still', start?: number, onProgress?: (p:number)=>void,
 *   onFocus?: (i:number)=>void, onOpen?: (i:number)=>void, onFail?: ()=>void }} o
 */
export async function createHall(canvas, o) {
  const { exhibits, tier } = o, full = tier === 'full', still = tier === 'still';
  const progress = (p) => o.onProgress && o.onProgress(p);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: full, alpha: false, powerPreference: full ? 'high-performance' : 'low-power' });
  let dpr = Math.min(devicePixelRatio || 1, full ? 1.5 : 1.25);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = full; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(INK, 1);
  let dead = false, dirty = true;
  const lost = (e) => { e.preventDefault(); dead = true; stop(); o.onFail && o.onFail(); };
  canvas.addEventListener('webglcontextlost', lost);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(INK);
  scene.fog = new THREE.Fog(INK, 5.5, 15);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture; scene.environmentIntensity = 0.22;
  pmrem.dispose();
  progress(0.08); await nextTick();

  // ---- materials, baked on this renderer's GPU by the kit ---------------------------------------------------------
  const mo = { renderer, size: full ? 512 : 256 };
  const M = {};
  const recipes = {
    floor: [{ base: 'marble', color: 0x2c2832, color2: 0x8d8597, seed: 7 }, { scale: 1.6 }],
    wall: [{ name: 'plaster', color: 0x221c2a, seed: 3 }, { scale: 1.2 }],
    stone: [{ base: 'marble', color: 0x121016, color2: 0xb59255, seed: 11 }, {}],
    brass: ['brass', {}],
    velvet: [{ name: 'fabric', color: 0x3a1238 }, {}],
    wood: ['wood_dark', {}],
  };
  const keys = Object.keys(recipes);
  for (let i = 0; i < keys.length; i++) {
    const [r, x] = recipes[keys[i]];
    M[keys[i]] = material(r, { ...mo, ...x });
    progress(0.1 + 0.45 * (i + 1) / keys.length); await nextTick();
    if (dead) return null;
  }
  try { await document.fonts.ready; } catch { /* labels fall back to system fonts */ }

  // ---- the room --------------------------------------------------------------------------------------------------
  const n = exhibits.length, span = Math.max(0, (n - 1) * S), W = span + 26, cx = span / 2;
  const disposables = [];
  const mesh = (geo, mat, pos, rot) => { const m = new THREE.Mesh(geo, mat); if (pos) m.position.set(...pos); if (rot) m.rotation.set(...rot); disposables.push(geo); scene.add(m); return m; };
  const floor = mesh(plane(W, 14), M.floor, [cx, 0, 2], [-Math.PI / 2, 0, 0]); floor.receiveShadow = true;
  mesh(plane(W, 5), M.wall, [cx, 2.5, -1.9]).receiveShadow = true;
  const room = parts({ material: mo });
  room.box(M.wood, [W, 1.0, 0.06], [cx, 0.5, -1.87], { bevel: 0.006 });              // wainscot
  room.box(M.brass, [W, 0.03, 0.08], [cx, 1.015, -1.86], { bevel: 0.004 });           // its brass rail
  room.box(M.brass, [W, 0.05, 0.04], [cx, 0.025, -1.84], { bevel: 0.004 });          // skirting
  const roomG = room.group('room'); scene.add(roomG);
  progress(0.62); await nextTick();

  // ---- one plinth, glass case and ceiling lamp, shared by every exhibit ------------------------------------------
  const Y0 = 0.93, CH = 0.92, HW = 0.4;
  const pl = parts({ material: mo });
  pl.box(M.stone, [0.84, 0.88, 0.84], [0, 0.46, 0], { bevel: 0.014 });
  pl.box(M.brass, [0.9, 0.05, 0.9], [0, 0.025, 0], { bevel: 0.006 });
  pl.box(M.brass, [0.88, 0.035, 0.88], [0, 0.9, 0], { bevel: 0.006 });
  pl.box(M.velvet, [0.8, 0.025, 0.8], [0, 0.93, 0], { bevel: 0.008 });
  for (const sx of [-1, 1]) pl.box(M.brass, [0.022, CH, 0.022], [sx * HW, Y0 + CH / 2, -HW], { bevel: 0.004 });   // back posts only: nothing stands in front of the card
  pl.box(M.brass, [0.83, 0.03, 0.83], [0, Y0 + CH + 0.015, 0], { bevel: 0.006 });
  pl.box(M.brass, [0.48, 0.14, 0.012], [0, 0.6, 0.426], { bevel: 0.004 });          // plaque
  const plinthKind = pl.build('plinth');
  const lamp = parts({ material: mo });
  lamp.cylinder('plastic_black', 0.07, 0.16, [0, 0, 0], { r2: 0.05 });
  lamp.bar(M.brass, [0, 0.16, 0], [0, 0.8, 0], 0.008);
  const lampKind = lamp.build('lamp');
  const lampGlow = glowingMaterial(0xfff1d6, 5);
  const lampDisc = new THREE.CircleGeometry(0.06, 20); disposables.push(lampDisc);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.08, envMapIntensity: 7, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false });
  const glassGeo = new THREE.BoxGeometry(HW * 2 - 0.01, CH - 0.01, HW * 2 - 0.01);
  const coneGeo = new THREE.CylinderGeometry(0.06, 0.62, 2.35, 32, 1, true); coneGeo.translate(0, -2.35 / 2, 0);
  const coneMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { uK: { value: 0.0 }, uC: { value: new THREE.Color(0xfff0d8) } },
    vertexShader: 'varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = uv.y; vec4 w = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-w.xyz); gl_Position = projectionMatrix * w; }',
    fragmentShader: 'uniform float uK; uniform vec3 uC; varying float vY; varying vec3 vN; varying vec3 vV; void main(){ float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6); float a = edge * smoothstep(0., .9, vY) * uK; gl_FragColor = vec4(uC * a, a); }',
  });
  const ringGeo = new THREE.RingGeometry(0.13, 0.19, 48); ringGeo.rotateX(-Math.PI / 2);
  const hitGeo = new THREE.BoxGeometry(0.95, 1.95, 0.95); hitGeo.translate(0, 0.97, 0);
  const cardGeo = new THREE.BoxGeometry(...CARD);
  disposables.push(glass, glassGeo, coneGeo, coneMat, ringGeo, hitGeo, cardGeo);

  // ---- the exhibits ----------------------------------------------------------------------------------------------
  const items = [];
  const backTex = cardBack(); disposables.push(backTex);
  for (let i = 0; i < n; i++) {
    const e = exhibits[i], x = i * S, g = new THREE.Group(); g.position.set(x, 0, 0); scene.add(g);
    const pg = toGroupShared(plinthKind, full); g.add(pg);
    const plaqueM = labelMaterial(`No. ${String(i + 1).padStart(2, '0')}  ·  ${e.title.toUpperCase().slice(0, 26)}`, { color: '#2a1c06', font: `600 46px ${FONT_M}`, worn: 0.12, padding: 14 });
    const ph = Math.min(0.055, 0.42 / plaqueM.userData.aspect), plq = new THREE.Mesh(new THREE.PlaneGeometry(ph * plaqueM.userData.aspect, ph), plaqueM);
    plq.position.set(0, 0.6, 0.4335); g.add(plq); disposables.push(plq.geometry);
    const gl = new THREE.Mesh(glassGeo, glass); gl.position.y = Y0 + CH / 2; gl.renderOrder = 2; g.add(gl);
    const lg = toGroupShared(lampKind, false); lg.position.set(0, 3.55, 0.25); g.add(lg);
    const ld = new THREE.Mesh(lampDisc, lampGlow); ld.rotation.x = Math.PI / 2; ld.position.set(0, 3.548, 0.25); g.add(ld);
    const cone = new THREE.Mesh(coneGeo, coneMat.clone()); cone.position.set(0, 3.5, 0.2); cone.rotation.x = -0.08; cone.renderOrder = 3; g.add(cone); disposables.push(cone.material);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(e.color).multiplyScalar(1.6), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    ring.position.y = 0.946; g.add(ring); disposables.push(ring.material);
    const wallNo = labelMaterial(String(i + 1).padStart(2, '0'), { color: '#c9a55a', font: `700 150px ${FONT_D}`, worn: 0, padding: 8 });
    const wn = new THREE.Mesh(new THREE.PlaneGeometry(0.42 * wallNo.userData.aspect, 0.42), wallNo.clone()); wn.material.opacity = 0.1; wn.position.set(0, 2.45, -1.88); g.add(wn); disposables.push(wn.geometry, wn.material);
    const face = cardFace(e, i), front = new THREE.MeshPhysicalMaterial({ map: face.tex, roughness: 0.32, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.06, iridescence: e.foil, iridescenceIOR: 1.35, emissive: 0xffffff, emissiveMap: face.tex, emissiveIntensity: 0.16 });
    const back = new THREE.MeshPhysicalMaterial({ map: backTex, color: new THREE.Color(e.color).lerp(new THREE.Color(0xffffff), 0.35), roughness: 0.26, metalness: 0.85, iridescence: 1, iridescenceIOR: 1.8, iridescenceThicknessMinimum: 180, iridescenceThicknessMaximum: 820 });
    const edge = new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.3, metalness: 1, emissive: e.color, emissiveIntensity: 0.35 });
    const card = new THREE.Mesh(cardGeo, [edge, edge, edge, edge, front, back]); card.castShadow = full;
    const holder = new THREE.Group(); holder.position.set(0, CARD_Y, 0); holder.add(card); g.add(holder);
    const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial()); hit.visible = false; hit.userData.index = i; g.add(hit);
    disposables.push(face.tex, front, back, edge, hit.material);
    items.push({ g, card, holder, cone, ring, hit, face, flip: 0, k: 0 });
    face.ready.then(() => { dirty = true; });
    progress(0.62 + 0.3 * (i + 1) / n);
    if (i % 3 === 2) { await nextTick(); if (dead) return null; }
  }

  // ---- light -----------------------------------------------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x4a4060, 0x0a0910, 0.55));
  const key = new THREE.SpotLight(0xfff0dc, 22, 9, 0.36, 0.6, 1.6);
  key.position.set(0, 3.55, 0.6); key.target.position.set(0, 1.1, 0); scene.add(key, key.target);
  if (full) { key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; key.shadow.radius = 4; key.shadow.camera.near = 0.5; key.shadow.camera.far = 6; }
  const rim = new THREE.PointLight(0xffffff, 2.2, 2.6, 1.5); rim.position.set(0, 1.5, -0.55); scene.add(rim);
  const wash = new THREE.SpotLight(0xb9a6ff, 9, 10, 0.7, 0.9, 1.4); wash.position.set(0, 3.4, 2.6); wash.target.position.set(0, 1.4, -1.9); scene.add(wash, wash.target);

  // ---- dust in the beams -----------------------------------------------------------------------------------------
  const DUST = full ? 900 : 360, dp = new Float32Array(DUST * 3), dr = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) { dp[i * 3] = -4 + Math.random() * (span + 8); dp[i * 3 + 1] = 0.3 + Math.random() * 3.2; dp[i * 3 + 2] = -1.4 + Math.random() * 3.2; dr[i] = Math.random(); }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3)); dustGeo.setAttribute('aR', new THREE.BufferAttribute(dr, 1));
  const dustMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uT: { value: 0 }, uF: { value: 0 }, uPx: { value: dpr } },
    vertexShader: `uniform float uT; uniform float uF; uniform float uPx; attribute float aR; varying float vA;
      void main(){ vec3 p = position; float t = uT * (0.03 + aR * 0.05);
        p.y = 0.3 + mod(p.y - 0.3 + t * (aR - 0.35), 3.2); p.x += sin(uT * 0.21 + aR * 40.) * 0.08; p.z += cos(uT * 0.17 + aR * 31.) * 0.08;
        float lx = p.x - uF; float r = 0.06 + (3.5 - p.y) * 0.24; float inBeam = 1. - smoothstep(r * 0.55, r, length(vec2(lx, p.z - 0.2)));
        vA = (0.05 + inBeam * 0.9) * (0.4 + 0.6 * fract(aR * 13.7)) * (0.6 + 0.4 * sin(uT * (1. + aR * 2.) + aR * 9.));
        vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv; gl_PointSize = uPx * (1.2 + aR * 2.4) * (3.2 / -mv.z); }`,
    fragmentShader: 'varying float vA; void main(){ vec2 c = gl_PointCoord - .5; float d = smoothstep(.5, 0., length(c)); gl_FragColor = vec4(vec3(1., .94, .82) * d * vA, d * vA); }',
  });
  const dust = new THREE.Points(dustGeo, dustMat); dust.frustumCulled = false; scene.add(dust); disposables.push(dustGeo, dustMat);

  // ---- camera, post-processing ------------------------------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  let composer = null, bloom = null;
  if (full) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 0.95); composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }
  let narrow = false;
  function resize() {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    narrow = w / h < 1.05;
    camera.aspect = w / h; camera.fov = narrow ? 44 : 30;
    // wide screens: shift the frame so the focused case stands right of centre, clear of the page's text
    if (narrow) camera.clearViewOffset(); else camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
    if (composer) { composer.setPixelRatio(dpr); composer.setSize(w, h); }
    dustMat.uniforms.uPx.value = dpr * (h / 700);
    dirty = true; if (still) draw(performance.now());
  }
  const ro = new ResizeObserver(() => resize());

  // ---- state and animation ----------------------------------------------------------------------------------------
  let focus = Math.max(0, Math.min(n - 1, o.start || 0)), camX = focus * S, drag = 0, focusAt = -1e9;
  const ptr = { x: 0, y: 0, sx: 0, sy: 0, over: false };
  const t0 = performance.now();
  function setFocus(i, fromUser = true) {
    i = Math.max(0, Math.min(n - 1, i));
    if (i !== focus) { focus = i; focusAt = performance.now(); if (!still) items[i].flip = 1; o.onFocus && o.onFocus(i); }
    else if (fromUser && !still) items[i].flip = Math.max(items[i].flip, 0.0001);
    dirty = true; if (still) { camX = focus * S; draw(performance.now()); }
  }
  let prevNow = performance.now();
  function draw(now) {
    const t = (now - t0) / 1000;
    // easing per second, not per frame, so 30 and 60 fps (and a slow device) move at the same pace
    const dt = Math.min(0.1, Math.max(0, (now - prevNow) / 1000)); prevNow = now;
    const k = (r) => (still ? 1 : 1 - Math.pow(1 - r, dt * 60));
    const target = focus * S + drag;
    camX += (target - camX) * k(0.075);
    ptr.sx += (ptr.x - ptr.sx) * k(0.06); ptr.sy += (ptr.y - ptr.sy) * k(0.06);
    // Wide screens: the camera stands left of the exhibit and looks along the hall, so the next cases recede to the
    // right into the dark and the page's text has the left side. Narrow screens: straight on, centred.
    const px = ptr.sx * 0.18, py = ptr.sy * 0.08;
    if (narrow) { camera.position.set(camX + px, 1.7 + py, 4.3); camera.lookAt(camX, 1.22, 0); }
    else { camera.position.set(camX - 2.5 + px, 1.74 + py, 3.9); camera.lookAt(camX + 0.7, 1.16, -0.25); }
    const fx = Math.max(0, Math.min(span, camX));
    key.position.x += (focus * S - key.position.x) * k(0.1); key.target.position.x = key.position.x; key.target.updateMatrixWorld();
    rim.position.x = key.position.x; rim.color.set(exhibits[focus].color);
    wash.position.x = fx; wash.target.position.x = fx; wash.target.updateMatrixWorld();
    for (let i = 0; i < n; i++) {
      const it = items[i], on = i === focus;
      it.k += ((on ? 1 : 0) - it.k) * k(0.08);
      const bob = still ? 0 : Math.sin(t * 1.3 + i * 1.7) * 0.018;
      it.holder.position.y = CARD_Y + bob + it.k * 0.02;
      // cards turn toward the visitor, the focused one fully
      const face = Math.atan2(camera.position.x - i * S, camera.position.z) * (0.45 + it.k * 0.55);
      let ry = face + (still ? 0 : Math.sin(t * 0.55 + i) * (on ? 0.12 : 0.08));
      if (on) ry += ptr.sx * 0.35;
      if (it.flip > 0) { it.flip = Math.max(0, it.flip - dt / 0.9); ry += (1 - ease(1 - it.flip)) * Math.PI * 2; }  // one turn on arrival
      it.holder.rotation.y = ry; it.holder.rotation.x = on ? -ptr.sy * 0.12 : 0;
      it.holder.scale.setScalar(1 + it.k * 0.06);
      it.cone.material.uniforms.uK.value = 0.035 + it.k * 0.11;
      it.ring.material.opacity = 0.25 + it.k * 0.55 + (still ? 0 : Math.sin(t * 2 + i) * 0.08);
    }
    dustMat.uniforms.uT.value = still ? 40 : t; dustMat.uniforms.uF.value = key.position.x;
    if (composer) composer.render(); else renderer.render(scene, camera);
    dirty = false;
  }

  // ---- render loop: capped, paused when hidden or scrolled away, measured ---------------------------------------
  let raf = 0, active = false, last = 0, frames = 0, winStart = 0, slow = 0;
  const stats = { fps: 0, ms: 0, dpr, bloom: !!bloom, tier };
  let step = 1000 / (full ? 60 : 30) - 2;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (now - last < step) return;
    if (now - last > 500) { winStart = 0; frames = 0; }
    last = now;
    const c0 = performance.now(); draw(now); stats.ms = Math.round((performance.now() - c0) * 100) / 100;
    frames++; if (!winStart) winStart = now; else if (now - winStart > 2000) {
      const span2 = (now - winStart) / frames; stats.fps = Math.round(1000 / span2); winStart = now; frames = 0;
      if (span2 > step * 1.7 && !o.forced) degrade();
    }
  }
  function degrade() {
    slow++;
    if (slow === 1 && dpr > 1) { dpr = 1; stats.dpr = 1; resize(); }
    else if (bloom) { composer.dispose(); composer = null; bloom = null; stats.bloom = false; key.castShadow = false; renderer.shadowMap.enabled = false; }
    else step = 1000 / 20 - 2;     // last resort: a calmer frame rate
  }
  function start() { if (active || still || dead || document.hidden) return; active = true; last = 0; raf = requestAnimationFrame(tick); }
  function stop() { active = false; cancelAnimationFrame(raf); }
  const vis = () => { if (document.hidden) stop(); else if (want) start(); };
  let want = true;
  document.addEventListener('visibilitychange', vis);

  // ---- input: drag or swipe along the hall, click a case, pointer tilts the card ---------------------------------
  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  const hits = items.map((it) => it.hit);
  const pick = (ev) => {
    const r = canvas.getBoundingClientRect(); v2.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, camera); const h = ray.intersectObjects(hits, false)[0]; return h ? h.object.userData.index : -1;
  };
  let down = null;
  const onDown = (ev) => { if (ev.button !== 0) return; down = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, moved: false }; };
  const onMove = (ev) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1; ptr.y = -(((ev.clientY - r.top) / r.height) * 2 - 1);
    if (down && down.id === ev.pointerId) {
      const dx = ev.clientX - down.x;
      if (!down.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(ev.clientY - down.y)) { down.moved = true; try { canvas.setPointerCapture(ev.pointerId); } catch { /* fine */ } }
      if (down.moved) { drag = -dx / r.width * S * 2.4; dirty = true; if (still) draw(performance.now()); }
    } else if (ev.pointerType === 'mouse') canvas.style.cursor = pick(ev) >= 0 ? 'pointer' : 'grab';
  };
  const onUp = (ev) => {
    if (!down || down.id !== ev.pointerId) return;
    const d = down; down = null;
    if (d.moved) { const to = Math.round((focus * S + drag) / S); camX = focus * S + drag; drag = 0; setFocus(to); return; }
    const i = pick(ev);
    if (i < 0) return;
    if (i === focus) o.onOpen && o.onOpen(i); else setFocus(i);
  };
  const onLeave = () => { ptr.x = 0; ptr.y = 0; if (down && !down.moved) down = null; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => { if (down?.moved) { drag = 0; dirty = true; } down = null; });
  canvas.addEventListener('pointerleave', onLeave);

  ro.observe(canvas); resize();
  progress(1);
  if (still) draw(performance.now()); else start();
  // the first frame compiles every shader; let it land before saying we are ready
  await new Promise((r) => requestAnimationFrame(() => r()));

  return {
    stats,
    get focus() { return focus; },
    focusOn: (i) => setFocus(i),
    next: () => setFocus(focus + 1),
    prev: () => setFocus(focus - 1),
    /** Rendering on or off (the hall scrolled out of view). */
    setActive(on) { want = on; if (on) start(); else stop(); },
    dispose() {
      stop(); dead = true; ro.disconnect(); document.removeEventListener('visibilitychange', vis);
      canvas.removeEventListener('webglcontextlost', lost);
      for (const d of disposables) d.dispose && d.dispose();
      composer && composer.dispose(); envRT.dispose(); clearMaterials();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
}

// A kind from parts() as a group whose meshes share the kind's geometry (built once, placed many times).
function toGroupShared(kind, shadows) {
  const g = new THREE.Group();
  for (const p of kind.parts) { const m = new THREE.Mesh(p.geometry, p.material); m.castShadow = shadows && p.shadow !== false; m.receiveShadow = shadows; g.add(m); }
  return g;
}

// The front of a collectible card, painted on a canvas: rarity frame, number, cover, title, maker and stats.
function cardFace(e, i) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 722;
  const g = c.getContext('2d'), tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const paint = (img) => {
    const W = c.width, H = c.height;
    const fr = g.createLinearGradient(0, 0, W, H); fr.addColorStop(0, e.color); fr.addColorStop(0.5, shade(e.color, -0.45)); fr.addColorStop(1, e.color);
    g.fillStyle = fr; g.fillRect(0, 0, W, H);
    g.fillStyle = '#100e17'; round(g, 14, 14, W - 28, H - 28, 14); g.fill();
    // header
    g.fillStyle = e.color; g.font = `700 24px ${FONT_M}`; g.textBaseline = 'middle';
    g.fillText(`No. ${String(i + 1).padStart(2, '0')}`, 36, 50);
    const rt = e.rarityLabel.toUpperCase(); g.textAlign = 'right'; g.fillText(rt, W - 36, 50); g.textAlign = 'left';
    // picture
    const px = 30, py = 78, pw = W - 60, phh = Math.round(pw * 10 / 16);
    g.save(); round(g, px, py, pw, phh, 8); g.clip();
    if (img) { const s = Math.max(pw / img.width, phh / img.height), iw = img.width * s, ih = img.height * s; g.drawImage(img, px + (pw - iw) / 2, py + (phh - ih) / 2, iw, ih); }
    else { const a = g.createLinearGradient(px, py, px + pw, py + phh); a.addColorStop(0, e.art[0]); a.addColorStop(1, e.art[1]); g.fillStyle = a; g.fillRect(px, py, pw, phh); g.fillStyle = 'rgba(255,255,255,.92)'; g.font = `700 40px ${FONT_D}`; g.textAlign = 'center'; fit(g, e.title, pw - 40, 40, FONT_D); g.fillText(e.title, px + pw / 2, py + phh / 2); g.textAlign = 'left'; }
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 2; round(g, px, py, pw, phh, 8); g.stroke();
    // title and maker
    const ty = py + phh + 52;
    g.fillStyle = '#f2f0f7'; fit(g, e.title, pw, 40, FONT_D, 700); g.fillText(e.title, px, ty);
    g.fillStyle = '#a9a4b8'; g.font = `500 22px ${FONT_D}`; g.fillText(clipText(g, e.by, pw), px, ty + 42);
    // stats strip
    const sy = H - 92; g.fillStyle = 'rgba(255,255,255,.06)'; round(g, px, sy, pw, 56, 8); g.fill();
    g.font = `700 22px ${FONT_M}`; g.fillStyle = '#f2f0f7';
    const cols = [e.ratingLabel, e.playsLabel], cw = (pw - 130) / 2;
    cols.forEach((s, k) => g.fillText(clipText(g, s, cw - 10), px + 16 + k * cw, sy + 28));
    g.fillStyle = e.paid ? '#c6ff3d' : 'rgba(255,255,255,.12)'; round(g, px + pw - 120, sy + 10, 110, 36, 6); g.fill();
    g.fillStyle = e.paid ? '#0d1400' : '#f2f0f7'; g.textAlign = 'center'; g.fillText(clipText(g, e.priceLabel, 100), px + pw - 65, sy + 28); g.textAlign = 'left';
    // a faint foil grain over everything, stronger on rarer cards
    g.globalCompositeOperation = 'overlay'; g.globalAlpha = 0.08 + e.foil * 0.1;
    for (let k = -H; k < W; k += 22) { const s = g.createLinearGradient(k, 0, k + H, H); s.addColorStop(0, '#3fe0ff'); s.addColorStop(0.5, '#ff4fa3'); s.addColorStop(1, '#c6ff3d'); g.strokeStyle = s; g.lineWidth = 6; g.beginPath(); g.moveTo(k, 0); g.lineTo(k + H, H); g.stroke(); }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    tex.needsUpdate = true;
  };
  paint(null);
  const ready = new Promise((res) => {
    if (!e.cover) return res();
    const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
    img.onload = () => { try { paint(img); } catch { paint(null); } res(); };
    img.onerror = () => res();
    img.src = e.cover;
  });
  return { tex, ready };
}

// The back of every card: the platform's mark on a foil pattern (the material adds the iridescence).
function cardBack() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 360; const g = c.getContext('2d');
  g.fillStyle = '#8f8aa0'; g.fillRect(0, 0, 256, 360);
  for (let y = 0; y < 360; y += 12) for (let x = (y / 12) % 2 ? 6 : 0; x < 256; x += 12) { g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x, y, 6, 6); }
  g.strokeStyle = '#ffffff'; g.lineWidth = 6; round(g, 18, 18, 220, 324, 12); g.stroke();
  g.fillStyle = '#ffffff'; g.font = `700 64px ${FONT_D}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('GC', 128, 168);
  g.font = `700 16px ${FONT_M}`; g.fillText('THE VAULT', 128, 220);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.x = -1; t.offset.x = 1; return t;
}

function round(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function fit(g, text, w, size, family, weight = 700) { let s = size; do { g.font = `${weight} ${s}px ${family}`; s -= 2; } while (g.measureText(text).width > w && s > 18); }
function clipText(g, text, w) { if (g.measureText(text).width <= w) return text; let s = text; while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; }
function shade(hex, k) { const c = new THREE.Color(hex); return '#' + c.multiplyScalar(1 + k).getHexString(); }
