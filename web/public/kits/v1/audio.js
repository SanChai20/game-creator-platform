// @gcp/audio.js — synthesised sound, no audio files. Browsers only start audio after a user gesture,
// so the context is created on the first pointer or key press.

export function createAudio({ volume = 0.5 } = {}) {
  let ctx = null, master = null, muted = false;
  const unlock = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); master = ctx.createGain(); master.gain.value = muted ? 0 : volume; master.connect(ctx.destination); } catch { ctx = null; }
  };
  addEventListener('pointerdown', unlock, { passive: true }); addEventListener('keydown', unlock);
  const env = (g, t, dur, vol, attack = 0.005) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); };
  return {
    unlock,
    get muted() { return muted; },
    setMuted(m) { muted = !!m; if (master) master.gain.value = muted ? 0 : volume; },
    setVolume(v) { volume = v; if (master && !muted) master.gain.value = v; },
    /** A pitched blip. slide > 0 glides the pitch up (pickups), < 0 down (hits). type: sine | square | sawtooth | triangle. */
    tone({ freq = 440, dur = 0.15, type = 'sine', vol = 0.3, slide = 0, delay = 0 } = {}) {
      if (!ctx) return;
      const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * Math.pow(2, slide)), t + dur);
      env(g, t, dur, vol); o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
    },
    /** Filtered noise: footsteps (low, short), explosions (low, long), hiss (high). */
    noise({ dur = 0.2, vol = 0.3, freq = 1200, q = 1, type = 'lowpass', delay = 0 } = {}) {
      if (!ctx) return;
      const t = ctx.currentTime + delay, n = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = buf; f.type = type; f.frequency.value = freq; f.Q.value = q; env(g, t, dur, vol);
      s.connect(f).connect(g).connect(master); s.start(t);
    },
    /** Plays notes in sequence: chord([523, 659, 784]) is a rising jingle. */
    chord(freqs, { step = 0.08, dur = 0.18, type = 'triangle', vol = 0.25 } = {}) { freqs.forEach((f, i) => this.tone({ freq: f, dur, type, vol, delay: i * step })); },
  };
}
