// The cartoon particle overlay: a transparent Canvas 2D layer above the page (it never takes a click) that pops
// stars, coins, confetti and sparkles where things happen, like the feedback in a casual game:
//
//   - pressing a main button, a tab or anything marked data-fx-burst gives a burst with a "poof" ring
//   - pointing at a game card, a category or a console row makes it twinkle at its corners while it is hovered
//   - code anywhere can ask for a burst with fxBurst() (the toast does, the console's score counters do)
//
// Canvas 2D runs in every browser this site supports, so this layer works with or without WebGL. It only runs a
// frame loop while particles are alive, so an idle page costs nothing. Sprites come from sprites.ts (drawn in code).
import { buildAtlas, type Atlas, type SpriteKind } from './sprites';
import { palette } from './gl';
import { color } from '../tokens';

export type BurstKind = 'stars' | 'coins' | 'confetti' | 'sparkle' | 'hearts' | 'gems';
type P = { x: number; y: number; vx: number; vy: number; r: number; vr: number; age: number; life: number; size: number; sprite: number; color: string; g: number; ring?: boolean; w?: number };

const CONFETTI = [palette.accent, palette.hot, palette.cyan, palette.gold, palette.violet];
const MIX: Record<BurstKind, SpriteKind[]> = {
  stars: ['star', 'star', 'sparkle', 'plus'], coins: ['coin', 'coin', 'coin', 'sparkle'], confetti: ['star', 'sparkle'],
  sparkle: ['sparkle'], hearts: ['heart', 'heart', 'sparkle'], gems: ['gem', 'gem', 'sparkle', 'star'],
};
/** Elements that burst when pressed, and what they burst. */
const PRESS = '[data-fx-burst], .btn-primary, .btn.pri, .tabs a, .seg button, .tl-tabs button, .feat-dot, .chip';
/** Elements that twinkle while hovered. */
const HOVER = '.game, .cart, .feat-cap, .list-row.is-link, .stat.is-link, .qband, .since-item, .mega-i, .grow-row';

let current: Overlay | null = null;
/** Asks the overlay for a burst at a point (or at the centre of an element). Does nothing when effects are off. */
export function fxBurst(at: { x: number; y: number } | Element | null | undefined, kind: BurstKind = 'stars', power = 1) {
  if (!current || !at) return;
  if (at instanceof Element) { const r = at.getBoundingClientRect(); current.burst(r.left + r.width / 2, r.top + r.height / 2, kind, power); }
  else current.burst(at.x, at.y, kind, power);
}

export class Overlay {
  private x: CanvasRenderingContext2D; private atlas: Atlas; private ps: P[] = []; private raf = 0; private last = 0;
  private dpr = 1; private hovered: Element | null = null; private hoverTimer = 0; private fine: boolean;
  constructor(private canvas: HTMLCanvasElement, private budget: number) {
    const x = canvas.getContext('2d'); if (!x) throw new Error('no 2d');
    this.x = x; this.atlas = buildAtlas(64);
    this.fine = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
    this.resize();
    addEventListener('resize', this.resize);
    document.addEventListener('click', this.click, true);
    if (this.fine) { document.addEventListener('pointerover', this.over, true); document.addEventListener('pointerout', this.out, true); }
    current = this;
  }
  dispose() {
    cancelAnimationFrame(this.raf); clearInterval(this.hoverTimer);
    removeEventListener('resize', this.resize);
    document.removeEventListener('click', this.click, true);
    document.removeEventListener('pointerover', this.over, true); document.removeEventListener('pointerout', this.out, true);
    if (current === this) current = null;
    this.ps = []; this.x.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize = () => {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(innerWidth * this.dpr); this.canvas.height = Math.round(innerHeight * this.dpr);
  };

  private click = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.(PRESS);
    if (!el || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
    const r = el.getBoundingClientRect();
    const keyboard = e.detail === 0 || (e.clientX === 0 && e.clientY === 0);
    const x = keyboard ? r.left + r.width / 2 : e.clientX, y = keyboard ? r.top + r.height / 2 : e.clientY;
    const asked = (el as HTMLElement).dataset?.fxBurst as BurstKind | undefined;
    const small = !asked && !el.matches('.btn-primary, .btn.pri');
    this.burst(x, y, asked || (small ? 'sparkle' : 'stars'), small ? 0.45 : 1);
  };
  private over = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.(HOVER);
    if (!el || el === this.hovered) return;
    this.hovered = el; clearInterval(this.hoverTimer);
    for (let i = 0; i < 2; i++) this.twinkle(el);
    this.hoverTimer = window.setInterval(() => { if (this.hovered?.isConnected) this.twinkle(this.hovered); else this.leave(); }, 520);
  };
  private out = (e: PointerEvent) => {
    if (!this.hovered) return;
    const to = e.relatedTarget as Node | null;
    if (to && this.hovered.contains(to)) return;
    this.leave();
  };
  private leave() { this.hovered = null; clearInterval(this.hoverTimer); }

