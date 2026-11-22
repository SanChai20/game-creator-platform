// Design tokens: the one place colours, type, spacing, radii, shadows and motion are defined.
// The web app injects TOKENS_CSS at start-up and the Worker inlines it into its server-rendered pages
// (the agent consent screen), so both stay in step. Change a value here and every surface follows.
// Plain data and strings only: this file is imported by the Worker as well as the browser.

/** "r, g, b" of a #rrggbb colour, so CSS can use a token at any opacity: rgb(var(--accent-rgb) / .3). */
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

// The palette, "Cel": the page is shaded the way a toon renderer shades a model. Two tones and a hard edge between
// them: paper for the lit side, ink for the shade side, and one hot colour (flare) where the light catches.
// A warm ramp (cream, peach, flare, wine) is the sky in the rendered scenes and the series in charts; lilac is the one
// cool note. Two themes share every name: "day" (paper is light) and "night" (paper is dark). Blocks marked .ink
// are always the shade side.
export interface Theme {
  paper: string; surface: string; sunk: string; rise: string;
  text: string; text2: string; text3: string; edge: string;
  ink: string; ink2: string; ink3: string; onInk: string; onInk2: string; onInk3: string;
  accent: string; accentHi: string; accentLo: string; accentText: string; onAccent: string;
  good: string; bad: string; warn: string; info: string;
}
export const day: Theme = {
  paper: '#f3f1ea', surface: '#ffffff', sunk: '#e9e6dc', rise: '#ffffff',
  text: '#17151c', text2: '#565260', text3: '#8a8693', edge: '#17151c',
  ink: '#17151c', ink2: '#24212b', ink3: '#35313e', onInk: '#f6f4ee', onInk2: '#b9b4c3', onInk3: '#857f91',
  accent: '#f5284c', accentHi: '#ff5c77', accentLo: '#c9153a', accentText: '#cf1238', onAccent: '#ffffff',
  good: '#0b7d57', bad: '#cf2a1b', warn: '#a8590a', info: '#5a47d6',
};
export const night: Theme = {
  paper: '#111015', surface: '#1b1a21', sunk: '#0a090d', rise: '#24222b',
  text: '#f6f4ee', text2: '#b9b4c3', text3: '#857f91', edge: '#f6f4ee',
  ink: '#08070a', ink2: '#1b1a21', ink3: '#2d2a36', onInk: '#f6f4ee', onInk2: '#b9b4c3', onInk3: '#857f91',
  accent: '#ff3d60', accentHi: '#ff7089', accentLo: '#d81f45', accentText: '#ff5c7a', onAccent: '#ffffff',
  good: '#3ecf9a', bad: '#ff6b5e', warn: '#f0a548', info: '#a99bff',
};
/** Colours that are the same in both themes: the scene ramp, chart series and rarity marks. */
export const hue = { cream: '#ffe9d2', peach: '#ffb08f', flare: '#f5284c', wine: '#7d1236', lilac: '#a99bff', plum: '#3b2a55', gold: '#e8a317', mint: '#3ecf9a' } as const;
/** Kept for code that reads colours in TypeScript (rarity marks, charts). Values that differ by theme are CSS variables. */
export const color = { ...day, ...hue, line: 'var(--line)', line2: 'var(--line-2)' } as const;

/** Series colours for charts, in order. */
export const chart = {
  series: ['var(--accent)', 'var(--text)', hue.lilac, hue.peach, 'var(--good)', 'var(--text-3)'],
  grid: 'var(--line)', axis: 'var(--text-3)', label: 'var(--text-2)', empty: 'var(--sunk)',
} as const;

// CJK faces per language, so Han characters take the right regional shapes (骨 and 直 differ between SC, TC and JP) and
// Hangul gets a Korean face. The Latin faces below are self-hosted with a Latin-only unicode-range, so CJK text always
// falls through to these system fonts.
export const CJK = {
  zh: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC"',
  'zh-TW': '"PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", "Source Han Sans TC"',
  ja: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, "Noto Sans CJK JP", "Noto Sans JP", "Source Han Sans JP"',
  ko: '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", "Noto Sans KR", "Source Han Sans KR"',
} as const;
const sys = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue"';
const monoSys = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas';
/** Latin pages list the CJK faces last (game titles can still be in any script); CJK pages list them right after the web fonts. */
const stacks = (cjk: string, first: boolean) => ({
  // Bricolage Grotesque: a grotesque with a drawn, slightly uneven line, set tight and heavy for titles and figures.
  display: first ? `"Bricolage Grotesque", ${cjk}, ${sys}, sans-serif` : `"Bricolage Grotesque", ${sys}, ${cjk}, sans-serif`,
  // Geist: plain and even, for everything people read.
  sans: first ? `"Geist", ${cjk}, ${sys}, sans-serif` : `"Geist", ${sys}, ${cjk}, sans-serif`,
  // Geist Mono: for code, addresses and version numbers. CJK inside it uses the language's sans.
  mono: `"Geist Mono", ${monoSys}, ${cjk}, monospace`,
});
export const font = stacks(CJK.zh, false);
const fontVars = (f: ReturnType<typeof stacks>) => `--font-display:${f.display};--font-sans:${f.sans};--font-mono:${f.mono}`;
/** Per-language font stacks, keyed on <html lang>. */
const LANG_FONTS_CSS = ([['zh-CN', CJK.zh], ['zh-TW', CJK['zh-TW']], ['ja', CJK.ja], ['ko', CJK.ko]] as const)
  .map(([tag, cjk]) => `:root:lang(${tag}){${fontVars(stacks(cjk, true))}}`).join('') +
  // zh-HK and other Traditional tags the Worker may set
  `:root:lang(zh-Hant),:root:lang(zh-HK){${fontVars(stacks(CJK['zh-TW'], true))}}`;

