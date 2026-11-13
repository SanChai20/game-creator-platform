// @gcp/sound.js — a whole soundtrack with no audio files: named effects, looping ambience and generative music,
// all synthesised with Web Audio. Works in 2D and 3D games alike.
//   const sound = createSound();
//   sound.play('pickup');  sound.ambience('forest');  sound.music('adventure');
// Browsers only allow audio after a click, tap or key press. createSound() handles that: ambience and music you
// start early begin on the player's first gesture.
import { rng } from './procgen/noise.js';

const FX = {
  pickup: (s) => { s.tone(880, 0.09, 'triangle', 0.3, 0.3); s.tone(1320, 0.14, 'triangle', 0.3, 0.2, 0.07); },
  coin: (s) => { s.tone(988, 0.07, 'square', 0.16); s.tone(1319, 0.22, 'square', 0.16, 0, 0.07); },
  jump: (s) => s.tone(280, 0.2, 'sine', 0.3, 1.1),
  land: (s) => { s.noise(0.09, 0.3, 320); s.tone(90, 0.1, 'sine', 0.3, -0.5); },
  step: (s) => s.noise(0.05, 0.13, 380 + Math.random() * 260),
  hit: (s) => { s.noise(0.1, 0.35, 900, 1.2, 'bandpass'); s.tone(170, 0.12, 'square', 0.2, -1); },
  hurt: (s) => s.tone(320, 0.26, 'sawtooth', 0.22, -1.3),
  swing: (s) => s.noise(0.16, 0.22, 700, 1.5, 'bandpass', 0, 2600),
  shoot: (s) => { s.tone(760, 0.13, 'square', 0.16, -2.2); s.noise(0.06, 0.16, 2400, 0.7, 'highpass'); },
  explosion: (s) => { s.noise(0.8, 0.6, 900, 0.7, 'lowpass', 0, 60); s.tone(70, 0.6, 'sine', 0.5, -1.2); },
  win: (s) => [523, 659, 784, 1047, 1319].forEach((f, i) => s.tone(f, i === 4 ? 0.5 : 0.16, 'triangle', 0.28, 0, i * 0.11)),
  lose: (s) => [392, 330, 262, 196].forEach((f, i) => s.tone(f, i === 3 ? 0.6 : 0.24, 'triangle', 0.26, 0, i * 0.2)),
  click: (s) => s.tone(620, 0.035, 'square', 0.12),
  error: (s) => { s.tone(190, 0.12, 'square', 0.16); s.tone(150, 0.2, 'square', 0.16, 0, 0.13); },
  powerup: (s) => [440, 554, 659, 880, 1109, 1319].forEach((f, i) => s.tone(f, 0.1, 'sawtooth', 0.13, 0, i * 0.05)),
  door: (s) => { s.noise(0.24, 0.25, 260); s.tone(110, 0.2, 'sine', 0.25, -0.3); },
  splash: (s) => s.noise(0.4, 0.3, 1400, 0.6, 'highpass', 0, 500),
  pop: (s) => s.tone(480, 0.07, 'sine', 0.3, 1.6),
  magic: (s) => [1175, 1480, 1760, 2349].forEach((f, i) => s.tone(f, 0.5, 'sine', 0.13, 0.15, i * 0.06)),
  heal: (s) => [523, 659, 784].forEach((f, i) => s.tone(f, 0.4, 'sine', 0.2, 0.05, i * 0.12)),
  unlock: (s) => { s.tone(660, 0.08, 'square', 0.12); s.tone(880, 0.08, 'square', 0.12, 0, 0.09); s.tone(1320, 0.25, 'triangle', 0.2, 0, 0.18); },
  build: (s) => { s.noise(0.07, 0.3, 500); s.tone(140, 0.09, 'square', 0.18, -0.4); },
  chop: (s) => { s.noise(0.06, 0.34, 1300, 1, 'bandpass'); s.tone(210, 0.07, 'triangle', 0.2, -0.6); },
  talk: (s) => { for (let i = 0; i < 4; i++) s.tone(300 + Math.random() * 300, 0.05, 'square', 0.08, 0, i * 0.07); },
  alarm: (s) => { for (let i = 0; i < 3; i++) s.tone(880, 0.14, 'square', 0.14, -0.3, i * 0.2); },
  laser: (s) => s.tone(1500, 0.22, 'sawtooth', 0.14, -3),
  thunder: (s) => { s.noise(1.6, 0.6, 500, 0.6, 'lowpass', 0, 50); s.noise(0.2, 0.4, 2400, 0.7, 'highpass'); },
  bell: (s) => { s.tone(784, 1.2, 'sine', 0.26); s.tone(1568, 0.8, 'sine', 0.1); s.tone(2352, 0.5, 'sine', 0.05); },
};
/** Every effect name sound.play() knows. */
export const SOUNDS = Object.keys(FX);
/** Every ambience and music mood. */
export const AMBIENCES = ['wind', 'rain', 'storm', 'forest', 'night', 'ocean', 'fire', 'cave', 'space', 'city'];
const SCALES = { major: [0, 2, 4, 7, 9], minor: [0, 3, 5, 7, 10], dorian: [0, 2, 3, 5, 7, 9, 10], lydian: [0, 2, 4, 6, 7, 9, 11], phrygian: [0, 1, 3, 5, 7, 8, 10], whole: [0, 2, 4, 6, 8, 10] };
const MOODS = {
  calm: { bpm: 72, scale: 'major', root: 57, lead: 'sine', pad: 0.5, density: 0.45, drums: 0 },
  adventure: { bpm: 104, scale: 'dorian', root: 55, lead: 'triangle', pad: 0.4, density: 0.7, drums: 0.4 },
  happy: { bpm: 124, scale: 'major', root: 60, lead: 'square', pad: 0.25, density: 0.8, drums: 0.5 },
  tense: { bpm: 92, scale: 'phrygian', root: 50, lead: 'sawtooth', pad: 0.5, density: 0.4, drums: 0.5 },
  battle: { bpm: 142, scale: 'minor', root: 52, lead: 'sawtooth', pad: 0.3, density: 0.85, drums: 1 },
  mystery: { bpm: 66, scale: 'whole', root: 56, lead: 'sine', pad: 0.55, density: 0.35, drums: 0 },
  night: { bpm: 60, scale: 'lydian', root: 53, lead: 'sine', pad: 0.6, density: 0.3, drums: 0 },
  retro: { bpm: 132, scale: 'minor', root: 57, lead: 'square', pad: 0.1, density: 0.9, drums: 0.7 },
};
export const MUSIC = Object.keys(MOODS);