  /** A sparkle that pops up on the edge of an element, mostly around its top corners. */
  twinkle(el: Element) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const side = Math.random();
    const x = side < 0.5 ? r.left + 6 + Math.random() * r.width * 0.25 : r.right - 6 - Math.random() * r.width * 0.25;
    const y = r.top + 6 + Math.random() * Math.min(40, r.height * 0.3);
    this.add({ x, y, vx: (Math.random() - 0.5) * 20, vy: -18 - Math.random() * 20, r: 0, vr: (Math.random() - 0.5) * 2, age: 0, life: 0.75, size: 14 + Math.random() * 10, sprite: this.atlas.index.sparkle, color: '', g: 0 });
  }

  burst(x: number, y: number, kind: BurstKind, power = 1) {
    const n = Math.round((kind === 'sparkle' ? 8 : 14) * power), kinds = MIX[kind];
    this.add({ x, y, vx: 0, vy: 0, r: 0, vr: 0, age: 0, life: 0.42, size: 34 * Math.sqrt(power), sprite: -1, color: kind === 'coins' ? palette.gold : palette.accent, g: 0, ring: true, w: 6 });
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5, sp = (200 + Math.random() * 260) * (0.6 + 0.4 * power);
      this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: Math.random() * 6, vr: (Math.random() - 0.5) * 10, age: 0, life: 0.8 + Math.random() * 0.5,
        size: (kind === 'sparkle' ? 14 : 20) + Math.random() * 12, sprite: this.atlas.index[kinds[i % kinds.length]], color: '', g: 900 });
    }
    if (kind === 'confetti' || kind === 'stars') {
      for (let i = 0; i < Math.round(10 * power); i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2, sp = 180 + Math.random() * 300;
        this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: Math.random() * 6, vr: (Math.random() - 0.5) * 16, age: 0, life: 1 + Math.random() * 0.6, size: 7 + Math.random() * 5, sprite: -2, color: CONFETTI[i % CONFETTI.length], g: 700 });
      }
    }
  }

  private add(p: P) {
    if (this.ps.length >= this.budget) this.ps.shift();
    this.ps.push(p);
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.frame); }
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    const x = this.x, d = this.dpr, cell = this.atlas.cell;
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const keep: P[] = [];
    for (const p of this.ps) {
      p.age += dt; if (p.age >= p.life) continue;
      keep.push(p);
      const k = p.age / p.life;
      p.vx *= 1 - 2.2 * dt; p.vy = p.vy * (1 - 2.2 * dt) + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      if (p.ring) {
        // a cartoon "poof": a thick ring that grows fast and thins out
        const rr = p.size * (0.4 + 1.6 * (1 - (1 - k) ** 3));
        x.setTransform(d, 0, 0, d, p.x * d, p.y * d); x.globalAlpha = 1 - k;
        x.lineWidth = (p.w || 6) * (1 - k) + 1; x.strokeStyle = p.color; x.beginPath(); x.arc(0, 0, rr, 0, Math.PI * 2); x.stroke();
        continue;
      }
      // pop in with an overshoot, hold, shrink away: squash and stretch along the motion
      const pop = k < 0.18 ? Math.sin((k / 0.18) * Math.PI * 0.75) / Math.sin(Math.PI * 0.75) * 1.0 : 1;
      const s = p.size * (k < 0.18 ? pop * 1.15 : k > 0.7 ? (1 - k) / 0.3 : 1);
      const v = Math.hypot(p.vx, p.vy), st = Math.min(0.35, v / 1600);
      x.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : 1;
      const c = Math.cos(p.r), sn = Math.sin(p.r);
      x.setTransform(d * c * (1 + st), d * sn * (1 + st), -d * sn * (1 - st), d * c * (1 - st), p.x * d, p.y * d);
      if (p.sprite === -2) { x.fillStyle = p.color; x.fillRect(-s / 2, -s / 4, s, s / 2); x.strokeStyle = color.ink; x.lineWidth = 1.5; x.strokeRect(-s / 2, -s / 4, s, s / 2); }
      else x.drawImage(this.atlas.canvas, p.sprite * cell, 0, cell, cell, -s / 2, -s / 2, s, s);
    }
    x.globalAlpha = 1;
    this.ps = keep;
    this.raf = keep.length ? requestAnimationFrame(this.frame) : 0;
    if (!keep.length) { x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  };
}