/** Type scale. The large steps grow with the viewport so titles hold their weight on phones and wide screens. */
export const size = {
  xs: '12px', sm: '13px', md: '15px', lg: '17px', xl: '20px', '2xl': '26px',
  '3xl': 'clamp(28px, 3vw, 38px)', '4xl': 'clamp(36px, 5vw, 60px)', '5xl': 'clamp(44px, 7.4vw, 104px)',
} as const;

export const space = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 7: '32px', 8: '40px', 9: '56px', 10: '80px', 11: '120px' } as const;
export const radius = { xs: '3px', sm: '4px', md: '6px', lg: '8px', xl: '10px', '2xl': '12px', pill: '3px' } as const;
export const motion = { ease: 'cubic-bezier(.2, .7, .1, 1)', fast: '.14s', base: '.24s', slow: '.5s' } as const;
export const layout = { wrap: '1320px', gutter: 'max(clamp(16px, 4vw, 48px), env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px))', nav: '68px' } as const;
export const z = { nav: 50, sticky: 20, modal: 120, toast: 200 } as const;
export const shadow = {
  1: '0 1px 2px rgb(23 21 28 / .06), 0 2px 8px -2px rgb(23 21 28 / .06)',
  2: '0 2px 4px rgb(23 21 28 / .05), 0 14px 32px -12px rgb(23 21 28 / .18)',
  3: '0 4px 8px rgb(23 21 28 / .06), 0 36px 80px -24px rgb(23 21 28 / .34)',
} as const;

const kebab = (k: string) => k.replace(/[A-Z0-9]/g, (m) => '-' + m.toLowerCase());
const RGB_KEYS = ['paper', 'surface', 'text', 'ink', 'onInk', 'accent', 'good', 'bad', 'warn', 'info'] as const;
const themeVars = (t: Theme, dark: boolean) => ({
  ...Object.fromEntries(Object.entries(t).map(([k, v]) => [kebab(k), v])),
  ...Object.fromEntries(RGB_KEYS.map((k) => [kebab(k) + '-rgb', rgb(t[k])])),
  line: `rgb(${rgb(t.text)} / ${dark ? 0.1 : 0.09})`, 'line-2': `rgb(${rgb(t.text)} / ${dark ? 0.17 : 0.16})`, 'line-3': `rgb(${rgb(t.text)} / ${dark ? 0.3 : 0.3})`,
  'accent-wash': `rgb(${rgb(t.accent)} / ${dark ? 0.16 : 0.09})`,
  'shadow-1': dark ? '0 1px 2px rgb(0 0 0 / .4)' : shadow[1],
  'shadow-2': dark ? '0 14px 32px -12px rgb(0 0 0 / .7)' : shadow[2],
  'shadow-3': dark ? '0 36px 80px -24px rgb(0 0 0 / .85)' : shadow[3],
});
const shared: Record<string, string | number> = {
  ...Object.fromEntries(Object.entries(hue).map(([k, v]) => ['c-' + k, v])),
  'font-display': font.display, 'font-sans': font.sans, 'font-mono': font.mono,
  ...Object.fromEntries(Object.entries(size).map(([k, v]) => ['fs-' + k, v])),
  ...Object.fromEntries(Object.entries(space).map(([k, v]) => ['sp-' + k, v])),
  ...Object.fromEntries(Object.entries(radius).map(([k, v]) => ['r-' + k, v])),
  ease: motion.ease, 'dur-fast': motion.fast, dur: motion.base, 'dur-slow': motion.slow,
  wrap: layout.wrap, gut: layout.gutter, 'nav-h': layout.nav,
  'z-nav': z.nav, 'z-sticky': z.sticky, 'z-modal': z.modal, 'z-toast': z.toast,
};
const decl = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(';');
/** What a block on the shade side sees: the same names, pointing at the ink tones. */
const inkVars = (t: Theme) => decl({
  surface: t.ink2, sunk: 'rgb(0 0 0 / .28)', rise: t.ink3, text: t.onInk, 'text-2': t.onInk2, 'text-3': t.onInk3, edge: t.onInk, 'text-rgb': rgb(t.onInk),
  line: `rgb(${rgb(t.onInk)} / .1)`, 'line-2': `rgb(${rgb(t.onInk)} / .18)`, 'line-3': `rgb(${rgb(t.onInk)} / .32)`,
  accent: night.accent, 'accent-text': night.accentText, 'accent-wash': `rgb(${rgb(night.accent)} / .18)`, 'accent-rgb': rgb(night.accent),
  good: night.good, bad: night.bad, warn: night.warn, info: night.info, 'good-rgb': rgb(night.good), 'bad-rgb': rgb(night.bad), 'warn-rgb': rgb(night.warn), 'info-rgb': rgb(night.info),
});

const face = (family: string, file: string, weights: string, extra = '') =>
  `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weights};${extra}src:url(/fonts/${file}) format("woff2-variations"),url(/fonts/${file}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+FEFF,U+FFFD}`;

/** Every token as a CSS custom property, for both themes, plus the self-hosted fonts (served from /fonts). */
export const TOKENS_CSS =
  face('Bricolage Grotesque', 'bricolage-grotesque-latin.woff2', '200 800', 'font-stretch:75% 100%;') +
  face('Geist', 'geist-latin.woff2', '100 900') +
  face('Geist Mono', 'geist-mono-latin.woff2', '100 900') +
  `:root{color-scheme:light;${decl(shared)};${decl(themeVars(day, false))}}` +
  `:root[data-theme="night"]{color-scheme:dark;${decl(themeVars(night, true))}}` +
  `.ink{${inkVars(day)}}:root[data-theme="night"] .ink{${inkVars(night)}}` + LANG_FONTS_CSS;