/**
 * The game's sound. Options: volume (0..1, default 0.6), muted.
 *   sound.play(name, { volume, pitch })   an effect: pickup, coin, jump, land, step, hit, hurt, swing, shoot, explosion,
 *                                          win, lose, click, error, powerup, door, splash, pop, magic, heal, unlock, build,
 *                                          chop, talk, alarm, laser, thunder, bell
 *   sound.ambience(kind, { volume })      a looping bed: wind, rain, storm, forest, night, ocean, fire, cave, space, city; null stops it
 *   sound.music(mood, { volume, seed })   generative music: calm, adventure, happy, tense, battle, mystery, night, retro; null stops it
 *   sound.mute(true | false), sound.muted, sound.setVolume(v)
 *   sound.tone(freq, dur, type, vol, slide, delay), sound.noise(dur, vol, freq, q, type, delay, sweepTo)   for your own effects
 */
export function createSound({ volume = 0.6, muted = false } = {}) {
  let ctx = null, master = null, fxBus = null, bedBus = null, musicBus = null, bed = null, bedWanted = null, music = null, musicWanted = null, noiseBuf = null;
  const unlock = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)(); master = ctx.createGain(); master.gain.value = muted ? 0 : volume; master.connect(ctx.destination);
      fxBus = ctx.createGain(); fxBus.connect(master); bedBus = ctx.createGain(); bedBus.connect(master); musicBus = ctx.createGain(); musicBus.connect(master);
      const delay = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain(); delay.delayTime.value = 0.34; fb.gain.value = 0.32; wet.gain.value = 0.35; musicBus.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);
      const n = ctx.sampleRate * 2; noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      if (bedWanted) S.ambience(bedWanted[0], bedWanted[1]); if (musicWanted) S.music(musicWanted[0], musicWanted[1]);
    } catch { ctx = null; }
  };
  addEventListener('pointerdown', unlock, { passive: true }); addEventListener('keydown', unlock); addEventListener('touchend', unlock, { passive: true });
  const env = (g, t, dur, vol, attack = 0.006) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); };
  let pitchMul = 1, volMul = 1;
  const S = {
    unlock, get muted() { return muted; }, get ready() { return !!ctx; }, get context() { return ctx; },
    mute(m = !muted) { muted = !!m; if (master) master.gain.value = muted ? 0 : volume; return muted; },
    setVolume(v) { volume = v; if (master && !muted) master.gain.value = v; },
    tone(freq = 440, dur = 0.15, type = 'sine', vol = 0.3, slide = 0, delay = 0, bus) {
      if (!ctx) return; const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain(); freq *= pitchMul;
      o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * Math.pow(2, slide)), t + dur);
      env(g, t, dur, vol * volMul, Math.min(0.02, dur * 0.2)); o.connect(g).connect(bus || fxBus); o.start(t); o.stop(t + dur + 0.03);
    },
    noise(dur = 0.2, vol = 0.3, freq = 1200, q = 1, type = 'lowpass', delay = 0, sweepTo = 0, bus) {
      if (!ctx) return; const t = ctx.currentTime + delay, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuf; s.loop = true; f.type = type; f.frequency.setValueAtTime(freq, t); if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur); f.Q.value = q;
      env(g, t, dur, vol * volMul); s.connect(f).connect(g).connect(bus || fxBus); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.03);
    },
    /** Plays a named effect. Unknown names play a soft click rather than throwing, so a typo never breaks the game. */
    play(name, { volume: v = 1, pitch = 1 } = {}) { if (!ctx) return false; pitchMul = pitch; volMul = v; try { (FX[name] || FX.click)(S); } finally { pitchMul = 1; volMul = 1; } return true; },
    ambience(kind, { volume: v = 0.5 } = {}) {
      bedWanted = kind ? [kind, { volume: v }] : null; if (!ctx) return;
      if (bed) { const old = bed; old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4); setTimeout(() => old.stop(), 1500); bed = null; }
      if (!kind) return;
      const gain = ctx.createGain(), nodes = [], timers = []; gain.gain.value = 0; gain.gain.setTargetAtTime(v, ctx.currentTime, 0.8); gain.connect(bedBus);
      const layer = (type, freq, q, vol, lfoHz = 0, lfoDepth = 0) => { const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noiseBuf; s.loop = true; f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = vol; s.connect(f).connect(g).connect(gain); s.start(0, Math.random()); nodes.push(s); if (lfoHz) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = lfoHz; lg.gain.value = lfoDepth * vol; l.connect(lg).connect(g.gain); l.start(); nodes.push(l); } };
      const drone = (freq, vol, type = 'sine') => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = freq; g.gain.value = vol; o.connect(g).connect(gain); o.start(); nodes.push(o); };
      const every = (min, max, fn) => { const h = { id: 0 }, go = () => { if (ctx.state === 'running') fn(); h.id = setTimeout(go, (min + Math.random() * (max - min)) * 1000); }; h.id = setTimeout(go, min * 500); timers.push(h); };
      const T = (f, d, ty, vo, sl, de) => S.tone(f, d, ty, vo, sl, de, gain), Nz = (d, vo, f, q, ty, de, sw) => S.noise(d, vo, f, q, ty, de, sw, gain);
      if (kind === 'wind' || kind === 'forest' || kind === 'night') layer('lowpass', 420, 0.6, kind === 'wind' ? 0.5 : 0.22, 0.13, 0.6);
      if (kind === 'wind') layer('bandpass', 900, 2, 0.12, 0.07, 0.9);
      if (kind === 'rain' || kind === 'storm') { layer('highpass', 1800, 0.5, 0.3); layer('lowpass', 700, 0.5, 0.2, 0.2, 0.3); }
      if (kind === 'storm') every(5, 14, () => { Nz(1.8, 0.7, 420, 0.6, 'lowpass', 0, 50); });
      if (kind === 'forest') every(1.2, 5, () => { const f = 2200 + Math.random() * 1800, n = 2 + (Math.random() * 4 | 0); for (let i = 0; i < n; i++) T(f * (1 + i * 0.04), 0.09, 'sine', 0.08, 0.25, i * 0.13); });
      if (kind === 'night') every(0.5, 1.4, () => { for (let i = 0; i < 6; i++) T(4300, 0.03, 'sine', 0.035, 0, i * 0.055); });
      if (kind === 'ocean') { layer('lowpass', 650, 0.5, 0.5, 0.11, 0.85); layer('highpass', 2600, 0.5, 0.07, 0.11, 0.9); }
      if (kind === 'fire') { layer('lowpass', 260, 0.7, 0.3, 0.9, 0.3); every(0.05, 0.3, () => Nz(0.03, 0.22, 2600 + Math.random() * 2500, 1.5, 'bandpass')); }
      if (kind === 'cave') { drone(55, 0.12); drone(82.4, 0.06); layer('lowpass', 200, 0.5, 0.14, 0.05, 0.6); every(1.5, 6, () => T(1500 + Math.random() * 1400, 0.25, 'sine', 0.1, -0.2)); }
      if (kind === 'space') { drone(48, 0.14); drone(72.3, 0.09); drone(96.6, 0.05, 'triangle'); layer('bandpass', 1500, 4, 0.04, 0.05, 0.9); }
      if (kind === 'city') { layer('lowpass', 300, 0.5, 0.4, 0.08, 0.4); every(4, 12, () => { T(420, 0.25, 'square', 0.03); T(420, 0.25, 'square', 0.03, 0, 0.4); }); }
      bed = { gain, stop() { nodes.forEach((n) => { try { n.stop(); } catch { /* ended */ } }); timers.forEach((h) => clearTimeout(h.id)); gain.disconnect(); } };
    },
    music(mood, { volume: v = 0.35, seed = 1 } = {}) {
      musicWanted = mood ? [mood, { volume: v, seed }] : null; if (!ctx) return;
      if (music) { clearInterval(music.timer); music = null; }
      if (!mood) return;
      const m = MOODS[mood] || MOODS.calm, scale = SCALES[m.scale], r = rng('music|' + mood + '|' + seed), beat = 60 / m.bpm, hz = (n) => 440 * Math.pow(2, (n - 69) / 12);
      const note = (deg, oct = 0) => m.root + scale[((deg % scale.length) + scale.length) % scale.length] + 12 * (oct + Math.floor(deg / scale.length));
      const prog = [0, r.pick([3, 4, 5]), r.pick([1, 2, 5]), r.pick([4, 3])], motif = Array.from({ length: 8 }, () => r.int(0, 6));
      let next = ctx.currentTime + 0.1, step = 0, walk = 2;
      const pad = (n, t, dur) => { const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = o2.type = 'sawtooth'; o.frequency.value = hz(n); o2.frequency.value = hz(n) * 1.006; f.type = 'lowpass'; f.frequency.value = 900; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05 * m.pad * v * 3, t + dur * 0.4); g.gain.linearRampToValueAtTime(0.0001, t + dur); o.connect(f); o2.connect(f); f.connect(g).connect(musicBus); o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05); };
      const pluck = (n, t, dur, vol, type) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = hz(n); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol * v * 3, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g).connect(musicBus); o.start(t); o.stop(t + dur + 0.05); };
      const tick = () => {
        while (next < ctx.currentTime + 0.35) {
          const bar = Math.floor(step / 8), pos = step % 8, chord = prog[bar % 4], t = next;
          if (pos === 0) { if (m.pad > 0) for (const d of [0, 2, 4]) pad(note(chord + d, 0), t, beat * 4.2); pluck(note(chord, -1), t, beat * 1.8, 0.09, 'triangle'); }
          if (pos === 4) pluck(note(chord, -1), t, beat * 1.2, 0.07, 'triangle');
          if (r() < m.density) { walk = bar % 4 === 3 && pos > 5 ? chord : r() < 0.55 ? motif[(pos + bar) % 8] : walk + r.int(-2, 2); walk = Math.max(-2, Math.min(9, walk)); pluck(note(chord + walk, 1), t, beat * (r() < 0.3 ? 1.4 : 0.6), m.lead === 'sine' ? 0.07 : 0.04, m.lead); }
          if (m.drums > 0) { if (pos % 4 === 0) S.tone(110, 0.12, 'sine', 0.2 * m.drums * v * 2, -1.2, t - ctx.currentTime, musicBus); if (pos % 4 === 2) S.noise(0.06, 0.1 * m.drums * v * 2, 1800, 0.8, 'highpass', t - ctx.currentTime, 0, musicBus); if (m.drums > 0.6 && pos % 2 === 1) S.noise(0.02, 0.04 * v * 2, 6000, 0.8, 'highpass', t - ctx.currentTime, 0, musicBus); }
          next += beat / 2; step++;
        }
      };
      music = { timer: setInterval(tick, 100) }; tick();
    },
  };
  return S;
}
