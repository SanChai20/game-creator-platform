// What a store cover needs, and a cheap check of an uploaded one. The numbers come from how the store crops covers:
// the home page banner shows the cover in the right 60% of its box, cropped to about 1.1:1 to 1.4:1 and with a
// slanted info panel over its left edge, so the left ~30% of a 16:9 cover is hidden there (19% at the bottom) and the
// right ~19% is cut in the narrowest banner; cards crop to 16:10 (sides lose 5.6%), wide shelves to 16:7 (top and
// bottom lose 11%), and the phone banner clips the bottom-right corner. The safe area is what survives every crop.

export const COVER = {
  width: 1920, height: 1080, min_width: 1280, min_height: 720, max_bytes: 2 * 1024 * 1024,
  /** fractions of the image: the title and the main subject stay inside */
  safe: { x0: 0.30, x1: 0.80, y0: 0.12, y1: 0.861 },
  guide: '/guides/game-metadata.md#cover-image',
  template: '/guides/cover-template.png',
};

const pct = (f) => `${Math.round(f * 100)}%`;
const px = (f, n) => Math.round(f * n);

/** The cover rules in one paragraph, for tool descriptions and answers. */
export function coverRules(origin = '') {
  const s = COVER.safe;
  return `A cover is a designed 16:9 image, ${COVER.width}x${COVER.height} (at least ${COVER.min_width}x${COVER.min_height}), png, jpg or webp under 2 MB. ` +
    `The store crops it differently everywhere, so keep the title and the main subject inside the safe area: x ${pct(s.x0)} to ${pct(s.x1)}, y ${pct(s.y0)} to ${pct(s.y1)} ` +
    `(${px(s.x0, COVER.width)} to ${px(s.x1, COVER.width)} px across and ${px(s.y0, COVER.height)} to ${px(s.y1, COVER.height)} px down at 1920x1080). ` +
    'The left 30% is hidden behind the home page banner\'s info panel, so put only background there: no title, no faces. ' +
    'Set the title large (cap height at least 90 px at 1080 high, readable when the cover is 240 px wide), centred in the safe area or in its lower third, with no frame or text near the edges. ' +
    'Show whole characters in a wide scene rather than close-ups. When the title is text, give each listing language its own cover (covers). ' +
    `Before setting it, look at it cropped to the banner (the safe area), to 16:10 and 16:7, and at 240 px wide. Template with the crops drawn on it: ${origin}${COVER.template} (also the MCP resource gcp://templates/cover); guide: ${origin}${COVER.guide}.`;
}

/** Width and height of a png, jpeg or webp from its bytes, or null. */
export function imageSize(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const be16 = (i) => (u[i] << 8) | u[i + 1], le16 = (i) => u[i] | (u[i + 1] << 8), le24 = (i) => u[i] | (u[i + 1] << 8) | (u[i + 2] << 16);
  if (u.length > 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), type: 'png' };
  }
  if (u.length > 4 && u[0] === 0xff && u[1] === 0xd8) {
    let p = 2;
    while (p + 9 < u.length) {
      if (u[p] !== 0xff) { p++; continue; }
      const m = u[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      const len = be16(p + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: be16(p + 7), height: be16(p + 5), type: 'jpeg' };
      p += 2 + len;
    }
    return null;
  }
  if (u.length > 30 && String.fromCharCode(...u.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...u.subarray(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...u.subarray(12, 16));
    if (kind === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1, type: 'webp' };
    if (kind === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff, type: 'webp' };
    if (kind === 'VP8L') { const b = u.subarray(21, 25); return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)), type: 'webp' }; }
  }
  return null;
}

/**
 * What the platform can tell about a cover from its size: problems that make the store stretch or blur it.
 * The composition (title and subject inside the safe area) is for the agent to check by looking at the crops.
 */
export function checkCover(buf) {
  const size = imageSize(buf), notes = [];
  if (!size) return { size: null, ok: false, notes: ['The platform could not read the image size; save it as a standard png, jpg or webp.'] };
  const { width: w, height: h } = size, ratio = w / h;
  if (Math.abs(ratio - 16 / 9) > 0.03) notes.push(`It is ${w}x${h} (${ratio.toFixed(2)}:1), not 16:9. The store crops it to fit, which cuts more than the safe area allows; make it ${COVER.width}x${COVER.height}.`);
  if (w < COVER.min_width || h < COVER.min_height) notes.push(`It is ${w}x${h}, smaller than ${COVER.min_width}x${COVER.min_height}, so it looks soft in the home page banner; make it ${COVER.width}x${COVER.height}.`);
  return { size: `${w}x${h}`, ok: !notes.length, notes };
}

/** The pixel rectangle of the safe area for an image of this size. */
export function safeRect(w = COVER.width, h = COVER.height) {
  const s = COVER.safe;
  return { left: px(s.x0, w), right: px(s.x1, w), top: px(s.y0, h), bottom: px(s.y1, h) };
}
