// Lets a test import the Worker's TypeScript sources as they are: sibling imports without an extension resolve to .ts,
// and syntax Node's type stripping refuses (parameter properties) is compiled with esbuild, which wrangler ships.
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (e) { if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) return next(spec + '.ts', ctx); throw e; }
}

export async function load(url, ctx, next) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, ctx);
  const { code } = await transform(await readFile(new URL(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022' });
  return { format: 'module', source: code, shortCircuit: true };
}
