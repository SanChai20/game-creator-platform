// @gcp/ui.js — the game's interface drawn in a canvas: panels, text, buttons, bars, scrolling lists, pictures.
// Everything a player sees is drawn in the game's canvases (the platform contract, "Hand over the frame"), so the
// creator's feedback screenshots are exactly the frame they saw on every device, iPhone and iPad included.
//
//   import { createUi } from '@gcp/ui.js';
//   const ui = createUi();                       // a canvas over the whole page, above the game's own canvas
//   ui.layer((u) => {                            // drawn every frame, after the game's own frame
//     u.panel(16, 16, 220, 56, { fill: 'rgba(16,18,22,.75)', radius: 12 });
//     u.text('Coins ' + coins, 32, 44, { size: 20, weight: 800, base: 'middle' });
//     if (u.button('play', u.w / 2 - 90, u.h / 2 - 26, 180, 52, 'Play')) start();
//   });
//   GCP.test.onCapture(() => [gameCanvas, ui.canvas]);   // createUi does this for you when the page has one other canvas
//
// Immediate mode: a layer function draws the whole interface each frame from the game's state and asks each widget
// what happened to it (u.button returns true on the frame it was pressed). Units are CSS pixels; u.w and u.h are the
// page's size, u.safe the notch and home-bar insets. A press on a widget never reaches the game; u.block(x, y, w, h)
// keeps the game from getting presses on a panel that has no buttons. Keyboard: Tab and the arrow keys move between
// buttons while u.nav is on (a menu is open), Enter or Space presses the focused one.

const DPR_MAX = 3;
const SAFE0 = { top: 0, right: 0, bottom: 0, left: 0 };

/** A rounded rectangle path (radius a number or [tl, tr, br, bl]). */
export function roundRectPath(ctx, x, y, w, h, r = 0) {
  const rr = Array.isArray(r) ? r : [r, r, r, r], m = Math.min(w, h) / 2;
  const [a, b, c, d] = rr.map((v) => Math.max(0, Math.min(m, +v || 0)));
  ctx.beginPath(); ctx.moveTo(x + a, y); ctx.lineTo(x + w - b, y); ctx.arcTo(x + w, y, x + w, y + b, b); ctx.lineTo(x + w, y + h - c); ctx.arcTo(x + w, y + h, x + w - c, y + h, c);
  ctx.lineTo(x + d, y + h); ctx.arcTo(x, y + h, x, y + h - d, d); ctx.lineTo(x, y + a); ctx.arcTo(x, y, x + a, y, a); ctx.closePath();
}

/** A colour, or a gradient from { from, to, angle (deg, 90 = top to bottom) } or { radial: [inner, outer] }, for the box x, y, w, h. */
export function paintOf(ctx, p, x, y, w, h) {
  if (!p || typeof p === 'string') return p;
  if (p.radial) { const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2); stops(g, p.radial); return g; }
  const a = ((p.angle ?? 90) * Math.PI) / 180, dx = Math.cos(a) * w / 2, dy = Math.sin(a) * h / 2, cx = x + w / 2, cy = y + h / 2;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy); stops(g, p.stops || [p.from, p.to]); return g;
}
function stops(g, list) { list.forEach((c, i) => { if (Array.isArray(c)) g.addColorStop(c[0], c[1]); else g.addColorStop(list.length < 2 ? 0 : i / (list.length - 1), c); }); }

/**
 * A picture loaded once and kept (by URL): draw it with u.image(loadImage(url), …); until it has loaded nothing is
 * drawn. For the game's own interface art prefer createAtlas, drawn in code.
 */
const IMAGES = new Map();
export function loadImage(src) { let im = IMAGES.get(src); if (!im) { im = new Image(); im.decoding = 'async'; im.src = src; IMAGES.set(src, im); } return im; }

/**
 * A sprite atlas drawn in code: every piece of interface art (frames, panels, buttons, bars, icons) is painted once by
 * a function into one sheet, and drawn from that sheet with u.sprite(). One sheet means one texture: the browser
 * batches the draws, the art stays sharp at any size the sheet's scale covers, and there is one place to manage it.
 *   const atlas = createAtlas();                                   // scale: sheet pixels per CSS pixel (default 2, or the screen's, up to 3)
 *   atlas.add('panel', 64, 64, (c, w, h) => { … }, { slice: 18 });   // slice: a border (px, or [top, right, bottom, left]) that stays put when it stretches
 *   atlas.add('coin', 24, 24, (c, w, h) => { … });                // c is a 2D context scaled so you draw in the piece's own w × h units
 *   ui.layer((u) => { u.sprite(atlas, 'panel', 20, 20, 300, 120); u.sprite(atlas, 'coin', 32, 32); });
 * atlas.add(name, w, h, draw, { slice }) adds or replaces a piece (the sheet is packed again on the next draw);
 * atlas.get(name) -> { x, y, sw, sh (in the sheet), w, h, slice }; atlas.canvas is the sheet; atlas.names lists the pieces.
 */
