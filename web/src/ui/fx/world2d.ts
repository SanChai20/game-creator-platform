// The fallback world: the same cartoon sky as the Three.js world, painted once with Canvas 2D. It is used where
// WebGL 2 is missing or unreliable (WebGL 1-only devices, old Safari and Android browsers, software renderers, a GPU
// that failed earlier in the session) and for reduced motion when WebGL 2 is missing. It repaints only on resize or
// when the page moves between the store and the creator pages, so it costs nothing between those.
import { palette, rng, type FxTheme, type FxTier } from './gl';
import { paintSprite, shade, type SpriteKind } from './sprites';

export type World2dStats = { tier: FxTier; engine: 'canvas'; paints: number; ms: number };
const OUTLINE = '#140c26';

export class World2d {
  stats: World2dStats;
  private x: CanvasRenderingContext2D; private raf = 0;
  constructor(private canvas: HTMLCanvasElement, tier: FxTier, private theme: FxTheme) {
    const x = canvas.getContext('2d', { alpha: false }); if (!x) throw new Error('no 2d');
    this.x = x; this.stats = { tier, engine: 'canvas', paints: 0, ms: 0 };
    addEventListener('resize', this.queue);
  }
  start() { this.paint(); }
  setTheme(t: FxTheme) { if (t !== this.theme) { this.theme = t; this.queue(); } }
  pageChange() { this.queue(); }
  dispose() { cancelAnimationFrame(this.raf); removeEventListener('resize', this.queue); delete document.documentElement.dataset.fxLive; }
  private queue = () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.paint()); };

  private paint() {
    const t0 = performance.now(), dpr = Math.min(devicePixelRatio || 1, 1.5), W = innerWidth, H = innerHeight, x = this.x;
    this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const work = this.theme === 'workshop', r = rng(work ? 23 : 11);

    // sky: flat cartoon bands from ink to a warm (store) or cool (workshop) horizon
    const low = work ? palette.cyan : palette.hot;
    for (let i = 0; i < 6; i++) {
      const k = i / 5;
      x.fillStyle = mixHex(palette.ink, mixHex(shade(palette.violet, -0.55), shade(low, -0.6), Math.max(0, (k - 0.55) / 0.45)), Math.min(1, k * 0.42));
      x.fillRect(0, (H * i) / 6 - 1, W, H / 6 + 2);
    }
    // calm the reading column
    const g = x.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(10,9,16,0)'); g.addColorStop(0.5, 'rgba(10,9,16,.5)'); g.addColorStop(1, 'rgba(10,9,16,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);

    // stars
    for (let i = 0; i < 40; i++) this.sprite('sparkle', r() * W, r() * H * 0.7, 3 + r() * 5, '#8f87b0');

    // keep the art in the margins beside the content column, as the GPU world does
    const el = document.querySelector('main .wrap') || document.querySelector('.wrap'), rect = el?.getBoundingClientRect();
    const half = rect && rect.width > 200 ? rect.width / 2 : Math.min(W, 1240) / 2, margin = Math.max(0, W / 2 - half), roomy = margin > 160;
    x.globalAlpha = 0.5; // set dressing: the planet, floor and props sit well below the page
    if (!work) { const R = roomy ? Math.min(90, margin * 0.3) : 32; this.planet(roomy ? W - margin / 2 : W - R * 0.4, roomy ? H * 0.24 : R * 0.9 + 60, R); }
    else this.floor(W, H);

    // props down both sides, where the content column leaves room
    const kinds: [SpriteKind | 'gear' | 'block' | 'cloud', string][] = work
      ? [['gear', palette.accent], ['block', palette.hot], ['gear', palette.cyan], ['block', palette.gold]]
      : [['gem', palette.accent], ['coin', palette.gold], ['gem', palette.cyan], ['star', palette.gold]];
    const n = W < 700 ? 2 : kinds.length;
    for (let i = 0; i < n; i++) {
      const [k, c] = kinds[i], left = i % 2 === 0;
      const off = margin >= 90 ? margin * (0.3 + r() * 0.4) : 6 + r() * 12;
      const px = left ? off : W - off, py = H * (0.3 + (i / n) * 0.65 + (r() - 0.5) * 0.06);
      const s = (k === 'cloud' ? 60 : 30) * (0.8 + r() * 0.4) * (margin >= 90 ? Math.min(1.2, margin / 140) : 0.5);
      if (k === 'gear') this.gear(px, py, s * 0.5, c, r() * 6);
      else if (k === 'block') this.block(px, py, s * 0.75, c, (r() - 0.5) * 0.5);
      else if (k === 'cloud') this.cloud(px, py, s, c, r);
      else this.sprite(k, px, py, s, c);
    }
    x.globalAlpha = 1;
    document.documentElement.dataset.fxLive = '1';
    this.stats.paints++; this.stats.ms = Math.round((performance.now() - t0) * 10) / 10;
  }

  private sprite(k: SpriteKind, px: number, py: number, s: number, tint: string) { const x = this.x; x.save(); x.translate(px, py); paintSprite(x, k, s, tint); x.restore(); }

  private planet(cx: number, cy: number, R: number) {
    const x = this.x, cols = ['#3b2370', palette.violet, '#c25bd6', palette.hot, '#6b4fd8'];
    x.save(); x.translate(cx, cy); x.rotate(0.28);
    const ring = (front: boolean) => { x.beginPath(); x.ellipse(0, 0, R * 1.85, R * 0.42, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2); x.lineWidth = R * 0.28; x.strokeStyle = 'rgba(169,156,255,.55)'; x.stroke(); x.lineWidth = R * 0.07; x.strokeStyle = 'rgba(63,224,255,.6)'; x.stroke(); };
    ring(false);
    x.save(); x.beginPath(); x.arc(0, 0, R, 0, Math.PI * 2); x.clip();
    for (let i = 0; i < 9; i++) { x.fillStyle = cols[i % cols.length]; x.fillRect(-R, -R + (i * 2 * R) / 9 - 1, 2 * R, (2 * R) / 9 + 2); }
    x.fillStyle = 'rgba(20,12,38,.45)'; x.beginPath(); x.arc(R * 0.45, R * 0.4, R * 1.05, 0, Math.PI * 2); x.arc(-R * 0.2, -R * 0.2, R * 1.2, 0, Math.PI * 2, true); x.fill('evenodd'); // the cel shadow
    x.fillStyle = palette.gold; x.beginPath(); x.ellipse(R * 0.25, R * 0.2, R * 0.16, R * 0.09, 0, 0, Math.PI * 2); x.fill();
    x.restore();
    x.beginPath(); x.arc(0, 0, R, 0, Math.PI * 2); x.lineWidth = Math.max(3, R * 0.05); x.strokeStyle = OUTLINE; x.stroke();
    x.beginPath(); x.arc(0, 0, R * 0.96, Math.PI * 1.05, Math.PI * 1.45); x.lineWidth = R * 0.05; x.strokeStyle = 'rgba(63,224,255,.8)'; x.stroke(); // rim light
    ring(true);
    x.restore();
  }
  private cloud(cx: number, cy: number, s: number, c: string, r: () => number) {
    const x = this.x, n = 4 + Math.floor(r() * 2), pts: [number, number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([cx + (i - (n - 1) / 2) * s * 0.32, cy - Math.sin((i / (n - 1)) * Math.PI) * s * 0.18, s * (0.24 + 0.1 * Math.sin((i / (n - 1)) * Math.PI))]);
    const blob = () => { x.beginPath(); for (const [px, py, rr] of pts) { x.moveTo(px + rr, py); x.arc(px, py, rr, 0, Math.PI * 2); } x.rect(pts[0][0], cy - s * 0.05, pts[n - 1][0] - pts[0][0], s * 0.24); };
    x.save(); blob(); x.lineWidth = 6; x.strokeStyle = OUTLINE; x.lineJoin = 'round'; x.stroke(); x.fillStyle = c; x.fill(); x.clip();
    x.fillStyle = shade(c, -0.25); x.fillRect(cx - s, cy + s * 0.06, s * 2, s); x.restore();
  }
  private gear(cx: number, cy: number, R: number, c: string, rot: number) {
    const x = this.x, teeth = 10, inner = R * 0.8;
    x.save(); x.translate(cx, cy); x.rotate(rot); x.beginPath();
    for (let i = 0; i < teeth; i++) { const a = (i / teeth) * Math.PI * 2, st = (Math.PI * 2) / teeth; [[inner, a], [R, a + st * 0.12], [R, a + st * 0.42], [inner, a + st * 0.54]].forEach(([rr, t], k) => (i || k ? x.lineTo : x.moveTo).call(x, Math.cos(t) * rr, Math.sin(t) * rr)); }
    x.closePath(); x.moveTo(R * 0.28, 0); x.arc(0, 0, R * 0.28, 0, Math.PI * 2, true);
    const g = x.createLinearGradient(0, -R, 0, R); g.addColorStop(0, shade(c, 0.3)); g.addColorStop(0.5, c); g.addColorStop(0.51, shade(c, -0.25)); g.addColorStop(1, shade(c, -0.3));
    x.fillStyle = g; x.fill('evenodd'); x.lineWidth = 4; x.strokeStyle = OUTLINE; x.lineJoin = 'round'; x.stroke(); x.restore();
  }
  private block(cx: number, cy: number, s: number, c: string, rot: number) {
    const x = this.x, h = s / 2, rr = s * 0.18;
    x.save(); x.translate(cx, cy); x.rotate(rot);
    x.beginPath(); x.moveTo(-h + rr, -h); x.arcTo(h, -h, h, h, rr); x.arcTo(h, h, -h, h, rr); x.arcTo(-h, h, -h, -h, rr); x.arcTo(-h, -h, h, -h, rr); x.closePath();
    x.fillStyle = c; x.fill(); x.save(); x.clip(); x.fillStyle = shade(c, -0.25); x.fillRect(-h, h * 0.35, s, s); x.fillStyle = shade(c, 0.3); x.fillRect(-h, -h, s, s * 0.14); x.restore();
    x.lineWidth = 4; x.strokeStyle = OUTLINE; x.stroke();
    x.beginPath(); x.arc(0, -h * 0.1, s * 0.16, 0, Math.PI * 2); x.fillStyle = shade(c, 0.35); x.fill(); x.lineWidth = 2.5; x.stroke();
    x.restore();
  }
  private floor(W: number, H: number) {
    const x = this.x, hy = H * 0.72;
    x.save(); x.globalAlpha = 0.28; x.lineWidth = 1;
    for (let i = 0; i <= 16; i++) { const k = i / 16; x.strokeStyle = i % 4 ? 'rgba(139,107,255,.35)' : 'rgba(198,255,61,.45)'; x.beginPath(); x.moveTo(W / 2 + (k - 0.5) * W * 0.3, hy); x.lineTo(W / 2 + (k - 0.5) * W * 3, H); x.stroke(); }
    for (let i = 1; i < 9; i++) { const y = hy + (H - hy) * Math.pow(i / 8, 1.8); x.strokeStyle = i % 4 ? 'rgba(139,107,255,.3)' : 'rgba(198,255,61,.4)'; x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); }
    x.restore();
  }
}

function mixHex(a: string, b: string, k: number) {
  const p = (h: string) => { if (h.startsWith('rgb')) return h.match(/\d+/g)!.map(Number); const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const A = p(a), B = p(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`;
}
