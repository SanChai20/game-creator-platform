# Animation without animation files

Motion made from maths is small, never fails to load, and adapts to anything the game does. Skeletal clips from glTF work too (`AnimationMixer`), so use those when a character needs them.

## Time

Everything starts with a clamped delta time. Without the clamp, a tab that was hidden for a minute comes back with one enormous step and the player falls through the floor.

```js
import { createLoop } from '@gcp/core.js';
createLoop({ update(dt, time) { /* dt is seconds, at most 0.1 */ }, render() {} }).start();
```

By hand: `const dt = Math.min(0.1, (now - last) / 1000)`. Multiply every speed by `dt`. For physics that must be stable or identical on every machine, step at a fixed rate (`createLoop({ fixedStep: 1 / 60, ... })`) and draw with the leftover fraction.

## Smoothing that ignores frame rate

`value += (target - value) * 0.1` runs faster at 144 Hz than at 30 Hz. This version does not:

```js
const damp = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
camera.position.x = damp(camera.position.x, player.x, 6, dt);
```

It is the single most useful line for cameras, UI numbers, turning towards a heading and anything that should "catch up".

For angles, wrap the difference first so turning takes the short way round:

```js
const turn = (a, b, rate, dt) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-rate * dt));
```

## Springs

For things that should overshoot and settle (a picked-up coin, a button, a recoiling gun):

```js
function spring(s, target, dt, stiffness = 170, damping = 14) {   // s = { x, v }
  s.v += ((target - s.x) * stiffness - s.v * damping) * dt;
  s.x += s.v * dt;
}
```

## Walk cycles from sine waves

Advance a phase by distance travelled, not by time, so feet do not slide when the speed changes.

```js
phase += speed * dt * 2.2;                          // 2.2 = steps per unit, tune to leg length
const swing = Math.sin(phase) * Math.min(1, speed / 3);
legL.rotation.x = swing * 0.9;  legR.rotation.x = -swing * 0.9;
armL.rotation.x = -swing * 0.6; armR.rotation.x = swing * 0.6;
body.position.y = baseY + Math.abs(Math.cos(phase)) * 0.06 * Math.min(1, speed / 3);   // bob twice per cycle
body.rotation.z = Math.sin(phase) * 0.04;
```

Build the character as a small tree of groups with each pivot at the joint (hip, shoulder), so a rotation swings the limb from the right place. Add idle breathing with a slow sine on the chest scale. Blend between states by damping the amplitudes, not by switching.

## Squash and stretch

Scale along the direction of travel and compensate on the other axes to keep volume. A jump that stretches to 1.2 on the way up and squashes to 0.8 on landing reads as lively with no extra art:

```js
const k = 1 + clamp(vy * 0.04, -0.25, 0.25);
mesh.scale.set(1 / Math.sqrt(k), k, 1 / Math.sqrt(k));
```

## Tweens and timelines

A dependency is not needed:

```js
const tweens = [];
const ease = { out: (t) => 1 - (1 - t) ** 3, inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2), back: (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2 };
function tween(dur, fn, easing = ease.out) { return new Promise((done) => tweens.push({ t: 0, dur, fn, easing, done })); }
function updateTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const w = tweens[i]; w.t = Math.min(1, w.t + dt / w.dur); w.fn(w.easing(w.t));
    if (w.t === 1) { tweens.splice(i, 1); w.done(); }
  }
}
// await tween(0.4, (k) => door.rotation.y = k * 1.5); await tween(0.2, (k) => light.intensity = k * 3);
```

Because each tween returns a promise, sequences read top to bottom with `await`.

## Movement on the GPU

Wind in grass, waves on water and flags should move in the vertex shader. One uniform changes per frame and thousands of vertices move with no CPU work. See the `onBeforeCompile` example in the materials guide.

For instanced crowds, give each instance a phase with an `InstancedBufferAttribute` and offset the sine by it so they do not move in unison.

## Particles

One `THREE.Points` or one `InstancedMesh` with a fixed pool. Keep position, velocity and life in typed arrays, reuse dead slots, and never allocate per particle per frame.

```js
const N = 400, pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), life = new Float32Array(N); let next = 0;
function emit(x, y, z) { const i = next++ % N; pos.set([x, y, z], i * 3); vel.set([(Math.random() - 0.5) * 3, 2 + Math.random() * 3, (Math.random() - 0.5) * 3], i * 3); life[i] = 1; }
function step(dt) {
  for (let i = 0; i < N; i++) {
    if (life[i] <= 0) { pos[i * 3 + 1] = -9999; continue; }       // park dead ones out of sight
    life[i] -= dt; vel[i * 3 + 1] -= 9.8 * dt;
    for (let k = 0; k < 3; k++) pos[i * 3 + k] += vel[i * 3 + k] * dt;
  }
  points.geometry.attributes.position.needsUpdate = true;
}
```

In 2D the same pool drawn with `fillRect` handles thousands.

## Cameras

Follow with damping, look slightly ahead of the player in the direction of travel, and keep a small dead zone so tiny movements do not move the world. Screen shake is an offset added after the follow, decaying quickly (0.2 to 0.4 s), and should have an off switch for players who dislike it. Respect `matchMedia('(prefers-reduced-motion: reduce)')` for shake and flashes.
