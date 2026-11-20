// @gcp/hud.js — the game's interface drawn in a canvas over the game: counters, bars, a timer, objectives, hints,
// toasts, a start screen and an end screen. Works over 2D and 3D games. Everything is placed inside the safe area,
// scales down on phones, and never takes presses from the game except on its own buttons. It draws in the page's
// shared interface canvas (@gcp/ui.js), so the frame the platform captures for feedback is exactly what the player saw.
//   const hud = createHud({ accent: '#ffb347' });
//   const coins = hud.counter('Coins', { icon: '●', value: 0 });   coins.add(1);
//   const hp = hud.bar('Health', { value: 100, max: 100, color: '#e5484d' });   hp.set(64);
//   hud.objective('Find the three keys');   hud.hint('WASD to move, Space to jump', 6);
//   await hud.title({ title: 'Lantern Isle', subtitle: 'Light every beacon before dawn', controls: 'WASD · drag to look · Space' });
//   hud.end({ win: true, title: 'You made it', stats: { Time: '1:42', Coins: 12 }, onRestart: restart });
import { sharedUi, panelOpen } from './ui.js';

const fmtTime = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const clampN = (lo, v, hi) => Math.max(lo, Math.min(hi, v));
let seq = 0;

/**
 * Creates the interface. Options: accent (colour of highlights and buttons), ink (text colour), panel (panel
 * background), line (panel border), font (family), ui (draw in this createUi() instead of the shared one), and the
 * game's voice: titleFont, titleColor, titleShadow ({ color, blur, y }) for screen and menu titles, windowFill and windowLine
 * for windows (the backpack, menus), slotFill and slotLine for inventory slots.
 * Corners for every widget: 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc' (default varies).
 *   hud.counter(label, { icon, value, corner })      -> { value, set(v), add(n), remove() }
 *   hud.bar(label, { value, max, color, corner })    -> { value, set(v), add(n), remove() }
 *   hud.timer({ seconds, countdown, corner, onEnd }) -> { time, start(), stop(), reset(seconds), remove() }   starts at once
 *   hud.objective(text)        the current goal, top centre (null clears it)
 *   hud.hint(text, seconds)    a line at the bottom that fades out
 *   hud.toast(text, { color }) a short notice that stacks and disappears
 *   hud.prompt(key, text)      "[E] Open the chest" above the bottom; hud.prompt(null) hides it
 *   hud.button(label, onPress, { corner })   a small on-screen button (mute, pause, restart) -> { label, remove() }
 *   hud.label(corner, () => text | [[icon, text], …])   a panel whose text you compute (hidden while it is empty)
 *   hud.title({ title, subtitle, controls, button, onStart }) -> Promise   a start screen; resolves on click, tap, Enter or Space
 *   hud.end({ win, title, subtitle, stats, button, onRestart })            an end screen with a restart button
 *   hud.damage(strength), hud.flash(color), hud.fade(toBlack, seconds), hud.crosshair(true | false), hud.clear()
 * For your own widgets: hud.item(corner, { measure(u) -> { w, h }, draw(u, x, y, w, h) }) stacks one in a corner,
 * hud.window(draw, { width, height, onClose }) opens a centred modal window, hud.ui / hud.u are the canvas toolkit.
 */
