# Audio

Sound is optional for verification and important for feel. Synthesised sound needs no files at all; recorded sound is fine too.

## The one rule browsers enforce

Audio cannot start until the player has pressed a key, clicked or tapped. Create or resume the `AudioContext` inside that first gesture. Calling `play()` earlier does nothing, or throws a rejection that would count as an error in verification if you leave it unhandled.

```js
let ctx;
const unlock = () => { ctx = ctx || new AudioContext(); if (ctx.state === 'suspended') ctx.resume(); };
addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
```

## Synthesised effects

```js
import { createAudio } from '@gcp/audio.js';
const audio = createAudio({ volume: 0.5 });         // unlocks itself on the first gesture

audio.tone({ freq: 660, dur: 0.12, slide: 1 });                    // pickup: pitch glides up an octave
audio.tone({ freq: 180, dur: 0.25, type: 'square', slide: -1 });   // hit: glides down
audio.noise({ dur: 0.08, freq: 500 });                             // footstep
audio.noise({ dur: 0.7, freq: 300, vol: 0.5 });                    // explosion
audio.chord([523, 659, 784, 1047]);                                // success jingle
audio.setMuted(true);
```

The building blocks by hand:

```js
function blip(freq = 440, dur = 0.15, type = 'sine', vol = 0.3) {
  if (!ctx) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.005);                  // a tiny attack avoids a click
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);            // exponential decay sounds natural
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
}
```

Ideas that go a long way: vary pitch by a few percent each time so repeated sounds do not grate; layer a short noise burst over a tone for impacts; use a low-pass filter sweep on noise for wind and surf; never start more than a handful of voices in the same frame.

## Music from code

A loop that schedules notes slightly ahead of time stays in rhythm even when frames stutter:

```js
const scale = [0, 3, 5, 7, 10], root = 220; let step = 0, nextAt = 0;
function music() {                                   // call every frame
  if (!ctx) return;
  while (nextAt < ctx.currentTime + 0.2) {           // schedule 200 ms ahead
    const semis = scale[(step * 3 + (step >> 2)) % scale.length] + (step % 8 === 0 ? -12 : 0);
    const o = ctx.createOscillator(), g = ctx.createGain(), t = Math.max(nextAt, ctx.currentTime);
    o.type = 'triangle'; o.frequency.value = root * 2 ** (semis / 12);
    g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(musicBus); o.start(t); o.stop(t + 0.45);
    nextAt = t + 0.25; step++;
  }
}
```

Route music and effects through separate `GainNode`s so players can set them independently.

## Recorded audio

```js
const buf = await ctx.decodeAudioData(await (await fetch('./assets/theme.ogg')).arrayBuffer());
function play(buffer, { loop = false, vol = 1 } = {}) {
  const s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = buffer; s.loop = loop; g.gain.value = vol; s.connect(g).connect(ctx.destination); s.start();
  return s;
}
```

Decode after the first gesture or create the context early and resume it later. Prefer `.ogg` or `.mp3` at modest bitrates and keep an eye on the bundle size. Only ship audio you have the right to use.

## Manners

- A visible mute control, with the choice remembered.
- Silence when the tab is hidden: `document.addEventListener('visibilitychange', () => document.hidden ? ctx.suspend() : ctx.resume())`.
- Positional sound in 3D: a `PannerNode` per source and `ctx.listener` moved with the camera, or `THREE.PositionalAudio`.
- Keep the master level conservative. Many quiet voices add up fast; a `DynamicsCompressorNode` before the destination prevents clipping.
