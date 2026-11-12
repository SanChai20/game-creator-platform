const enc = new TextEncoder();

export const now = () => Date.now();
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => dayOf(Date.parse(day + 'T00:00:00Z') + n * 86400000);

const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
export function rid(len = 12): string {
  const b = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
export function token(bytes = 32): string { return b64u(crypto.getRandomValues(new Uint8Array(bytes))); }

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
export function b64(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}
export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function parseJson<T>(s: string | null | undefined, fallback: T): T { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const TYPES: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', txt: 'text/plain', md: 'text/markdown',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon',
  wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', ktx2: 'image/ktx2', hdr: 'application/octet-stream',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wgsl: 'text/plain', glsl: 'text/plain', map: 'application/json',
};
export const extOf = (path: string) => (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const typeOf = (path: string) => TYPES[extOf(path)] || '';
export const isText = (path: string) => ['html', 'js', 'mjs', 'css', 'json', 'txt', 'md', 'svg', 'wgsl', 'glsl', 'map'].includes(extOf(path));
export const ALLOWED_EXT = Object.keys(TYPES);

/** Normalises a bundle path; returns null if it is not allowed. */
export function cleanPath(p: string): string | null {
  p = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!p || p.length > 200 || p.endsWith('/')) return null;
  if (p.split('/').some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return null;
  if (!/^[A-Za-z0-9._\-/@+ ]+$/.test(p)) return null;
  if (!ALLOWED_EXT.includes(extOf(p))) return null;
  return p;
}