export function createAtlas({ scale = Math.min(DPR_MAX, Math.max(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1)), pad = 2, max = 4096 } = {}) {
  const pieces = new Map(), cv = document.createElement('canvas'), place = new Map(); let dirty = true;
  function pack() {
    dirty = false; place.clear();
    const list = [...pieces.values()].sort((a, b) => b.h - a.h || b.w - a.w);
    let width = 256; const need = list.reduce((s, p) => s + (p.w * scale + pad * 2) * (p.h * scale + pad * 2), 0);
    while (width * width < need * 1.25 && width < max) width *= 2;
    for (const p of list) width = Math.max(width, Math.min(max, Math.ceil(p.w * scale + pad * 2)));
    let x = 0, y = 0, row = 0;
    for (const p of list) { const sw = Math.ceil(p.w * scale), sh = Math.ceil(p.h * scale); if (x + sw + pad * 2 > width) { x = 0; y += row; row = 0; } place.set(p.name, { x: x + pad, y: y + pad, sw, sh, w: p.w, h: p.h, slice: p.slice }); x += sw + pad * 2; row = Math.max(row, sh + pad * 2); }
    cv.width = width; cv.height = Math.max(1, y + row);
    const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height);
    for (const p of list) { const q = place.get(p.name); c.save(); c.beginPath(); c.rect(q.x, q.y, q.sw, q.sh); c.clip(); c.translate(q.x, q.y); c.scale(q.sw / p.w, q.sh / p.h); try { p.draw(c, p.w, p.h); } catch (e) { console.error('atlas piece ' + p.name, e); } c.restore(); }
  }
  const atlas = {
    scale, get canvas() { if (dirty) pack(); return cv; }, get names() { return [...pieces.keys()]; },
    add(name, w, h, draw, { slice = 0 } = {}) { pieces.set(name, { name, w, h, draw, slice }); dirty = true; return atlas; },
    has(name) { return pieces.has(name); },
    get(name) { if (dirty) pack(); return place.get(name); },
    /** Packs and paints the sheet now (it happens by itself on the first draw). */
    build() { if (dirty) pack(); return atlas; },
  };
  return atlas;
}

/**
 * Every canvas the player sees, bottom to top (by z-index, then page order): what a game's GCP.test.onCapture hands
 * over when its picture is all in canvases on the page. Hidden and empty canvases are left out.
 */
