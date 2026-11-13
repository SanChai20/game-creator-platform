// @gcp/craft.js · fx — the small reactions that make actions feel good: bursts of particles, rings, floating
// numbers, a punch of scale, a flash. One pooled draw call for all particles; everything updates itself on the stage.
//   const fx = createFx();   fx.sparkle(coin.position, 0xffd84a);   fx.floatText(coin.position, '+1');   fx.pop(chest);
import * as THREE from 'three';
import { currentStage } from './stage.js';

const V = (p) => (p && p.isObject3D ? p.position : p);
/**
 * Options: stage, max (particle pool size). Positions may be a Vector3, an { x, y, z } or an Object3D.
 *   fx.burst(pos, { count, color | colors, speed, up, spread, size, life, gravity, glow, drag })   the general one
 *   fx.sparkle(pos, color)   fx.puff(pos, color)   fx.explosion(pos)   fx.splash(pos)   fx.leaves(pos, color)
 *   fx.smoke(pos)            fx.confetti(pos)      fx.ring(pos, color, radius)
 *   fx.floatText(pos, text, { color, size })       text that rises from a point in the world and fades
 *   fx.pop(object, amount)   a quick squash-and-stretch on any object
 *   fx.emitter(pos, opts)    keeps emitting (chimney smoke, a fountain, a magic aura); returns { stop() }
 */