export function createHud({ accent = '#ffb347', ink = '#f3efe6', panel = 'rgba(16,18,22,.72)', line = 'rgba(255,255,255,.14)', font, ui: given, parent,
  titleFont, titleColor, titleShadow = { color: 'rgba(0,0,0,.5)', blur: 24, y: 4 }, windowFill = 'rgba(22,25,31,.96)', windowLine, slotFill, slotLine } = {}) {
  const ui = given || sharedUi({ parent }), u = ui.u, ID = 'hud' + (++seq) + ':';
  const fam = font || u.font;
  const C = { tl: [], tr: [], bl: [], br: [], tc: [], bc: [] };
  const now = () => performance.now() / 1000;
  const small = () => u.w < 600;
  const M = () => (small() ? { fs: 13, vs: 16, px: 9, py: 5 } : { fs: 15, vs: 19, px: 12, py: 7 });
  const T = (o) => ({ family: fam, ...o });

  // ---- a row panel: parts side by side (text, a key cap, a bar, an icon) in a rounded panel ----
  function partSize(p, avail) {
    if (p.t === 'bar') return { w: p.w(), h: 10 };
    if (p.t === 'key') { const tw = u.measure(p.text, T({ size: 13, weight: 800 })); return { w: Math.max(26, tw + 14), h: 26 }; }
    if (p.t === 'box') return { w: p.w, h: p.h };
    const o = T(p); const tw = u.measure(p.text, o);
    if (p.wrap && tw > avail) { const ls = u.wrap(p.text, avail, o); return { w: avail, h: ls.length * p.size * 1.35, lines: ls.length }; }
    return { w: tw, h: p.size * 1.35 };
  }
  function drawPart(p, s, x, cy) {
    if (p.t === 'bar') { u.bar(x, cy - 5, s.w, 10, p.frac(), { color: p.color(), back: 'rgba(255,255,255,.14)', radius: 6, alpha: p.alpha }); return; }
    if (p.t === 'key') { u.panel(x, cy - 13, s.w, 26, { fill: ink, radius: 7 }); u.text(p.text, x + s.w / 2, cy + 0.5, T({ size: 13, weight: 800, color: '#16181c', align: 'center', base: 'middle' })); return; }
    if (p.t === 'box') { p.draw(u, x, cy - p.h / 2); return; }
    const k = p.scale || 1;
    const draw = () => u.text(p.text, x, cy, T({ ...p, base: 'middle', width: s.lines > 1 ? s.w : 0, lineHeight: 1.35 }));
    if (k !== 1) { const cx = x + s.w / 2; u.ctx.save(); u.ctx.translate(cx, cy); u.ctx.scale(k, k); u.ctx.translate(-cx, -cy); draw(); u.ctx.restore(); } else draw();
  }
  /** A corner item made of parts (computed each frame), in a panel unless bare. */
  function rowItem(partsFn, { bare = false, gap = 8, color } = {}) {
    let parts = [], sizes = [];
    return {
      measure(_u, maxW) {
        const m = M(); parts = partsFn(m).filter(Boolean); if (!parts.length) return { w: 0, h: 0 };
        const fixed = parts.reduce((s, p) => s + (p.wrap ? 0 : partSize(p, 1e9).w), 0) + gap * (parts.length - 1) + (bare ? 0 : m.px * 2 + 2);
        sizes = parts.map((p) => partSize(p, Math.max(60, maxW - fixed)));
        const w = sizes.reduce((s, z) => s + z.w, 0) + gap * (parts.length - 1) + (bare ? 0 : m.px * 2 + 2);
        const h = Math.max(...sizes.map((z) => z.h)) + (bare ? 0 : m.py * 2 + 2);
        return { w, h };
      },
      draw(_u, x, y, w, h) {
        if (!parts.length) return; const m = M();
        if (!bare) u.panel(x, y, w, h, { fill: panel, stroke: line, radius: 12, shadow: { color: 'rgba(0,0,0,.25)', blur: 18, y: 4 } });
        let cx = x + (bare ? 0 : m.px + 1); const cy = y + h / 2;
        parts.forEach((p, i) => { drawPart({ color: color || ink, ...p }, sizes[i], cx, cy); cx += sizes[i].w + gap; });
      },
    };
  }
  const label = (text, m) => ({ t: 'text', text, size: 11, weight: 700, upper: true, spacing: 0.9, alpha: 0.7 });
  const icon = (text, m) => (text ? { t: 'text', text, size: 17, weight: 600, color: accent } : null);

  // ---- corners ----
  function add(corner, item) { (C[corner] || C.tl).push(item); item.corner = corner; return item; }
  function drop(item) { for (const k in C) { const i = C[k].indexOf(item); if (i >= 0) C[k].splice(i, 1); } }
  function layoutCorner(k) {
    const sf = u.safe, list = C[k]; if (!list.length) return;
    const left = Math.max(14, sf.left), right = Math.max(14, sf.right), top = Math.max(14, sf.top), bottom = Math.max(k === 'bc' ? 22 : 14, sf.bottom);
    const maxW = k === 'tc' ? u.w * 0.7 : k === 'bc' ? u.w * 0.8 : u.w * 0.46;
    const sized = []; let total = 0;
    for (const it of list) { if (it.hidden && it.hidden()) continue; const s = it.measure(u, maxW); if (!s.w && !s.h) continue; sized.push([it, s]); total += s.h; }
    if (!sized.length) return; total += 8 * (sized.length - 1);
    let y = k[0] === 't' ? top : u.h - bottom - total;
    for (const [it, s] of sized) {
      const x = k[1] === 'l' ? left : k[1] === 'r' ? u.w - right - s.w : (u.w - s.w) / 2;
      const a = it.alpha ? it.alpha() : 1, dy = it.dy ? it.dy() : 0;
      if (a > 0.003) { if (a < 1) u.alpha(a, () => it.draw(u, x, y + dy, s.w, s.h)); else it.draw(u, x, y + dy, s.w, s.h); }
      y += s.h + 8;
    }
  }

  // ---- built-in pieces ----
  let objText = null, promptKey = null, promptText = null, hintText = '', hintUntil = 0, hintOn = false;
  const obj = add('tc', rowItem(() => (objText ? [icon('◆'), { t: 'text', text: objText, size: 15, weight: 600, wrap: true, shadow: { color: 'rgba(0,0,0,.8)', blur: 4 } }] : [])));
  const prm = add('bc', rowItem(() => (promptKey || promptText ? [promptKey ? { t: 'key', text: promptKey } : null, promptText ? { t: 'text', text: promptText, size: M().fs, weight: 600 } : null] : [])));
  const hnt = add('bc', rowItem(() => (hintText ? [{ t: 'text', text: hintText, size: 14, weight: 500, wrap: true, shadow: { color: 'rgba(0,0,0,.8)', blur: 4 } }] : []), { bare: true }));
  hnt.alpha = () => u.anim(ID + 'hint', hintOn && (!hintUntil || now() < hintUntil) ? 1 : 0, 1 / 0.4 * 2.2);
  const builtIn = new Set([obj, prm, hnt]);

  // overlays: the damage vignette, flashes and fades
  const vig = { a: 0, from: 0, to: 0, t0: 0, dur: 0, paint: null };
  const vigTo = (to, dur, from = vig.a) => { vig.from = from; vig.to = to; vig.t0 = now(); vig.dur = dur; vig.a = from; };
  let screen = null, cross = false, win = null; const timers = new Set(), offs = [];

  offs.push(ui.layer(() => { for (const k in C) layoutCorner(k); }, { z: 0 }));
  offs.push(ui.layer(() => {
    if (vig.dur > 0 || vig.a > 0) { const t = vig.dur > 0 ? clampN(0, (now() - vig.t0) / vig.dur, 1) : 1; vig.a = vig.from + (vig.to - vig.from) * t; if (t >= 1) vig.dur = 0; }
    if (vig.a > 0.003 && vig.paint) {
      const c = u.ctx; c.save(); c.globalAlpha *= vig.a;
      if (vig.paint.vignette) { c.translate(u.w / 2, u.h / 2); c.scale(u.w / 2 * Math.SQRT2, u.h / 2 * Math.SQRT2); const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.45, 'rgba(0,0,0,0)'); g.addColorStop(1, vig.paint.vignette); c.fillStyle = g; c.fillRect(-1, -1, 2, 2); }
      else { c.fillStyle = vig.paint.color; c.fillRect(0, 0, u.w, u.h); }
      c.restore();
    }
  }, { z: 10 }));
  offs.push(ui.layer(() => { if (win) win.draw(); }, { z: 20 }));
  offs.push(ui.layer(() => { if (screen) screen.draw(); }, { z: 30 }));
  offs.push(ui.layer(() => { if (cross) { u.panel(u.w / 2 - 5, u.h / 2 - 5, 10, 10, { fill: 'rgba(0,0,0,.4)', radius: 5 }); u.panel(u.w / 2 - 3, u.h / 2 - 3, 6, 6, { fill: '#fff', radius: 3 }); } }, { z: 40 }));

  // ---- full-screen screens (title, end) ----
  function openScreen(build) {
    hud.closeScreen(); const t0 = now(), id = ID + 'scr' + (++seq); panelOpen(ID + 'screen', true);
    screen = { id, draw() {
      const a = clampN(0, (now() - t0) / 0.35, 1), c = u.ctx;
      u.alpha(a, () => {
        c.save(); c.translate(u.w / 2, u.h / 2); c.scale(u.w / 2 * Math.SQRT2, u.h / 2 * Math.SQRT2); const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, 'rgba(8,10,14,.55)'); g.addColorStop(1, 'rgba(8,10,14,.9)'); c.fillStyle = g; c.fillRect(-1, -1, 2, 2); c.restore();
        u.block(0, 0, u.w, u.h);
        build(id);
      });
    } };
  }
  /** Lays out a centred card of blocks: [{ h, draw(x, y, w) }] top to bottom. */
  function card(blocks) {
    const W = Math.min(520, u.w * 0.92, u.w - 40), total = blocks.reduce((s, b) => s + b.h + (b.mb || 0), 0);
    let y = Math.max(20, (u.h - total) / 2); const x = (u.w - W) / 2;
    for (const b of blocks) { b.draw(x, y, W); y += b.h + (b.mb || 0); }
  }
  const textBlock = (str, o, mb = 0) => { const W = Math.min(520, u.w * 0.92, u.w - 40), ls = u.wrap(str, W, T(o)), lh = o.size * (o.lineHeight || 1.3); return { h: ls.length * lh, mb, draw: (x, y, w) => u.text(str, x + w / 2, y, T({ color: ink, ...o, width: w, align: 'center', base: 'top' })) }; };
  const bigButton = (id, text, onPress) => { const tw = u.measure(text, T({ size: 17, weight: 800 })), bw = tw + 60, bh = 47; return { h: bh, draw: (x, y, w) => { if (u.button(id, x + (w - bw) / 2, y, bw, bh, text, { fill: accent, color: '#16181c', size: 17, weight: 800, radius: 12, family: fam, shadow: { color: 'rgba(0,0,0,.35)', blur: 22, y: 6 } })) onPress(); } }; };

  // ---- modal windows (used by @gcp/play.js and by games) ----
  function openWindow(drawFn, { width = 420, height = 300, onClose, backdrop = true, closeOnBackdrop = true, escape = true } = {}) {
    const t0 = now(), W = { id: ID + 'win' + (++seq), closed: false,
      close() { if (W.closed) return; W.closed = true; if (win === W) win = null; panelOpen(W.id, false); removeEventListener('keydown', key, true); if (onClose) onClose(); },
      get isOpen() { return !W.closed; },
      draw() {
        const a = clampN(0, (now() - t0) / 0.18, 1);
        u.alpha(a, () => {
          if (backdrop) u.panel(0, 0, u.w, u.h, { fill: 'rgba(8,10,14,.55)' });
          const bw = Math.min(typeof width === 'function' ? width(u) : width, u.w * 0.96 - 8), bh = Math.min(typeof height === 'function' ? height(u) : height, u.h * 0.92 - 8);
          const x = Math.round((u.w - bw) / 2), y = Math.round((u.h - bh) / 2);
          if (closeOnBackdrop) { const r = u.hit(W.id + ':back', 0, 0, u.w, u.h, { focusable: false, cursor: '' }); if (r.clicked) { W.close(); return; } } else u.block(0, 0, u.w, u.h);
          u.panel(x, y, bw, bh, { fill: windowFill, stroke: windowLine || line, radius: 16, shadow: { color: 'rgba(0,0,0,.5)', blur: 60, y: 18 } });
          u.block(x, y, bw, bh);
          drawFn(u, x, y, bw, bh, W);
        });
      } };
    const key = (e) => { if (escape && e.code === 'Escape' && !W.closed) { e.stopPropagation(); W.close(); } };
    if (win) win.close(); win = W; panelOpen(W.id, true); addEventListener('keydown', key, true); return W;
  }

  const hud = {
    ui, u, el: ui.canvas, accent, ink, panel, line, font: fam, titleFont: titleFont || fam, titleColor: titleColor || ink, titleShadow, windowFill, windowLine: windowLine || line, slotFill: slotFill || panel, slotLine: slotLine || line,
    counter(lab, { icon: ic = '', value = 0, corner = 'tl' } = {}) {
      let popAt = -1;
      const it = add(corner, rowItem((m) => { const p = clampN(0, (now() - popAt) / 0.18, 1), k = popAt < 0 || p >= 1 ? 0 : Math.sin(p * Math.PI);
        return [icon(ic), label(lab), { t: 'text', text: String(c.value), size: m.vs, weight: 800, scale: 1 + 0.35 * k, color: k > 0.3 ? accent : ink }]; }));
      const c = { value, el: it, set(n) { if (n !== c.value) popAt = now(); c.value = n; return c; }, add(n = 1) { return c.set(c.value + n); }, remove() { drop(it); } }; return c;
    },
    bar(lab, { value = 100, max = 100, color = accent, corner = 'tl' } = {}) {
      const it = add(corner, rowItem(() => [label(lab), { t: 'bar', w: () => Math.min(190, u.w * 0.34), frac: () => u.anim(ID + 'bar' + id, c.value / c.max, 1 / 0.25 * 2.5), color: () => color }]));
      const id = ++seq;
      const c = { value, max, el: it, set(n) { c.value = Math.max(0, Math.min(c.max, n)); return c; }, add(n) { return c.set(c.value + n); }, remove() { drop(it); } }; c.set(value); return c;
    },
    timer({ seconds = 0, countdown = seconds > 0, corner = 'tr', label: lab = 'Time', onEnd } = {}) {
      const c = hud.counter(lab, { value: fmtTime(seconds), corner, icon: '◷' }); let t = seconds, last = performance.now(), on = true, ended = false;
      const id = setInterval(() => { const n = performance.now(), dt = Math.min(0.5, (n - last) / 1000); last = n; if (!on || document.hidden) return; t += countdown ? -dt : dt; if (countdown && t <= 0 && !ended) { t = 0; ended = true; on = false; if (onEnd) onEnd(); } c.value = fmtTime(t); tm.time = t; }, 100); timers.add(id);
      const tm = { time: t, el: c.el, start() { on = true; last = performance.now(); return tm; }, stop() { on = false; return tm; }, reset(s = seconds) { t = s; ended = false; tm.time = t; c.value = fmtTime(t); return tm; }, remove() { clearInterval(id); timers.delete(id); c.remove(); } }; return tm;
    },
    objective(text) { objText = text || null; return hud; },
    hint(text, seconds = 5) { if (text) hintText = text; hintOn = !!text; hintUntil = text && seconds > 0 ? now() + seconds : 0; return hud; },
    toast(text, { color, seconds = 2.6, corner = 'tc' } = {}) {
      const t0 = now(), it = add(corner, rowItem(() => [{ t: 'text', text, size: M().fs, weight: 600, wrap: true }], { color }));
      it.alpha = () => { const e = now() - t0; return e < 0.25 ? e / 0.25 : e > seconds ? Math.max(0, 1 - (e - seconds) / 0.4) : 1; };
      it.dy = () => { const e = now() - t0; return e < 0.25 ? 8 * (1 - e / 0.25) : e > seconds ? -8 * Math.min(1, (e - seconds) / 0.4) : 0; };
      setTimeout(() => drop(it), (seconds + 0.42) * 1000); return hud;
    },
    prompt(key, text) { promptKey = key || null; promptText = text || null; return hud; },
    button(lab, onPress, { corner = 'tr' } = {}) {
      const id = ID + 'btn' + (++seq);
      const b = { label: lab, get textContent() { return b.label; }, set textContent(v) { b.label = String(v); }, click() { onPress(b); }, remove() { drop(it); } };
      const it = add(corner, {
        measure() { return { w: u.measure(b.label, T({ size: 14, weight: 700 })) + 26, h: 36 }; },
        draw(_u, x, y, w, h) { if (u.button(id, x, y, w, h, b.label, { fill: panel, color: ink, size: 14, weight: 700, radius: 10, stroke: line, line: 1, shadow: null, hover: 'rgba(40,44,52,.85)', family: fam })) onPress(b); },
      });
      return b;
    },
    label(corner, fn, { color } = {}) {
      const it = add(corner, rowItem(() => { const v = fn(); if (!v) return []; if (typeof v === 'string' || typeof v === 'number') return [{ t: 'text', text: String(v), size: M().fs, weight: 600, wrap: true }];
        const out = []; for (const [ic, tx] of v) { if (ic) out.push(icon(ic)); out.push({ t: 'text', text: String(tx), size: M().fs, weight: 600 }); } return out; }, { color, gap: 6 }));
      return { el: it, remove() { drop(it); } };
    },
    item(corner, item) { add(corner, item); return { remove() { drop(item); } }; },
    window: openWindow,
    get windowOpen() { return !!win; },
    title({ title = document.title, subtitle = '', controls = '', button = 'Play', onStart } = {}) {
      return new Promise((res) => {
        let done = false;
        const go = (e) => { if (e && e.type === 'keydown' && e.code !== 'Enter' && e.code !== 'Space') return; if (done) return; done = true; removeEventListener('keydown', go); hud.closeScreen(); if (onStart) onStart(); res(); };
        openScreen((id) => card([
          textBlock(title, { size: clampN(30, u.w * 0.07, 58), weight: 900, lineHeight: 1.05, family: titleFont || fam, color: titleColor || ink, shadow: titleShadow }, 10),
          subtitle ? textBlock(subtitle, { size: clampN(14, u.w * 0.026, 18), weight: 500, alpha: 0.85 }, 18) : null,
          bigButton(id + ':go', button, go),
          controls ? { h: 14, draw() {} } : null,
          controls ? textBlock(controls, { size: 13, weight: 500, alpha: 0.7 }) : null,
        ].filter(Boolean)));
        addEventListener('keydown', go); hud.start = go;
      });
    },
    end({ win: won = true, title = won ? 'You win' : 'Game over', subtitle = '', stats = {}, button = 'Play again', onRestart } = {}) {
      let done = false; const restart = () => { if (done) return; done = true; hud.closeScreen(); if (onRestart) onRestart(); };
      const keys = Object.keys(stats);
      openScreen((id) => {
        const m = M(), W = Math.min(520, u.w * 0.92, u.w - 40), cells = keys.map((k) => { const lw = u.measure(k, T({ size: 11, weight: 700, spacing: 0.9, upper: true })), vw = u.measure(String(stats[k]), T({ size: m.vs, weight: 800 })); return { k, lw, vw, w: lw + vw + 8 + m.px * 2 + 2 }; });
        const rows = []; let row = [], rw = 0; for (const c of cells) { if (row.length && rw + 10 + c.w > W) { rows.push(row); row = []; rw = 0; } rw += (row.length ? 10 : 0) + c.w; row.push(c); } if (row.length) rows.push(row);
        const ch = m.vs * 1.35 + m.py * 2 + 2;
        card([
          textBlock(title, { size: clampN(30, u.w * 0.07, 58), weight: 900, lineHeight: 1.05, family: titleFont || fam, color: won ? accent : '#ff8a70', shadow: titleShadow }, 10),
          subtitle ? textBlock(subtitle, { size: clampN(14, u.w * 0.026, 18), weight: 500, alpha: 0.85 }, 18) : null,
          rows.length ? { h: rows.length * ch + (rows.length - 1) * 10, mb: 18, draw: (x, y, w) => rows.forEach((r, j) => { const tw = r.reduce((s, c) => s + c.w, 0) + 10 * (r.length - 1); let cx = x + (w - tw) / 2; const cy = y + j * (ch + 10);
            for (const c of r) { u.panel(cx, cy, c.w, ch, { fill: panel, stroke: line, radius: 12 }); u.text(c.k, cx + m.px + 1, cy + ch / 2, T({ size: 11, weight: 700, upper: true, spacing: 0.9, alpha: 0.7, base: 'middle', color: ink })); u.text(String(stats[c.k]), cx + c.w - m.px - 1, cy + ch / 2, T({ size: m.vs, weight: 800, align: 'right', base: 'middle', color: ink })); cx += c.w + 10; } }) } : null,
          bigButton(id + ':again', button, restart),
        ].filter(Boolean));
      });
      hud.restart = restart; return hud;
    },
    closeScreen() { screen = null; panelOpen(ID + 'screen', false); return hud; },
    get screenOpen() { return !!screen; },
    damage(strength = 0.6) { vig.paint = { vignette: `rgba(220,30,30,${strength})` }; vigTo(0, 0.6, 1); return hud; },
    flash(color = '#fff', seconds = 0.35) { vig.paint = { color }; vigTo(0, seconds, 0.8); return hud; },
    fade(toBlack = true, seconds = 0.6) { if (!vig.paint || vig.paint.color !== '#000') { vig.paint = { color: '#000' }; if (!toBlack) vig.a = 0; } vigTo(toBlack ? 1 : 0, seconds); return new Promise((r) => setTimeout(r, seconds * 1000)); },
    crosshair(on = true) { cross = !!on; return hud; },
    clear() { for (const k in C) C[k] = C[k].filter((it) => builtIn.has(it)); timers.forEach(clearInterval); timers.clear(); if (win) win.close(); hud.objective(null).prompt(null).hint('').closeScreen(); return hud; },
    remove() { hud.clear(); for (const k in C) C[k].length = 0; offs.forEach((f) => f()); },
  };
  return hud;
}
