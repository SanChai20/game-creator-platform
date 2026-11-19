// Creator feedback: what a creator captures while playing their preview (an annotated screenshot and a note) and their
// agent reads with creator_feedback. The rules for what an item may hold live here, as plain functions, so the Worker
// (src/feedback.ts) and tests/feedback.mjs share them. Everything coming from the browser is checked and cut to size:
// the picture by its bytes (JPEG or PNG only, never trusted by its declared type), the note, the marks and the context.

export const FEEDBACK_LIMITS = {
  image_bytes: 1_500_000,      // one annotated picture (the console sends a JPEG of at most 1600 px)
  image_side: 2560,            // pixels on the longest side
  note_chars: 2000,
  mark_label_chars: 200,
  marks: 30,
  pen_points: 200,
  errors: 10,
  error_chars: 300,
  state_chars: 4000,           // what the game's GCP.test.onState(fn) returned, as JSON
  read_max: 5,                 // items one creator_feedback call returns (with their pictures)
};
export const MARK_TYPES = ['circle', 'arrow', 'box', 'pen'];

export class FeedbackError extends Error {
  constructor(message) { super(message); this.name = 'FeedbackError'; }
}
const fail = (m) => { throw new FeedbackError(m); };

/** Width and height of a PNG or JPEG from its bytes, with its type, or null when it is neither. */
export function imageInfo(b) {
  if (!(b instanceof Uint8Array) || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    return { type: 'image/png', width: u32(16), height: u32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      // start of frame (baseline, progressive, …), not DHT (c4), JPG (c8) or DAC (cc)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'image/jpeg', height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** Decodes a data URL or bare base64 into checked picture bytes: { bytes, type, width, height }. */
export function parseImage(input) {
  if (typeof input !== 'string' || !input) fail('image is required: the annotated screenshot as a data URL (JPEG or PNG).');
  const m = input.match(/^data:image\/(?:jpeg|png);base64,/);
  const b64 = m ? input.slice(m[0].length) : input;
  if (b64.length > Math.ceil(FEEDBACK_LIMITS.image_bytes / 3) * 4 + 4) fail(`The screenshot is larger than ${Math.round(FEEDBACK_LIMITS.image_bytes / 1e5) / 10} MB.`);
  let bytes;
  try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
  catch { fail('The screenshot is not valid base64.'); }
  const info = imageInfo(bytes);
  if (!info) fail('The screenshot must be a JPEG or PNG picture.');
  if (!info.width || !info.height || info.width > FEEDBACK_LIMITS.image_side || info.height > FEEDBACK_LIMITS.image_side) fail(`The screenshot must be at most ${FEEDBACK_LIMITS.image_side} pixels on each side.`);
  return { bytes, ...info };
}

const str = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const unit = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000 : null; };

/** The note the creator wrote. */
export function cleanNote(v) { return str(v, FEEDBACK_LIMITS.note_chars); }

/**
 * The shapes drawn on the picture, in picture fractions (0..1) so they hold at any size:
 * circle and box { x, y, w, h } (the box the shape fills), arrow { x1, y1, x2, y2 } (pointing at x2, y2), pen { points: [[x, y]…] }.
 * Each gets its number n (1, 2, 3…, as drawn on the picture) and an optional label.
 */
export function cleanMarks(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('marks must be a list.');
  if (v.length > FEEDBACK_LIMITS.marks) fail(`At most ${FEEDBACK_LIMITS.marks} marks on one screenshot.`);
  return v.map((m, i) => {
    if (!m || typeof m !== 'object' || !MARK_TYPES.includes(m.type)) fail(`Mark ${i + 1} must be one of: ${MARK_TYPES.join(', ')}.`);
    const out = { n: i + 1, type: m.type };
    if (m.type === 'arrow') {
      for (const k of ['x1', 'y1', 'x2', 'y2']) { const n = unit(m[k]); if (n === null) fail(`Mark ${i + 1} needs ${k}.`); out[k] = n; }
    } else if (m.type === 'pen') {
      if (!Array.isArray(m.points) || m.points.length < 2) fail(`Mark ${i + 1} needs at least two points.`);
      const pts = m.points.slice(0, 2000), step = Math.max(1, Math.ceil(pts.length / FEEDBACK_LIMITS.pen_points));
      out.points = pts.filter((_, j) => j % step === 0 || j === pts.length - 1).map((p) => [unit(p?.[0]) ?? 0, unit(p?.[1]) ?? 0]).slice(0, FEEDBACK_LIMITS.pen_points);
    } else {
      for (const k of ['x', 'y', 'w', 'h']) { const n = unit(m[k]); if (n === null) fail(`Mark ${i + 1} needs ${k}.`); out[k] = n; }
    }
    const label = str(m.label, FEEDBACK_LIMITS.mark_label_chars);
    if (label) out.label = label;
    return out;
  });
}

/**
 * What the console knew when the picture was taken. Only these fields are kept, each cut to size; the page address is
 * never stored (it can carry a play token).
 */
export function cleanContext(v) {
  const c = v && typeof v === 'object' ? v : {};
  const out = { method: ['screen', 'page', 'upload'].includes(c.method) ? c.method : 'game' };
  const int = (x, max) => { const n = Math.round(Number(x)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : undefined; };
  const vw = int(c.viewport?.width, 10000), vh = int(c.viewport?.height, 10000);
  if (vw && vh) out.viewport = { width: vw, height: vh };
  for (const k of ['frames', 'fps', 'played_ms']) { const n = int(c[k], 1e9); if (n !== undefined) out[k] = n; }
  if (typeof c.ready === 'boolean') out.ready = c.ready;
  if (typeof c.fullscreen === 'boolean') out.fullscreen = c.fullscreen;
  if (typeof c.touch === 'boolean') out.touch = c.touch;
  const dpr = Number(c.dpr); if (Number.isFinite(dpr) && dpr > 0 && dpr <= 8) out.dpr = Math.round(dpr * 100) / 100;
  // how an exact picture was cut from the browser's tab capture (web/src/capture.ts), kept to explain a picture that is off
  const k = c.capture;
  if (out.method === 'screen' && k && typeof k === 'object') {
    const nums = (x, n) => (Array.isArray(x) && x.length === n && x.every((v) => Number.isFinite(Number(v))) ? x.map((v) => Math.max(-1e5, Math.min(1e5, Math.round(Number(v))))) : undefined);
    const cap = {};
    for (const [key, n] of [['view', 2], ['frame', 2], ['crop', 4]]) { const v = nums(k[key], n); if (v) cap[key] = v; }
    for (const key of ['dpr', 'k', 'zoom']) { const v = Number(k[key]); if (Number.isFinite(v) && v > 0 && v < 100) cap[key] = Math.round(v * 1000) / 1000; }
    const w = int(k.waited_ms, 60000); if (w !== undefined) cap.waited_ms = w;
    if (k.trimmed === true) cap.trimmed = true;
    if (k.mismatch === true) cap.mismatch = true;
    if (Object.keys(cap).length) out.capture = cap;
  }
  const lang = str(c.lang, 12); if (lang) out.lang = lang;
  const browser = str(c.browser, 160); if (browser) out.browser = browser;
  const label = str(c.label, 120); if (label) out.label = label;
  const list = (x) => (Array.isArray(x) ? x.slice(0, FEEDBACK_LIMITS.errors).map((e) => str(e, FEEDBACK_LIMITS.error_chars)).filter(Boolean) : []);
  const errors = list(c.errors), warnings = list(c.warnings);
  if (errors.length) out.errors = errors;
  if (warnings.length) out.warnings = warnings;
  if (c.state !== undefined && c.state !== null) {
    let s = typeof c.state === 'string' ? c.state : (() => { try { return JSON.stringify(c.state); } catch { return ''; } })();
    s = str(s, FEEDBACK_LIMITS.state_chars);
    if (s) out.state = s;
  }
  return out;
}

const px = (f, size) => Math.round(f * size);
/**
 * The marks in words, in pixels of the picture, for an agent reading the item. With `game` (the game's viewport in CSS
 * pixels, for a picture of the whole game) each mark also says where it is in the game's own coordinates, the ones
 * debug_preview clicks and taps take.
 */
export function describeMarks(marks, width, height, game) {
  const g = game && game.width > 0 && game.height > 0 ? game : null;
  const at = (fx, fy) => (g ? ` [game (${px(fx, g.width)}, ${px(fy, g.height)})]` : '');
  return (marks || []).map((m) => {
    const label = m.label ? `: "${m.label}"` : '';
    if (m.type === 'arrow') return `${m.n}. arrow from (${px(m.x1, width)}, ${px(m.y1, height)}) pointing at (${px(m.x2, width)}, ${px(m.y2, height)})${at(m.x2, m.y2)}${label}`;
    if (m.type === 'pen') {
      const xs = m.points.map((p) => p[0]), ys = m.points.map((p) => p[1]);
      return `${m.n}. freehand line around x ${px(Math.min(...xs), width)} to ${px(Math.max(...xs), width)}, y ${px(Math.min(...ys), height)} to ${px(Math.max(...ys), height)}${at((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2)}${label}`;
    }
    const cx = px(m.x + m.w / 2, width), cy = px(m.y + m.h / 2, height);
    return `${m.n}. ${m.type === 'circle' ? 'circle' : 'box'} around (${cx}, ${cy}), ${px(m.w, width)} × ${px(m.h, height)} px${at(m.x + m.w / 2, m.y + m.h / 2)}${label}`;
  });
}
