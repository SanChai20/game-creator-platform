// Duplication checks without AI: fingerprints of a game's own code that survive renamed variables and moved
// whitespace, the files it shares byte for byte, and a perceptual hash of how it looks. Plus a rule-based answer
// to "is this upload a game at all". Plain JavaScript so node tests can import it directly.
import { tokenizer } from 'acorn';

const K = 24, W = 24;                     // k-gram length in tokens and winnowing window
export const SKETCH = 64;                  // fingerprints per game kept in the candidate index
export const MAX_PRINTS = 6000;            // fingerprints stored per version (the smallest hashes, consistently)

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h | 0; };

/** Tokens with names, strings and numbers folded, so renaming variables or changing constants does not hide a copy. */
export function tokens(src) {
  const out = [];
  try {
    for (const t of tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true })) {
      const label = t.type.label;
      out.push(label === 'name' ? 'v' : label === 'string' ? 's' : label === 'num' || label === 'bigint' ? 'n' : label === 'template' ? 't' : label === 'regexp' ? 'r' : t.type.keyword || label);
    }
    return out;
  } catch {
    // not parseable as JavaScript: fall back to a plain word and punctuation split
    return (src.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) || []).map((x) => (/^[A-Za-z_$]/.test(x) ? (KEYWORDS.has(x) ? x : 'v') : /^\d/.test(x) ? 'n' : x));
  }
}
const KEYWORDS = new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of'.split(' '));

/** Inline scripts of an HTML page (external ones are separate files). */
export const inlineScripts = (html) => [...String(html).matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((s) => s.trim() && !/^\s*\{\s*"imports"/.test(s));

/** Winnowed fingerprints of one source text (a set of 32-bit integers). */
export function fingerprints(src) {
  const tk = tokens(src), hashes = [];
  for (let i = 0; i + K <= tk.length; i++) hashes.push(fnv(tk.slice(i, i + K).join(' ')));
  const out = new Set();
  if (hashes.length <= W) { if (hashes.length) out.add(Math.min(...hashes)); return out; }
  for (let i = 0; i + W <= hashes.length; i++) { let m = hashes[i]; for (let j = i + 1; j < i + W; j++) if (hashes[j] <= m) m = hashes[j]; out.add(m); }
  return out;
}

/** Fingerprints of a whole bundle's own code (vendor files are left out by the caller), minus a baseline (templates, kits). */
export function bundlePrints(texts, baseline) {
  const all = new Set();
  for (const { path, text } of texts) {
    const parts = /\.html?$/i.test(path) ? inlineScripts(text) : [text];
    for (const p of parts) for (const h of fingerprints(p)) if (!baseline || !baseline.has(h)) all.add(h);
  }
  return [...all].sort((a, b) => a - b).slice(0, MAX_PRINTS);
}

/** The candidate-index sketch: the smallest fingerprints, which similar sets tend to share. */
export const sketchOf = (prints) => prints.slice(0, SKETCH);

/** Share of a's fingerprints found in b, estimated on the hash range both stored sets fully cover. */
export function containment(a, b) {
  if (!a.length || !b.length) return 0;
  const cut = (x) => (x.length >= MAX_PRINTS ? x[x.length - 1] : Infinity), limit = Math.min(cut(a), cut(b)), B = new Set(b);
  let n = 0, hit = 0;
  for (const h of a) { if (h > limit) break; n++; if (B.has(h)) hit++; }
  return n ? hit / n : 0;
}

/** A 64-bit difference hash (hex) and the dominant coarse colours of a decoded picture { w, h, bpp, stride, px }. */
export function lookOf(img) {
  if (!img || !img.w || !img.h) return null;
  const { w, h, bpp, stride, px } = img, gw = 9, gh = 8, cells = new Float64Array(gw * gh), cn = new Uint32Array(gw * gh), pal = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = y * stride + x * bpp, r = px[i], g = px[i + 1], b = px[i + 2], c = Math.min(gh - 1, (y * gh / h) | 0) * gw + Math.min(gw - 1, (x * gw / w) | 0);
    cells[c] += 0.299 * r + 0.587 * g + 0.114 * b; cn[c]++;
    const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5); pal.set(k, (pal.get(k) || 0) + 1);
  }
  let bits = '';
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw - 1; x++) { const a = cells[y * gw + x] / Math.max(1, cn[y * gw + x]), b = cells[y * gw + x + 1] / Math.max(1, cn[y * gw + x + 1]); bits += a > b ? '1' : '0'; }
  let hex = ''; for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  const palette = [...pal].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  return { dhash: hex, palette };
}