export function createFx(opts = {}) {
  const st = opts.stage || currentStage(), N = opts.max || (st.quality === 'low' ? 500 : 1500);
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 4), siz = new Float32Array(N), vel = new Float32Array(N * 3), life = new Float32Array(N), max = new Float32Array(N), grav = new Float32Array(N), drag = new Float32Array(N), base = new Float32Array(N * 2);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 4)); geo.setAttribute('psize', new THREE.BufferAttribute(siz, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, uniforms: { scale: { value: 300 } },
    vertexShader: 'attribute vec4 pcolor; attribute float psize; uniform float scale; varying vec4 vC; void main(){ vC = pcolor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = psize * scale / max(-mv.z, 0.3); }',
    // alpha > 1 marks a glowing (additive) particle: colour is added and nothing is covered
    fragmentShader: 'varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.15, d); float glow = step(1.5, vC.a); float al = a * (vC.a - glow * 2.0); gl_FragColor = vec4(vC.rgb * al, al * (1.0 - glow)); if (al < 0.01) discard; }',
  });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 6; st.scene.add(points);
  let head = 0; const c = new THREE.Color(), rings = [], texts = [], pops = [], emitters = [], tmp = new THREE.Vector3();
  const layer = document.createElement('div'); layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:35;overflow:hidden'; document.body.appendChild(layer);
  const fx = {
    points,
    burst(p, o = {}) {
      p = V(p); const { count = 14, speed = 3, up = 2, spread = 1, size = 0.25, life: L = 0.7, gravity = 6, glow = true, drag: dr = 1.2 } = o, colors = o.colors || [o.color ?? 0xffe08a];
      for (let i = 0; i < count; i++) {
        const k = head; head = (head + 1) % N; const a = Math.random() * 6.283, e = Math.acos(1 - Math.random() * 2 * Math.min(1, spread)) , sp = speed * (0.4 + Math.random() * 0.8);
        pos[k * 3] = p.x + (Math.random() - 0.5) * 0.2 * spread; pos[k * 3 + 1] = p.y + (o.y ?? 0.4); pos[k * 3 + 2] = p.z + (Math.random() - 0.5) * 0.2 * spread;
        vel[k * 3] = Math.cos(a) * Math.sin(e) * sp; vel[k * 3 + 1] = Math.cos(e) * sp * 0.6 + up; vel[k * 3 + 2] = Math.sin(a) * Math.sin(e) * sp;
        c.set(colors[(Math.random() * colors.length) | 0]); col[k * 4] = c.r; col[k * 4 + 1] = c.g; col[k * 4 + 2] = c.b; base[k * 2] = glow ? 3 : 1; base[k * 2 + 1] = size * (0.6 + Math.random() * 0.8);
        life[k] = max[k] = L * (0.6 + Math.random() * 0.8); grav[k] = gravity; drag[k] = dr;
      }
      return fx;
    },
    sparkle: (p, color = 0xffe08a) => fx.burst(p, { count: 16, color, speed: 2.6, up: 2.4, size: 0.2, life: 0.6, gravity: 5 }),
    puff: (p, color = 0xd8ccb8) => fx.burst(p, { count: 9, color, speed: 1.2, up: 0.6, size: 0.6, life: 0.7, gravity: -0.4, glow: false, drag: 3, y: 0.1 }),
    explosion: (p) => { fx.burst(p, { count: 40, colors: [0xffe08a, 0xff9a30, 0xff5a20], speed: 8, up: 3, size: 0.5, life: 0.7, gravity: 4, drag: 2.5 }); fx.burst(p, { count: 14, color: 0x3a3632, speed: 2.5, up: 2, size: 1.3, life: 1.4, gravity: -1, glow: false, drag: 2 }); fx.ring(p, 0xffc060, 5); st.shake(0.6); return fx; },
    splash: (p) => fx.burst(p, { count: 22, colors: [0xcfeaff, 0x8fc8f0, 0xffffff], speed: 3.2, up: 4, spread: 0.5, size: 0.22, life: 0.8, gravity: 12, glow: false, y: 0.05 }),
    leaves: (p, color = 0x6ab04a) => fx.burst(p, { count: 12, colors: [color, 0x8ac85a, 0xc8a040], speed: 2, up: 2, size: 0.26, life: 1.2, gravity: 3, glow: false, drag: 2, y: 1.5 }),
    smoke: (p) => fx.burst(p, { count: 6, colors: [0x8a8680, 0x6a6660], speed: 0.5, up: 1.2, size: 0.9, life: 2, gravity: -0.6, glow: false, drag: 1, spread: 0.3 }),
    confetti: (p) => fx.burst(p, { count: 60, colors: [0xff5a5a, 0xffd84a, 0x5ad06a, 0x5aa8ff, 0xc878ff], speed: 6, up: 6, spread: 0.6, size: 0.24, life: 1.8, gravity: 7, glow: false, drag: 1.5 }),
    ring(p, color = 0xffffff, radius = 3, seconds = 0.5) { p = V(p); const m = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })); m.position.set(p.x, p.y + 0.12, p.z); st.scene.add(m); rings.push({ m, t: 0, d: seconds, r: radius }); return fx; },
    floatText(p, text, { color = '#fff', size = 22, seconds = 1.1, rise = 1.4 } = {}) { p = V(p); const e = document.createElement('div'); e.textContent = text; e.style.cssText = `position:absolute;left:0;top:0;font:800 ${size}px system-ui,sans-serif;color:${color};text-shadow:0 2px 6px rgba(0,0,0,.7);will-change:transform;white-space:nowrap`; layer.appendChild(e); texts.push({ e, x: p.x, y: p.y + 1.2, z: p.z, t: 0, d: seconds, rise }); return fx; },
    pop(obj, amount = 0.35, seconds = 0.3) { if (!obj.userData._s) obj.userData._s = obj.scale.clone(); pops.push({ obj, t: 0, d: seconds, a: amount }); return fx; },
    emitter(p, o = {}) { const em = { p, o: { count: 1, ...o }, rate: o.rate ?? 8, acc: 0, on: true, stop() { em.on = false; } }; emitters.push(em); return em; },
    update(dt) {
      mat.uniforms.scale.value = st.renderer.domElement.height * 0.9;
      for (let k = 0; k < N; k++) { if (life[k] <= 0) continue; life[k] -= dt; if (life[k] <= 0) { siz[k] = 0; col[k * 4 + 3] = 0; continue; } const d = Math.exp(-drag[k] * dt); vel[k * 3] *= d; vel[k * 3 + 2] *= d; vel[k * 3 + 1] = vel[k * 3 + 1] * d - grav[k] * dt; pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt; const u = life[k] / max[k]; col[k * 4 + 3] = (base[k * 2] > 2 ? 2 : 0) + Math.min(1, u * 2.2) * 0.95; siz[k] = base[k * 2 + 1] * (base[k * 2] > 2 ? 0.5 + u * 0.5 : 1.6 - u * 0.6); }
      geo.attributes.position.needsUpdate = geo.attributes.pcolor.needsUpdate = geo.attributes.psize.needsUpdate = true;
      for (let i = rings.length - 1; i >= 0; i--) { const r = rings[i]; r.t += dt; const u = r.t / r.d; if (u >= 1) { st.scene.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); rings.splice(i, 1); } else { r.m.scale.setScalar(0.2 + u * r.r); r.m.material.opacity = 1 - u; } }
      const w = innerWidth, h = innerHeight;
      for (let i = texts.length - 1; i >= 0; i--) { const t = texts[i]; t.t += dt; const u = t.t / t.d; if (u >= 1) { t.e.remove(); texts.splice(i, 1); continue; } tmp.set(t.x, t.y + u * t.rise, t.z).project(st.camera); t.e.style.opacity = tmp.z > 1 ? '0' : String(Math.min(1, (1 - u) * 2)); t.e.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * w}px,${(-tmp.y * 0.5 + 0.5) * h}px) translate(-50%,-50%) scale(${1 + Math.sin(Math.min(1, u * 4) * Math.PI) * 0.3})`; }
      for (let i = pops.length - 1; i >= 0; i--) { const p = pops[i]; p.t += dt; const u = p.t / p.d, s0 = p.obj.userData._s; if (u >= 1) { p.obj.scale.copy(s0); pops.splice(i, 1); } else { const k = Math.sin(u * Math.PI) * p.a * (1 - u * 0.5); p.obj.scale.set(s0.x * (1 + k), s0.y * (1 - k * 0.6), s0.z * (1 + k)); } }
      for (let i = emitters.length - 1; i >= 0; i--) { const e = emitters[i]; if (!e.on) { emitters.splice(i, 1); continue; } e.acc += dt * e.rate; while (e.acc >= 1) { e.acc -= 1; fx.burst(e.p, e.o); } }
    },
    remove() { st.scene.remove(points); layer.remove(); if (off) off(); },
  };
  const off = st.onUpdate((dt) => fx.update(dt));
  return fx;
}
