// Working on one game from more than one machine (pull_version, checkout_version, diff_versions and deploy_preview's
// base_version in src/mcp/tools.ts). Every version is a complete frozen copy of the files an agent uploaded, so another
// agent signed in to the same account can download any version, change it and deploy again. What this file decides:
// what changed between two file lists, whether a deploy built on an older version would silently drop someone else's
// newer one, and a line diff of a text file. No imports, so tests/version-sync.mjs loads it as it is.

export interface FileSig { path: string; size: number; sha: string }
export interface FileChange { path: string; bytes_before?: number; bytes_after?: number }
export interface FileDiff { added: FileChange[]; removed: FileChange[]; changed: FileChange[]; unchanged: number }

/** What changed from one list of files to another, by content hash (the same hash list_files shows). */
export function diffFiles(before: FileSig[], after: FileSig[]): FileDiff {
  const a = new Map(before.map((f) => [f.path, f])), b = new Map(after.map((f) => [f.path, f]));
  const out: FileDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [path, f] of b) {
    const old = a.get(path);
    if (!old) out.added.push({ path, bytes_after: f.size });
    else if (old.sha !== f.sha) out.changed.push({ path, bytes_before: old.size, bytes_after: f.size });
    else out.unchanged++;
  }
  for (const [path, f] of a) if (!b.has(path)) out.removed.push({ path, bytes_before: f.size });
  const byPath = (x: FileChange, y: FileChange) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);
  out.added.sort(byPath); out.removed.sort(byPath); out.changed.sort(byPath);
  return out;
}

export const isSame = (d: FileDiff) => !d.added.length && !d.removed.length && !d.changed.length;

/** One line per kind of change, e.g. "2 changed (src/game.js, index.html), 1 added (art/boss.png)". */
export function diffLine(d: FileDiff, max = 6): string {
  const part = (n: string, l: FileChange[]) => (l.length ? `${l.length} ${n} (${l.slice(0, max).map((f) => f.path).join(', ')}${l.length > max ? ', …' : ''})` : '');
  return [part('changed', d.changed), part('added', d.added), part('removed', d.removed)].filter(Boolean).join(', ') || 'no file changed';
}

export interface VersionLite { n: number; note?: string; actor?: string; created_at?: number }
export type BaseVerdict =
  | { ok: true }
  | { ok: false; code: 'unknown_base' | 'stale_base'; newest: number; newer: VersionLite[]; message: string };

/**
 * A deploy that says which version its changes start from (base_version) goes ahead only when that is still the newest
 * version, as a push to a branch someone else moved is refused: otherwise the other agent's newer version would be
 * silently left out of this one. `newest` is the project's newest version number (0 for none yet).
 */
export function checkBase(base: number, newest: number, newer: VersionLite[]): BaseVerdict {
  if (!Number.isInteger(base) || base < 0 || base > newest) {
    return { ok: false, code: 'unknown_base', newest, newer: [], message: `base_version ${base} does not exist: the newest version of this game is ${newest || 'none yet (use 0)'}.` };
  }
  if (base === newest) return { ok: true };
  const list = newer.filter((v) => v.n > base).sort((x, y) => x.n - y.n);
  const who = (v: VersionLite) => `version ${v.n}${v.actor ? ` by ${v.actor}` : ''}${v.created_at ? ` at ${new Date(v.created_at).toISOString()}` : ''}${v.note ? ` ("${v.note}")` : ''}`;
  return {
    ok: false, code: 'stale_base', newest, newer: list,
    message: `Your changes start from version ${base}, but ${list.length === 1 ? 'a newer version was' : `${newest - base} newer versions were`} deployed since: ${list.map(who).join('; ')}. Deploying now would leave ${list.length === 1 ? 'its' : 'their'} changes out.`,
  };
}

/** A unified diff of two texts (3 lines of context), or null when the texts are too big to diff here. */
export function textDiff(a: string, b: string, path: string, opts: { context?: number; maxCells?: number; maxLines?: number } = {}): { diff: string; truncated: boolean } | null {
  const ctx = opts.context ?? 3, maxCells = opts.maxCells ?? 4_000_000, maxLines = opts.maxLines ?? 400;
  const A = a.split('\n'), B = b.split('\n');
  // common start and end first, so a small edit in a big file only diffs the middle
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const x = A.slice(pre, A.length - suf), y = B.slice(pre, B.length - suf);
  if ((x.length + 1) * (y.length + 1) > maxCells) return null;
  // longest common subsequence of the middle
  const w = y.length + 1, L = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  }
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', s: A[k], ai: k, bi: k });
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push({ t: ' ', s: x[i], ai: pre + i, bi: pre + j }); i++; j++; }
    else if (i < x.length && (j >= y.length || L[(i + 1) * w + j] >= L[i * w + j + 1])) { ops.push({ t: '-', s: x[i], ai: pre + i, bi: pre + j }); i++; }
    else { ops.push({ t: '+', s: y[j], ai: pre + i, bi: pre + j }); j++; }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', s: A[A.length - suf + k], ai: A.length - suf + k, bi: B.length - suf + k });
  // hunks: changed lines with `ctx` lines around them
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let truncated = false, k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue; }
    const start = Math.max(0, k - ctx);
    let end = k;
    for (;;) {   // extend over changes closer than 2*ctx lines apart
      while (end < ops.length && ops[end].t !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next].t === ' ' && next - end < 2 * ctx) next++;
      if (next < ops.length && ops[next].t !== ' ') { end = next; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + ctx), h = ops.slice(start, stop);
    const aLen = h.filter((o) => o.t !== '+').length, bLen = h.filter((o) => o.t !== '-').length;
    lines.push(`@@ -${h[0].ai + (aLen ? 1 : 0)},${aLen} +${h[0].bi + (bLen ? 1 : 0)},${bLen} @@`);
    for (const o of h) lines.push(o.t + o.s);
    if (lines.length > maxLines) { truncated = true; break; }
    k = stop;
  }
  if (lines.length > maxLines) { lines.length = maxLines; truncated = true; }
  return { diff: lines.join('\n'), truncated };
}
