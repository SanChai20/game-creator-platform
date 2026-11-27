// The storage side of working on one game from more than one machine: a version's or the workspace's file list, reading
// their bytes, the zip a pull downloads, and putting a version's files back into the workspace (checkout_version). What
// is decided about them (what changed, whether a deploy's base is stale, line diffs) is in src/version-sync.ts.
import { Zip, ZipPassThrough } from 'fflate';
import { AppError, bad, type Env, type Project, type Version } from './env';
import { getVersion, listFiles, verKey, wsKey } from './projects';
import { getSettings } from './settings';
import { assertFits } from './storage';
import { now, parseJson } from './util';
import { diffFiles, diffLine, isSame, type FileDiff, type FileSig } from './version-sync';

/** Where a set of files comes from: a numbered version, or the workspace as it is now. */
/** ws: a branch's workspace ("<project>~<branch id>", src/collab.ts); without it, main's. label names it in answers. */
export type Source = { version: number } | { workspace: true; ws?: string; label?: string };
export const sourceName = (s: Source) => ('version' in s ? `version ${s.version}` : s.label ? `the workspace of ${s.label}` : 'the workspace');
const wsOf = (p: Project, s: { ws?: string }) => s.ws || p.id;

export async function versionOrThrow(env: Env, p: Project, n: number): Promise<Version> {
  const v = Number.isInteger(n) && n > 0 ? await getVersion(env, p.id, n) : null;
  if (!v) throw new AppError(404, `Version ${n} does not exist.`, 'not_found', `The newest version of this game is ${p.next_version - 1 || 'none yet'}. list_versions shows every version.`);
  return v;
}

export async function sourceFiles(env: Env, p: Project, s: Source): Promise<FileSig[]> {
  if ('workspace' in s) return (await listFiles(env, wsOf(p, s))).map((f) => ({ path: f.path, size: f.size, sha: f.sha }));
  return parseJson<FileSig[]>((await versionOrThrow(env, p, s.version)).files, []);
}

export const sourceKey = (p: Project, s: Source, path: string) => ('workspace' in s ? wsKey(wsOf(p, s), path) : verKey(p.id, s.version, path));

export async function readSourceFile(env: Env, p: Project, s: Source, path: string): Promise<R2ObjectBody | null> {
  return env.FILES.get(sourceKey(p, s, path));
}

/**
 * The workspace against the version it is based on: the version it last matched (deployed or checked out), or for a game
 * deployed before that was recorded, its newest version. diff is null when there is no version yet.
 */
export async function workspaceState(env: Env, p: Project, t?: { ws: string; base: number | null; newest: number }): Promise<{ base: number | null; newest: number; diff: FileDiff | null; files: number }> {
  const newest = t ? t.newest : await mainNewest(env, p), base = t ? t.base : p.ws_base ?? (newest || null), ws = await sourceFiles(env, p, { workspace: true, ws: t?.ws });
  const v = base ? await getVersion(env, p.id, base) : null;
  return { base: v ? base : null, newest, diff: v ? diffFiles(parseJson<FileSig[]>(v.files, []), ws) : null, files: ws.length };
}

/** The workspace's state as list_files and list_versions show it. */
export async function workspaceLine(env: Env, p: Project, t?: { ws: string; base: number | null; newest: number }) {
  const w = await workspaceState(env, p, t);
  if (!w.diff) return { based_on_version: null, changed_since_base: w.files ? `${w.files} file(s) uploaded, no version deployed yet` : 'empty' };
  return {
    based_on_version: w.base,
    changed_since_base: isSame(w.diff) ? `nothing: the workspace is exactly version ${w.base}` : diffLine(w.diff),
    ...(w.base! < w.newest ? { newer_version: `Version ${w.newest} is newer than the version the workspace is based on. diff_versions {from: ${w.base}, to: ${w.newest}} shows what it changed.` } : {}),
  };
}

