// @gcp/canvas2d.js — helpers for 2D and 2.5D games on a plain canvas.
// Conventions: bake every sprite once and blit it; cache ground in chunk-sized canvases; sort tall things by
// their feet; cap the backing-store resolution; draw the HUD in DOM, not on the game canvas.

/** Sizes the canvas backing store to its CSS size × min(devicePixelRatio, maxDpr). view.w / view.h are CSS pixels. */
export function setupCanvas(canvas, { maxDpr = 2, alpha = false, onResize } = {}) {
  const ctx = canvas.getContext('2d', { alpha });
  const view = { ctx, w: 0, h: 0, dpr: 1 };
  const apply = () => {
    view.dpr = Math.min(devicePixelRatio || 1, maxDpr); view.w = canvas.clientWidth || innerWidth; view.h = canvas.clientHeight || innerHeight;
    canvas.width = Math.round(view.w * view.dpr); canvas.height = Math.round(view.h * view.dpr);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); ctx.imageSmoothingEnabled = true;
    if (onResize) onResize(view);
  };
  apply();
  new ResizeObserver(apply).observe(canvas);
  canvas.style.touchAction = 'none';
  return view;
}

/**
 * Draws once into an offscreen canvas and returns a sprite { canvas, w, h, ax, ay }.
 * w/h are in world units; `scale` is pixels per unit. The anchor (ax, ay) defaults to bottom-centre (the feet).
 */
export function bake(w, h, draw, { scale = 48, ax = 0.5, ay = 1 } = {}) {
  const c = document.createElement('canvas'); c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale);
  const x = c.getContext('2d'); x.scale(scale, scale); x.lineJoin = x.lineCap = 'round';
  draw(x, w, h);
  return { canvas: c, w, h, ax, ay };
}

export class Camera2D {
  constructor() { this.x = 0; this.y = 0; this.zoom = 48; this.shake = 0; }
  /** Smoothly follows a point. */
  follow(x, y, dt, stiffness = 6) { const k = 1 - Math.exp(-stiffness * dt); this.x += (x - this.x) * k; this.y += (y - this.y) * k; this.shake = Math.max(0, this.shake - dt * 3); }
  /** Call before drawing world things; call ctx.restore() after. */
  begin(view) {
    const { ctx } = view, sx = this.shake ? (Math.random() - 0.5) * this.shake * 12 : 0, sy = this.shake ? (Math.random() - 0.5) * this.shake * 12 : 0;
    ctx.save(); ctx.translate(Math.round(view.w / 2 + sx), Math.round(view.h / 2 + sy)); ctx.scale(this.zoom, this.zoom); ctx.translate(-this.x, -this.y);
  }
  toWorld(view, px, py) { return { x: (px - view.w / 2) / this.zoom + this.x, y: (py - view.h / 2) / this.zoom + this.y }; }
  /** World-space rectangle that is on screen, with a margin, for culling. */
  bounds(view, margin = 2) { const hw = view.w / 2 / this.zoom + margin, hh = view.h / 2 / this.zoom + margin; return { x0: this.x - hw, x1: this.x + hw, y0: this.y - hh, y1: this.y + hh }; }
}

/** Draws [{ sprite, x, y, flip?, alpha?, rot? }] back to front by y so nearer things overlap farther ones. */
export function drawSorted(ctx, items) {
  items.sort((a, b) => a.y - b.y);
  for (const it of items) {
    const s = it.sprite;
    if (it.alpha !== undefined) ctx.globalAlpha = it.alpha;
    if (it.flip || it.rot) { ctx.save(); ctx.translate(it.x, it.y); if (it.rot) ctx.rotate(it.rot); if (it.flip) ctx.scale(-1, 1); ctx.drawImage(s.canvas, -s.w * s.ax, -s.h * s.ay, s.w, s.h); ctx.restore(); }
    else ctx.drawImage(s.canvas, it.x - s.w * s.ax, it.y - s.h * s.ay, s.w, s.h);
    if (it.alpha !== undefined) ctx.globalAlpha = 1;
  }
}

/**
 * Ground cache: the world is cut into chunk × chunk unit squares, each painted once by paint(ctx, cx, cy, chunk)
 * into its own canvas. Every frame only blits the visible ones. Call invalidate(cx, cy) when a chunk changes.
 */
export class ChunkCache {
  constructor({ chunk = 8, scale = 48, paint, max = 96 }) { this.chunk = chunk; this.scale = scale; this.paint = paint; this.max = max; this.map = new Map(); }
  invalidate(cx, cy) { this.map.delete(cx + ',' + cy); }
  draw(ctx, b) {
    const n = this.chunk;
    for (let cy = Math.floor(b.y0 / n); cy <= Math.floor(b.y1 / n); cy++) for (let cx = Math.floor(b.x0 / n); cx <= Math.floor(b.x1 / n); cx++) {
      const k = cx + ',' + cy; let c = this.map.get(k);
      if (!c) {
        c = document.createElement('canvas'); c.width = c.height = n * this.scale;
        const x = c.getContext('2d'); x.scale(this.scale, this.scale); x.translate(-cx * n, -cy * n); this.paint(x, cx, cy, n);
        this.map.set(k, c);
        if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
      }
      ctx.drawImage(c, cx * n, cy * n, n + 0.02, n + 0.02); // slight overlap hides seams
    }
  }
}