export function lookDistance(a, b) {
  if (!a || !b || !a.dhash || !b.dhash) return 64;
  let d = 0; for (let i = 0; i < 16; i++) { let x = parseInt(a.dhash[i], 16) ^ parseInt(b.dhash[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
export const paletteOverlap = (a, b) => (a && b && a.palette && b.palette && a.palette.length ? a.palette.filter((c) => b.palette.includes(c)).length / a.palette.length : 0);

/**
 * How much of game A is in game B.
 * @param {{ prints: number[], files: string[], assets: string[], look: any }} a  the new version
 * @param {{ prints: number[], files: string[], assets: string[], look: any }} b  a published game by someone else
 */
export function compare(a, b) {
  const code = containment(a.prints, b.prints);
  const sameFiles = a.files.length ? a.files.filter((s) => b.files.includes(s)).length / a.files.length : 0;
  const assets = a.assets.length ? a.assets.filter((s) => b.assets.includes(s)).length / a.assets.length : 0;
  const dist = lookDistance(a.look, b.look), pal = paletteOverlap(a.look, b.look);
  const looksAlike = dist <= 10 && pal >= 0.5;
  const enough = a.prints.length >= 40;                 // a few lines of code say nothing either way
  let verdict = 'different';
  if ((enough && code >= 0.8) || sameFiles >= 0.8 || (enough && code >= 0.6 && (assets >= 0.5 || looksAlike)) || (assets >= 0.8 && a.assets.length >= 4 && looksAlike)) verdict = 'copy';
  else if ((enough && code >= 0.35) || (assets >= 0.5 && a.assets.length >= 3) || (looksAlike && enough && code >= 0.2) || sameFiles >= 0.5) verdict = 'similar';
  return { verdict, code: Math.round(code * 100), same_files: Math.round(sameFiles * 100), assets: Math.round(assets * 100), look_distance: dist, palette_overlap: Math.round(pal * 100), looks_alike: looksAlike };
}

const ENGINE_INPUT = /^(Unity|Godot|Construct|GameMaker|Defold|Cocos Creator|PlayCanvas|Phaser|Excalibur|KAPLAY \/ Kaboom|melonJS|LittleJS|Emscripten \/ WebAssembly)$/;
/**
 * Is it a game? From the build facts (analyzeBundle) and the verification report.
 * 'game' when the player can act on it, 'not_game' when nothing in it takes input, 'unsure' for pages that take
 * input but look like documents or forms (the AI step decides those when it is on).
 */
export function gameness(facts, report, html) {
  if (report && report.playthrough && report.playthrough.ok) return { verdict: 'game', reason: 'Its play-through hook played it to the end.' };
  if (ENGINE_INPUT.test(facts.engine)) return { verdict: 'game', reason: `Built with ${facts.engine}, a game engine.` };
  const interactive = facts.input.length > 0 || /<button\b|onclick=|<input\b/i.test(html || '');
  if (!interactive) return { verdict: 'not_game', reason: 'Nothing in it responds to the player: no keyboard, mouse, touch, pointer or gamepad input and no buttons.' };
  const drawn = facts.rendering.some((r) => /WebGL|WebGPU|Canvas/.test(r)), looped = facts.loop_and_performance.includes('requestAnimationFrame loop');
  if (drawn || looped) return { verdict: 'game', reason: 'It draws frames in a loop and responds to input.' };
  const forms = (String(html || '').match(/<input\b[^>]*type=["']?(?:email|password|tel)|<form\b/gi) || []).length;
  return { verdict: 'unsure', reason: forms ? 'A page with forms and no game loop.' : 'An interactive page with no canvas and no game loop.' };
}
