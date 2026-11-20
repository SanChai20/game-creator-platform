// How a game's file is read from R2 for its game Worker (src/routes/rt.ts, /api/rt/file). No imports, so the tests load it.

/** The R2 read options for a file request: an ETag condition and a single byte range, parsed from the request's headers. */
export function readOptions(h: Headers): { onlyIf?: R2Conditional; range?: R2Range } {
  const out: { onlyIf?: R2Conditional; range?: R2Range } = {};
  const tag = (v: string | null) => { const t = (v || '').split(',')[0].trim(); return !t || t === '*' ? '' : t.replace(/^W\//, '').replace(/^"|"$/g, ''); };
  const none = tag(h.get('if-none-match')), match = tag(h.get('if-match'));
  if (none || match) out.onlyIf = { ...(none ? { etagDoesNotMatch: none } : {}), ...(match ? { etagMatches: match } : {}) };
  const m = /^bytes=(\d*)-(\d*)$/.exec((h.get('range') || '').trim());
  if (m && (m[1] || m[2])) {
    if (!m[1]) out.range = { suffix: Number(m[2]) };
    else out.range = m[2] ? { offset: Number(m[1]), length: Math.max(0, Number(m[2]) - Number(m[1]) + 1) } : { offset: Number(m[1]) };
  }
  return out;
}
