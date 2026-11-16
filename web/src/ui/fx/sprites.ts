// Cartoon sprites, drawn in code at start-up: no image files. Each one is a flat shape with a thick dark outline,
// a lighter top highlight and a darker underside (classic two-tone cel shading), in the brand colours. They are
// painted once into an atlas canvas at the device's pixel density and reused by the particle overlay and, as a
// texture, by the Three.js world.
import { palette } from './gl';
import { color } from '../tokens';

export type SpriteKind = 'star' | 'coin' | 'sparkle' | 'heart' | 'gem' | 'plus' | 'bolt';
export const SPRITES: SpriteKind[] = ['star', 'coin', 'sparkle', 'heart', 'gem', 'plus', 'bolt'];
const OUTLINE = color.ink;

/** Mixes a hex colour toward white (k > 0) or black (k < 0). */
export function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const m = c.map((v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}

type Ctx = CanvasRenderingContext2D;
function starPath(x: Ctx, r: number, points: number, inner: number) {
  x.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points, rr = i % 2 ? r * inner : r;
    i ? x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : x.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  x.closePath();
}
/** Fill with a two-tone cel ramp (light top, base, dark bottom), then the thick outline on top. */
function cel(x: Ctx, r: number, base: string, lw: number) {
  const g = x.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, shade(base, 0.45)); g.addColorStop(0.42, shade(base, 0.12)); g.addColorStop(0.43, base); g.addColorStop(0.72, base); g.addColorStop(0.73, shade(base, -0.22)); g.addColorStop(1, shade(base, -0.3));
  x.fillStyle = g; x.fill();
  x.lineJoin = 'round'; x.lineWidth = lw; x.strokeStyle = OUTLINE; x.stroke();
}
function shine(x: Ctx, cx: number, cy: number, rx: number, ry: number, rot = -0.6) {
  x.save(); x.fillStyle = 'rgba(255,255,255,.85)'; x.beginPath(); x.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2); x.fill(); x.restore();
}

/** Paints one sprite centred at the origin, filling a box of size s. */
export function paintSprite(x: Ctx, kind: SpriteKind, s: number, tint?: string) {
  const r = s * 0.42, lw = Math.max(2, s * 0.07);
  switch (kind) {
    case 'star': starPath(x, r, 5, 0.5); cel(x, r, tint || palette.gold, lw); shine(x, -r * 0.18, -r * 0.38, r * 0.16, r * 0.08); break;
    case 'coin': {
      x.beginPath(); x.ellipse(0, 0, r * 0.92, r, 0, 0, Math.PI * 2); cel(x, r, tint || palette.gold, lw);
      x.beginPath(); x.ellipse(0, 0, r * 0.58, r * 0.66, 0, 0, Math.PI * 2); x.lineWidth = lw * 0.6; x.strokeStyle = shade(tint || palette.gold, -0.35); x.stroke();
      x.save(); x.scale(0.55, 0.55); starPath(x, r * 0.8, 5, 0.5); x.fillStyle = shade(tint || palette.gold, -0.28); x.fill(); x.restore();
      shine(x, -r * 0.42, -r * 0.42, r * 0.14, r * 0.26, 0.5); break;
    }
    case 'sparkle': starPath(x, r, 4, 0.28); x.fillStyle = tint || '#ffffff'; x.fill(); x.lineWidth = lw * 0.7; x.strokeStyle = OUTLINE; x.lineJoin = 'round'; x.stroke(); break;
    case 'heart': {
      x.beginPath(); x.moveTo(0, r * 0.85);
      x.bezierCurveTo(-r * 1.25, -r * 0.05, -r * 0.55, -r * 1.05, 0, -r * 0.4);
      x.bezierCurveTo(r * 0.55, -r * 1.05, r * 1.25, -r * 0.05, 0, r * 0.85); x.closePath();
      cel(x, r, tint || palette.hot, lw); shine(x, -r * 0.45, -r * 0.4, r * 0.14, r * 0.09); break;
    }
    case 'gem': {
      x.beginPath(); x.moveTo(0, -r); x.lineTo(r * 0.8, -r * 0.25); x.lineTo(0, r); x.lineTo(-r * 0.8, -r * 0.25); x.closePath();
      cel(x, r, tint || palette.cyan, lw);
      x.beginPath(); x.moveTo(-r * 0.8, -r * 0.25); x.lineTo(r * 0.8, -r * 0.25); x.moveTo(0, -r); x.lineTo(0, r); x.lineWidth = lw * 0.45; x.strokeStyle = 'rgba(26,16,48,.55)'; x.stroke();
      shine(x, -r * 0.3, -r * 0.45, r * 0.1, r * 0.2, 0.7); break;
    }
    case 'plus': {
      const a = r * 0.34;
      x.beginPath(); x.moveTo(-a, -r); x.lineTo(a, -r); x.lineTo(a, -a); x.lineTo(r, -a); x.lineTo(r, a); x.lineTo(a, a); x.lineTo(a, r); x.lineTo(-a, r); x.lineTo(-a, a); x.lineTo(-r, a); x.lineTo(-r, -a); x.lineTo(-a, -a); x.closePath();
      cel(x, r, tint || palette.accent, lw); break;
    }
    case 'bolt': {
      x.beginPath(); x.moveTo(r * 0.2, -r); x.lineTo(-r * 0.6, r * 0.12); x.lineTo(-r * 0.02, r * 0.12); x.lineTo(-r * 0.25, r); x.lineTo(r * 0.62, -r * 0.18); x.lineTo(r * 0.04, -r * 0.18); x.closePath();
      cel(x, r, tint || palette.accent, lw); break;
    }
  }
}

export interface Atlas { canvas: HTMLCanvasElement; cell: number; index: Record<SpriteKind, number> }
/** All sprites in one row of square cells. */
export function buildAtlas(cell = 64): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = cell * SPRITES.length; canvas.height = cell;
  const x = canvas.getContext('2d')!;
  const index = {} as Record<SpriteKind, number>;
  SPRITES.forEach((k, i) => { index[k] = i; x.save(); x.translate(i * cell + cell / 2, cell / 2); paintSprite(x, k, cell); x.restore(); });
  return { canvas, cell, index };
}