export function pageCanvases() {
  const all = [...document.querySelectorAll('canvas')].filter((c) => c.isConnected && c.width && c.height && c.getBoundingClientRect().width > 1 && getComputedStyle(c).visibility !== 'hidden' && getComputedStyle(c).display !== 'none');
  const z = (c) => { let n = 0; for (let e = c; e && e !== document.body; e = e.parentElement) { const v = parseInt(getComputedStyle(e).zIndex, 10); if (!isNaN(v)) n = v; } return n; };
  return all.map((c, i) => [c, z(c), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
}

/**
 * Which menus are up: a title or end screen, a pause menu, the backpack, a window. @gcp/hud.js and @gcp/play.js mark
 * theirs; mark your own with panelOpen('shop', true) / panelOpen('shop', false). panelUp() is true while any is open
 * (@gcp/input.js frees the mouse and hides the touch buttons then).
 */
export function panelOpen(id, on = true) { const s = (window.__gcpPanels ||= new Set()); if (on) s.add(id); else s.delete(id); }
export function panelUp() { const s = window.__gcpPanels; return !!(s && s.size); }

/**
 * The page's one shared interface canvas (made on first use): the platform's kits (@gcp/hud.js, the panels of
 * @gcp/play.js, floating text) all draw in it, so the frame is the game's canvas plus this one.
 */
export function sharedUi(opts) { const k = '__gcpUi'; if (!window[k] || !window[k].canvas.isConnected) window[k] = createUi(opts); return window[k]; }

/**
 * Creates the interface canvas. Options:
 *   parent (document.body), z (40, its stacking order), font (the default family), canvas (draw into this canvas instead of
 *   a new one: then the game draws its world first and calls ui.draw() itself), capture (true: register GCP.test.onCapture
 *   with the page's canvases bottom to top, this one last, unless the game registers its own), scale (false: units are CSS
 *   pixels; true or GCP.ui.configure options such as { reference: [1280, 720] }: units are the runtime's interface units,
 *   so u.w, u.h, u.safe, pointers and drawing all follow GCP.ui.scale, the screen size and the player's Interface size).
 * Returns ui: { canvas, layer(fn) -> remove(), draw(), font(family, weights, url?) -> Promise, nav, focus(id), blocks(x, y), remove() }.
 */
export function createUi({ parent = document.body, z = 40, font = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', canvas = null, capture = true, scale = false } = {}) {
  const own = !canvas;
  const G = () => (window.GCP && window.GCP.ui) || null;
  if (scale && typeof scale === 'object' && G()) G().configure(scale);
  let us = 1;   // CSS pixels per unit
  const cv = canvas || document.createElement('canvas');
  if (own) { cv.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${z};touch-action:none`; cv.setAttribute('aria-hidden', 'true'); parent.appendChild(cv); }
  const ctx = cv.getContext('2d');
  const layers = [], hits = [], prevHits = [], held = new Map(), clicks = new Set(), scrolls = new Map(), anims = new Map();
  let w = 0, h = 0, dpr = 1, pointer = { x: -1, y: -1, down: false, id: null, type: 'mouse' }, focusId = null, order = [], wantFocus = 0, press = null, raf = 0, last = performance.now(), cursor = '';
  const u = {
    get w() { return w; }, get h() { return h; }, get dpr() { return dpr; }, ctx, font, nav: false, dt: 0, time: 0,
    get pointer() { return pointer; },
    get safe() { const s = (window.GCP && GCP.display && GCP.display.safe) || SAFE0; return { top: (s.top || 0) / us, right: (s.right || 0) / us, bottom: (s.bottom || 0) / us, left: (s.left || 0) / us }; },
    /** CSS pixels per unit (1 unless created with scale). */
    get scale() { return us; },
    /** A box: fill (colour or gradient), stroke and line, radius, shadow { color, blur, x, y }, alpha. */
    panel(x, y, bw, bh, { fill, stroke, line = 1, radius = 0, shadow, alpha } = {}) {
      ctx.save(); if (alpha != null) ctx.globalAlpha *= alpha;
      roundRectPath(ctx, x, y, bw, bh, radius);
      if (shadow) { ctx.shadowColor = shadow.color || 'rgba(0,0,0,.35)'; ctx.shadowBlur = shadow.blur ?? 12; ctx.shadowOffsetX = shadow.x || 0; ctx.shadowOffsetY = shadow.y ?? 4; }
      if (fill) { ctx.fillStyle = paintOf(ctx, fill, x, y, bw, bh); ctx.fill(); }
      ctx.shadowColor = 'transparent';
      if (stroke && line > 0) { ctx.lineWidth = line; ctx.strokeStyle = paintOf(ctx, stroke, x, y, bw, bh); roundRectPath(ctx, x + line / 2, y + line / 2, bw - line, bh - line, Array.isArray(radius) ? radius.map((r) => Math.max(0, r - line / 2)) : Math.max(0, radius - line / 2)); ctx.stroke(); }
      ctx.restore(); return u;
    },
    /** The canvas font string for size, weight, family (and italic). */
    fontOf({ size = 16, weight = 600, family, italic = false } = {}) { return `${italic ? 'italic ' : ''}${weight} ${size}px ${family || u.font}`; },
    /** Width of a line of text in those text options. */
    measure(str, o = {}) { ctx.save(); ctx.font = u.fontOf(o); if (o.spacing != null && 'letterSpacing' in ctx) ctx.letterSpacing = o.spacing + 'px'; const m = ctx.measureText(String(str)).width; ctx.restore(); return m; },
    /** The lines of str wrapped to width (words, then characters for languages without spaces); '\n' breaks a line. */
    wrap(str, width, o = {}) {
      ctx.save(); ctx.font = u.fontOf(o); if (o.spacing != null && 'letterSpacing' in ctx) ctx.letterSpacing = o.spacing + 'px';
      const out = [];
      for (const para of String(str).split('\n')) {
        const words = para.match(/[　-鿿가-힯＀-￯]|[^\s　-鿿가-힯＀-￯]+\s*|\s+/g) || [''];
        let line = '';
        for (const wd of words) {
          const t = line + wd;
          if (ctx.measureText(t.trimEnd()).width <= width || !line) { line = t; if (ctx.measureText(line.trimEnd()).width > width && line.trim().length > 1) { let cut = line; while (cut.length > 1 && ctx.measureText(cut).width > width) cut = cut.slice(0, -1); out.push(cut); line = line.slice(cut.length); } }
          else { out.push(line.trimEnd()); line = wd.trimStart(); }
        }
        out.push(line.trimEnd());
      }
      ctx.restore(); return out;
    },
    /**
     * Text at x, y. Options: size, weight, family, italic, color (colour or gradient), align ('left' | 'center' | 'right'),
     * base ('alphabetic' | 'top' | 'middle' | 'bottom'), width (wrap to this width), lines (at most this many, the last
     * ends in …), lineHeight (1.3), spacing (letter spacing, px), stroke { color, width } (an outline under the fill),
     * shadow { color, blur, x, y }, alpha, upper (upper case), scale (about x, y). Returns { w, h, lines }.
     */
    text(str, x, y, o = {}) {
      const { size = 16, color = '#f3efe6', align = 'left', base = 'alphabetic', width = 0, lineHeight = 1.3, stroke, shadow, alpha, lines: maxLines = 0 } = o;
      let s = String(str ?? ''); if (o.upper) s = s.toUpperCase();
      textsNow.push(s);
      let ls = width > 0 ? u.wrap(s, width, o) : s.split('\n');
      if (maxLines > 0 && ls.length > maxLines) { ls = ls.slice(0, maxLines); let t = ls[maxLines - 1]; while (t.length && u.measure(t + '…', o) > (width || Infinity)) t = t.slice(0, -1); ls[maxLines - 1] = t + '…'; }
      const lh = size * lineHeight, total = lh * (ls.length - 1);
      ctx.save(); if (alpha != null) ctx.globalAlpha *= alpha; if (o.scale != null && o.scale !== 1) { ctx.translate(x, y); ctx.scale(o.scale, o.scale); ctx.translate(-x, -y); }
      ctx.font = u.fontOf(o); ctx.textAlign = align; ctx.textBaseline = base === 'center' ? 'middle' : base;
      if (o.spacing != null && 'letterSpacing' in ctx) ctx.letterSpacing = o.spacing + 'px';
      let y0 = y; if (base === 'middle' || base === 'center') y0 -= total / 2; else if (base === 'bottom' || base === 'alphabetic' && ls.length > 1 && o.up) y0 -= total;
      let wmax = 0; for (const l of ls) wmax = Math.max(wmax, ctx.measureText(l).width);
      const bx = align === 'center' ? x - wmax / 2 : align === 'right' ? x - wmax : x;
      ls.forEach((l, i) => {
        const ly = y0 + i * lh;
        if (shadow) { ctx.shadowColor = shadow.color || 'rgba(0,0,0,.6)'; ctx.shadowBlur = shadow.blur ?? 4; ctx.shadowOffsetX = shadow.x || 0; ctx.shadowOffsetY = shadow.y ?? 1; }
        if (stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = (stroke.width || 3) * 2; ctx.strokeStyle = stroke.color || '#000'; ctx.strokeText(l, x, ly); ctx.shadowColor = 'transparent'; }
        ctx.fillStyle = paintOf(ctx, color, bx, ly - size, wmax, size * 1.2); ctx.fillText(l, x, ly);
        ctx.shadowColor = 'transparent';
      });
      ctx.restore();
      return { w: wmax, h: lh * ls.length, lines: ls.length };
    },
    /** A picture (image, canvas, ImageBitmap) in the box; fit 'fill' | 'contain' | 'cover'; radius clips the corners. */
    image(img, x, y, bw, bh, { fit = 'fill', radius = 0, alpha } = {}) {
      if (!img) return u; const iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height; if (!iw || !ih) return u;
      ctx.save(); if (alpha != null) ctx.globalAlpha *= alpha; if (radius) { roundRectPath(ctx, x, y, bw, bh, radius); ctx.clip(); }
      if (fit === 'fill') ctx.drawImage(img, x, y, bw, bh);
      else { const k = fit === 'cover' ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih), dw = iw * k, dh = ih * k; ctx.drawImage(img, x + (bw - dw) / 2, y + (bh - dh) / 2, dw, dh); }
      ctx.restore(); return u;
    },
    /**
     * A piece of a createAtlas() sheet in the box (default its own size). A piece made with a slice stretches by its
     * border (9-slice), so one small frame serves every panel size. Options: alpha, slice (override, px), flip ('x' | 'y').
     */
    sprite(atlas, name, x, y, bw, bh, { alpha, slice, flip } = {}) {
      const p = atlas.get(name); if (!p) return u; bw = bw ?? p.w; bh = bh ?? p.h;
      const img = atlas.canvas, k = atlas.scale, sl = slice ?? p.slice;
      ctx.save(); if (alpha != null) ctx.globalAlpha *= alpha;
      if (flip) { ctx.translate(flip === 'x' ? x * 2 + bw : 0, flip === 'y' ? y * 2 + bh : 0); ctx.scale(flip === 'x' ? -1 : 1, flip === 'y' ? -1 : 1); }
      if (!sl) ctx.drawImage(img, p.x, p.y, p.sw, p.sh, x, y, bw, bh);
      else {
        const [t, r, b, l] = Array.isArray(sl) ? sl : [sl, sl, sl, sl], f = Math.min(1, bw / (l + r || 1), bh / (t + b || 1));
        const sx = [p.x, p.x + l * k, p.x + p.sw - r * k, p.x + p.sw], sy = [p.y, p.y + t * k, p.y + p.sh - b * k, p.y + p.sh];
        const dx = [x, x + l * f, x + bw - r * f, x + bw], dy = [y, y + t * f, y + bh - b * f, y + bh];
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const sw = sx[i + 1] - sx[i], sh = sy[j + 1] - sy[j], dw = dx[i + 1] - dx[i], dh = dy[j + 1] - dy[j]; if (sw > 0 && sh > 0 && dw > 0 && dh > 0) ctx.drawImage(img, sx[i], sy[j], sw, sh, dx[i], dy[j], dw, dh); }
      }
      ctx.restore(); return u;
    },
    /** A meter: frac 0..1 filled with color over back. */
    bar(x, y, bw, bh, frac, { color = '#ffb347', back = 'rgba(255,255,255,.14)', radius = bh / 2, stroke, line } = {}) {
      u.panel(x, y, bw, bh, { fill: back, radius, stroke, line });
      const f = Math.max(0, Math.min(1, +frac || 0)); if (f > 0) { ctx.save(); roundRectPath(ctx, x, y, bw, bh, radius); ctx.clip(); u.panel(x, y, Math.max(bh * 0.6, bw * f), bh, { fill: color, radius }); ctx.restore(); }
      return u;
    },
    /**
     * A press area with no look of its own (for a custom widget): { hover, down, clicked, focused }. Presses on it never
     * reach the game. Register it each frame the area is on screen.
     */
    hit(id, x, y, bw, bh, { focusable = true, cursor: cur = 'pointer', disabled = false } = {}) {
      const area = { id, x, y, w: bw, h: bh, clip: clipNow(), cur: disabled ? '' : cur, disabled }; hits.push(area);
      if (focusable && !disabled) order.push(id);
      const inside = inArea(area, pointer.x, pointer.y) && topAt(pointer.x, pointer.y) === id;
      const r = { hover: inside && pointer.type !== 'touch', down: !disabled && press && press.id === id && pointer.down && inside, clicked: !disabled && clicks.has(id), focused: focusId === id && u.nav };
      if (r.clicked) clicks.delete(id);
      return r;
    },
    /** Keeps presses in this box away from the game (a panel or a full-screen menu). */
    block(x, y, bw, bh) { hits.push({ id: null, x, y, w: bw, h: bh, clip: clipNow(), cur: '' }); return u; },
    /**
     * A button. Options: fill, color (text), size, weight, radius, stroke, line, shadow, hover / down (fills while hovered /
     * pressed), icon (a function (u, x, y, size) drawing an icon before the label), disabled, align. True when pressed.
     */
    button(id, x, y, bw, bh, label, o = {}) {
      const r = u.hit(id, x, y, bw, bh, o), k = u.anim('b:' + id, r.down ? 1 : 0, 30), hv = u.anim('h:' + id, r.hover || r.focused ? 1 : 0, 14);
      const { fill = '#ffb347', color = '#16181c', size = Math.min(20, bh * 0.4), weight = 800, radius = 12, stroke, line, shadow = { color: 'rgba(0,0,0,.35)', blur: 14, y: 5 }, icon, disabled, align = 'center' } = o;
      const s = 1 - k * 0.04 + hv * 0.02, cx = x + bw / 2, cy = y + bh / 2;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy); if (disabled) ctx.globalAlpha *= 0.45;
      u.panel(x, y, bw, bh, { fill: r.down && o.down ? o.down : hv > 0.5 && o.hover ? o.hover : fill, radius, stroke, line, shadow });
      if (r.focused) u.panel(x - 3, y - 3, bw + 6, bh + 6, { stroke: o.ring || '#fff', line: 2, radius: (typeof radius === 'number' ? radius : 12) + 3 });
      const iw = icon ? size * 1.15 : 0, gap = icon && label ? size * 0.45 : 0, tw = label ? u.measure(label, { size, weight, family: o.family }) : 0;
      const start = align === 'left' ? x + (o.pad ?? 16) : cx - (iw + gap + tw) / 2;
      if (icon) icon(u, start, cy - iw / 2, iw);
      if (label) u.text(label, start + iw + gap, cy, { size, weight, color, base: 'middle', family: o.family, spacing: o.spacing });
      ctx.restore();
      return r.clicked;
    },
    /** Draws fn clipped to the box (radius rounds it). */
    clip(x, y, bw, bh, fn, { radius = 0 } = {}) { ctx.save(); roundRectPath(ctx, x, y, bw, bh, radius); ctx.clip(); clipStack.push({ x, y, w: bw, h: bh }); try { fn(u); } finally { clipStack.pop(); ctx.restore(); } return u; },
    /**
     * A scrolling area: fn(u, top) draws the content with its top at y = top (inside the box); contentH is its height.
     * The wheel, a drag or a two-finger swipe scrolls it; a thin bar shows where it is. Returns the scroll offset.
     */
    scroll(id, x, y, bw, bh, contentH, fn, { bar = 'rgba(255,255,255,.35)', radius = 0 } = {}) {
      const st = scrolls.get(id) || { y: 0, v: 0 }; scrolls.set(id, st);
      const max = Math.max(0, contentH - bh); st.max = max; st.box = { x, y, w: bw, h: bh, clip: clipNow() }; st.seen = frameNo;
      if (!st.drag) { st.y += st.v * u.dt * 60; st.v *= Math.pow(0.9, u.dt * 60); }
      st.y = Math.max(0, Math.min(max, st.y));
      u.block(x, y, bw, bh);
      u.clip(x, y, bw, bh, () => fn(u, y - st.y), { radius });
      if (max > 0 && bar) { const th = Math.max(24, bh * bh / contentH), ty = y + (bh - th) * (st.y / max); u.panel(x + bw - 5, ty + 2, 3, th - 4, { fill: bar, radius: 2 }); }
      return st.y;
    },
    /** Scrolls a scrolling area to an offset (or by delta with { by: true }). */
    scrollTo(id, v, { by = false } = {}) { const st = scrolls.get(id) || { y: 0, v: 0 }; st.y = by ? st.y + v : v; st.v = 0; scrolls.set(id, st); return u; },
    /** A value that eases toward target (per id), for hover glows, slides and fades: speed is how fast (1/s). */
    anim(id, target, speed = 10) { const a = anims.has(id) ? anims.get(id) : target, v = a + (target - a) * Math.min(1, u.dt * speed); anims.set(id, Math.abs(v - target) < 0.001 ? target : v); return anims.get(id); },
    /** Runs fn with the alpha multiplied, or translated / scaled about (cx, cy). */
    alpha(a, fn) { ctx.save(); ctx.globalAlpha *= a; try { fn(u); } finally { ctx.restore(); } return u; },
    translate(dx, dy, fn) { ctx.save(); ctx.translate(dx, dy); shift.push([dx, dy]); try { fn(u); } finally { shift.pop(); ctx.restore(); } return u; },
    /** Asks for keyboard focus on a button (by id) while u.nav is on. */
    focus(id) { focusId = id; return u; },
  };
  const clipStack = [], shift = []; let frameNo = 0, textsNow = [], textsLast = [];
  const off = () => { let x = 0, y = 0; for (const s of shift) { x += s[0]; y += s[1]; } return [x, y]; };
  function clipNow() { if (!clipStack.length) return null; const c = clipStack[clipStack.length - 1]; return c; }
  // hit areas are kept in page coordinates (a translate() moves them with what is drawn)
  const pushHit = hits.push.bind(hits); hits.push = (a) => { const [dx, dy] = off(); a.x += dx; a.y += dy; if (a.clip) a.clip = { x: a.clip.x + dx, y: a.clip.y + dy, w: a.clip.w, h: a.clip.h }; return pushHit(a); };
  function inArea(a, x, y) { if (x < a.x || y < a.y || x > a.x + a.w || y > a.y + a.h) return false; const c = a.clip; return !c || (x >= c.x && y >= c.y && x <= c.x + c.w && y <= c.y + c.h); }
  // the topmost area under a point, from the last drawn frame (later areas are drawn over earlier ones)
  function topAt(x, y, list = prevHits) { for (let i = list.length - 1; i >= 0; i--) if (inArea(list[i], x, y)) return list[i].id; return undefined; }
  const under = (x, y) => { for (let i = prevHits.length - 1; i >= 0; i--) if (inArea(prevHits[i], x, y)) return prevHits[i]; return null; };

  function size() {
    const nw = innerWidth, nh = innerHeight, nd = Math.min(DPR_MAX, window.devicePixelRatio || 1);
    const ns = scale && G() ? G().scale : 1;
    if (own) { if (nw !== w * us || nh !== h * us || nd !== dpr || ns !== us) { us = ns; w = nw / us; h = nh / us; dpr = nd; cv.width = Math.round(nw * dpr); cv.height = Math.round(nh * dpr); } }
    else { const r = cv.getBoundingClientRect(); us = ns; w = (r.width || cv.width) / us; h = (r.height || cv.height) / us; dpr = cv.width / ((r.width || cv.width) || 1); }
  }
  function draw() {
    const now = performance.now(); u.dt = Math.min(0.1, (now - last) / 1000); last = now; u.time += u.dt; frameNo++;
    size();
    prevHits.length = 0; prevHits.push(...hits); hits.length = 0; order = []; textsLast = textsNow; textsNow = [];
    ctx.setTransform(dpr * us, 0, 0, dpr * us, 0, 0); if (own) ctx.clearRect(0, 0, w, h);
    for (const l of layers.slice()) { ctx.save(); try { l.fn(u); } catch (e) { if (!l.failed) { l.failed = true; console.error(e); } } finally { ctx.restore(); } }
    if (wantFocus && order.length) { const i = Math.max(0, order.indexOf(focusId)); focusId = order[(i + wantFocus + order.length) % order.length]; } wantFocus = 0;
    if (u.nav && focusId == null && order.length) focusId = order[0];
    const c = under(pointer.x, pointer.y), cur2 = c && c.cur ? c.cur : ''; if (cur2 !== cursor && own) { cursor = cur2; document.documentElement.style.cursor = cursor; }
    clicks.clear();
  }
  let drew = false;   // one more frame after the last layer goes, to clear it
  function loop() { raf = requestAnimationFrame(loop); if (own && (layers.length || drew)) { draw(); drew = layers.length > 0; } }
  if (own) raf = requestAnimationFrame(loop);

  // Input: before the game sees it (capture phase on the window). A press on an area of the interface is the
  // interface's; everything else goes on to the game untouched.
  const pt = (e) => { const r = own ? { left: 0, top: 0 } : cv.getBoundingClientRect(); return [(e.clientX - r.left) / us, (e.clientY - r.top) / us]; };
  const mine = (e) => { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); };
  function onDown(e) {
    const [x, y] = pt(e); pointer = { x, y, down: true, id: e.pointerId, type: e.pointerType || 'mouse' };
    const a = under(x, y); if (!a) return;
    mine(e); press = { id: a.id, x, y, sy: null };
    for (const [id, st] of scrolls) if (st.seen === frameNo && st.box && inArea(st.box, x, y)) { press.scroll = id; press.sy = st.y; st.v = 0; }
  }
  function onMove(e) {
    const [x, y] = pt(e); pointer.x = x; pointer.y = y; pointer.type = e.pointerType || pointer.type;
    if (!press) return; mine(e);
    if (press.scroll != null) { const st = scrolls.get(press.scroll); if (st && Math.abs(y - press.y) > 6) { st.drag = true; const ny = press.sy - (y - press.y); st.v = (st.y - ny) * -1 / 2; st.y = ny; press.id = undefined; } }
  }
  function onUp(e) {
    const [x, y] = pt(e); pointer.x = x; pointer.y = y; pointer.down = false;
    if (!press) return; mine(e);
    if (press.id != null && topAt(x, y) === press.id) clicks.add(press.id);
    if (press.scroll != null) { const st = scrolls.get(press.scroll); if (st) st.drag = false; }
    press = null;
  }
  function onWheel(e) {
    const [x, y] = pt(e);
    for (const [, st] of scrolls) if (st.seen === frameNo && st.box && inArea(st.box, x, y) && st.max > 0) { mine(e); st.y = Math.max(0, Math.min(st.max, st.y + e.deltaY * (e.deltaMode ? 30 : 1))); st.v = 0; return; }
    if (under(x, y)) mine(e);
  }
  function onClick(e) { const [x, y] = pt(e); if (under(x, y)) mine(e); }
  function onKey(e) {
    if (!u.nav) return;
    if (e.code === 'Tab' || e.code === 'ArrowDown' || e.code === 'ArrowRight') { wantFocus = e.shiftKey && e.code === 'Tab' ? -1 : 1; mine(e); }
    else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') { wantFocus = -1; mine(e); }
    else if ((e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') && focusId != null) { clicks.add(focusId); mine(e); }
  }
  const opts = { capture: true, passive: false };
  addEventListener('pointerdown', onDown, opts); addEventListener('pointermove', onMove, opts); addEventListener('pointerup', onUp, opts); addEventListener('pointercancel', onUp, opts);
  addEventListener('wheel', onWheel, opts); addEventListener('click', onClick, opts); addEventListener('keydown', onKey, opts);
  // a touch that starts on the interface must not also scroll, zoom or become a mouse event for the game
  const onTouch = (e) => { const t = e.touches && e.touches[0]; if (t && under(...pt(t))) mine(e); };
  addEventListener('touchstart', onTouch, opts); addEventListener('mousedown', onClick, opts);

  // the frame the platform takes for feedback: the page's canvases bottom to top, this one last
  if (capture && own && window.GCP && GCP.test && GCP.test.onCapture && !(window.__GCP && window.__GCP.capture)) {   // a game's own hook wins
    GCP.test.onCapture(() => pageCanvases());
  }

  const ui = {
    canvas: cv, u,
    /** Adds a layer drawn every frame, lower z first (then in the order added); returns a function that removes it. */
    layer(fn, { z = 0 } = {}) { const l = { fn, z }; let i = layers.length; while (i > 0 && layers[i - 1].z > z) i--; layers.splice(i, 0, l); return () => { const k = layers.indexOf(l); if (k >= 0) layers.splice(k, 1); }; },
    /** Draws every layer now (only needed with your own canvas, after you drew the world into it). */
    draw,
    /** Loads a web font face (url optional when the page's CSS already declares it) and waits for it. */
    async font(family, weights = [400, 700], url) {
      const list = [];
      for (const wt of [].concat(weights)) {
        try { if (url) { const f = new FontFace(family, `url(${typeof url === 'function' ? url(wt) : url})`, { weight: String(wt) }); document.fonts.add(f); list.push(f.load()); } else list.push(document.fonts.load(`${wt} 16px "${family}"`)); } catch (e) { /* the fallback font draws */ }
      }
      await Promise.allSettled(list); return ui;
    },
    get nav() { return u.nav; }, set nav(v) { u.nav = !!v; if (!v) focusId = null; },
    focus(id) { focusId = id; return ui; },
    /** For play-throughs: presses the widget with this id on the next frame, as a tap would. */
    click(id) { clicks.add(id); return ui; },
    /** For play-throughs: whether a widget with this id was on screen in the last frame. */
    shown(id) { return prevHits.some((a) => a.id === id); },
    /** For play-throughs: every string drawn with u.text in the last frame (assert what the player reads). */
    get texts() { return textsLast.slice(); },
    /** Whether the interface is under this point (the game can ignore its own input there). */
    blocks(x, y) { return !!under(x, y); },
    remove() {
      cancelAnimationFrame(raf); layers.length = 0; if (own) cv.remove();
      removeEventListener('pointerdown', onDown, opts); removeEventListener('pointermove', onMove, opts); removeEventListener('pointerup', onUp, opts); removeEventListener('pointercancel', onUp, opts);
      removeEventListener('wheel', onWheel, opts); removeEventListener('click', onClick, opts); removeEventListener('keydown', onKey, opts); removeEventListener('touchstart', onTouch, opts); removeEventListener('mousedown', onClick, opts);
    },
  };
  return ui;
}