/**
 * A zip of every file, streamed: each file goes straight from storage into the response without compression, so a game
 * at its storage limit never has to sit in memory whole.
 */
export function zipStream(env: Env, p: Project, s: Source, files: FileSig[]): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  let chain = Promise.resolve();
  const zip = new Zip((err, data, final) => {
    chain = chain.then(async () => {
      if (err) { await w.abort(err); return; }
      await w.write(data);
      if (final) await w.close();
    });
  });
  (async () => {
    try {
      for (const f of files) {
        const obj = await readSourceFile(env, p, s, f.path);
        if (!obj) throw new Error(`${f.path} is missing from storage`);
        const entry = new ZipPassThrough(f.path);
        zip.add(entry);
        const r = obj.body.getReader();
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          entry.push(value);
          await chain;   // keep pace with the reader
        }
        entry.push(new Uint8Array(0), true);
        await chain;
      }
      zip.end();
      await chain;
    } catch (e) { console.error('zip', p.id, sourceName(s), String((e as Error)?.message || e)); await w.abort(e).catch(() => {}); }
  })();
  return readable;
}

/**
 * Makes the workspace exactly version n's files: files that differ are copied from the version, files the version does
 * not have are deleted, files already the same are left alone. The workspace's base becomes n.
 */
export async function checkoutVersion(env: Env, p: Project, n: number, ws: string = p.id, branchId: string | null = null): Promise<{ written: string[]; removed: string[]; unchanged: number }> {
  const v = await versionOrThrow(env, p, n), want = parseJson<FileSig[]>(v.files, []);
  const have = await listFiles(env, ws), d = diffFiles(have.map((f) => ({ path: f.path, size: f.size, sha: f.sha })), want);
  // the game's storage may have been lowered since this version was made
  assertFits(await getSettings(env), p, have, [...d.added, ...d.changed].map((f) => ({ path: f.path, size: f.bytes_after || 0 })), d.removed.map((f) => f.path));
  const written: string[] = [], removed: string[] = [];
  for (const f of [...d.added, ...d.changed]) {
    const obj = await env.FILES.get(verKey(p.id, n, f.path));
    if (!obj) throw new AppError(500, `Version ${n}'s file ${f.path} is missing from storage.`);
    const sig = want.find((x) => x.path === f.path)!, ctype = obj.httpMetadata?.contentType || 'application/octet-stream';
    await env.FILES.put(wsKey(ws, f.path), obj.body, { httpMetadata: { contentType: ctype } });
    await env.DB.prepare('INSERT INTO files (project_id, path, size, sha, ctype, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET size = excluded.size, sha = excluded.sha, ctype = excluded.ctype, updated_at = excluded.updated_at')
      .bind(ws, f.path, sig.size, sig.sha, ctype, now()).run();
    written.push(f.path);
  }
  for (const f of d.removed) {
    await env.DB.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').bind(ws, f.path).run();
    await env.FILES.delete(wsKey(ws, f.path));
    removed.push(f.path);
  }
  if (branchId) await env.DB.prepare('UPDATE branches SET ws_base = ?, updated_at = ? WHERE id = ?').bind(n, now(), branchId).run();
  else await env.DB.prepare('UPDATE projects SET ws_base = ?, updated_at = ? WHERE id = ?').bind(n, now(), p.id).run();
  return { written, removed, unchanged: d.unchanged };
}

/** main's newest version (versions deployed from a branch are not main's; src/collab.ts). */
export async function mainNewest(env: Env, p: Project): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM versions WHERE project_id = ? AND branch IS NULL').bind(p.id).first<{ n: number }>();
  return r?.n || 0;
}

/** Parses a source argument: a version number, or "workspace". */
export function parseSource(v: unknown, what: string): Source | null {
  if (v === undefined || v === null || v === '') return null;
  if (v === 'workspace') return { workspace: true };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw bad(`${what} must be a version number or "workspace".`);
  return { version: n };
}
