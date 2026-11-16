// Day or night. The page follows the device unless the person picked one in this browser (the switch in the top bar
// and the footer). index.html sets the attribute before the first paint, so nothing flashes.
import { day, night } from './tokens';

export type ThemeName = 'day' | 'night';
const KEY = 'gcp.theme';
const stored = (): ThemeName | null => { try { const v = localStorage.getItem(KEY); return v === 'day' || v === 'night' ? v : null; } catch { return null; } };
const system = (): ThemeName => (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day');
/** The person's own choice, or null while the page follows the device. */
export const themePref = stored;
export const theme = (): ThemeName => stored() || system();
const subs = new Set<() => void>();
function apply() {
  const t = theme();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', (t === 'night' ? night : day).paper);
  subs.forEach((f) => f());
}
export function setTheme(t: ThemeName | null) {
  try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  apply();
}
export const onTheme = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
if (typeof window !== 'undefined') {
  apply();
  const m = matchMedia('(prefers-color-scheme: dark)');
  if (m.addEventListener) m.addEventListener('change', apply); else (m as MediaQueryList & { addListener?: (f: () => void) => void }).addListener?.(apply);
}
