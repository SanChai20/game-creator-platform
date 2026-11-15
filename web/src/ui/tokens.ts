// Design tokens: the one place colours, type, spacing, radii, shadows and motion are defined.
// The web app injects TOKENS_CSS at start-up and the Worker inlines it into its server-rendered pages
// (the agent consent screen), so both stay in step. Change a value here and every surface follows.
// Plain data and strings only: this file is imported by the Worker as well as the browser.

export const color = {
  // Surfaces, darkest to lightest: a violet-black, like a cabinet screen with the power on.
  bg0: '#0a0910', bg1: '#110f18', bg2: '#17151f', bg3: '#201d2a', bg4: '#2c2838',
  line: 'rgba(196, 184, 255, .08)', line2: 'rgba(196, 184, 255, .15)', line3: 'rgba(196, 184, 255, .28)',
  // Text
  text: '#f2f0f7', text2: '#a9a4b8', text3: '#6c6780',
  // Brand: acid lime on ink for the one thing to do; hot pink only as a rare highlight (new, chart series).
  accent: '#c6ff3d', accent2: '#8cf23a', accentHi: '#e4ff7a', accentInk: '#0d1400',
  accentWash: 'rgba(198, 255, 61, .1)', accentLine: 'rgba(198, 255, 61, .34)', accentGlow: 'rgba(198, 255, 61, .3)',
  hot: '#ff4fa3', hotWash: 'rgba(255, 79, 163, .12)',
  // Atmosphere: glows and charts, never meaning.
  violet: '#8b6bff', cyan: '#3fe0ff', pink: '#ff4fa3', gold: '#ffc845',
  // Meaning
  good: '#3ee8b5', bad: '#ff5d6c', info: '#6cb6ff',
  goodWash: 'rgba(62, 232, 181, .11)', badWash: 'rgba(255, 93, 108, .1)', infoWash: 'rgba(108, 182, 255, .11)',
} as const;

/** Series colours for charts, in order. Readable on the dark surfaces and distinct from one another. */
export const chart = {
  series: [color.accent, color.violet, color.cyan, color.pink, color.good, color.info],
  grid: color.line, axis: color.text3, label: color.text2, empty: color.bg4,
} as const;

const cjk = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
export const font = {
  // The brand face: wide and loud, for page titles, section heads and big numbers only.
  brand: `"Unbounded", "Space Grotesk", "Inter", ui-sans-serif, system-ui, ${cjk}`,
  display: `"Space Grotesk", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, ${cjk}`,
  sans: `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", ${cjk}`,
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
} as const;

/** Type scale. The large steps grow with the viewport so headings hold their weight on phones and wide screens. */
export const size = {
  xs: '11px', sm: '12.5px', md: '14px', lg: '15.5px', xl: '18px', '2xl': '22px',
  '3xl': 'clamp(24px, 2.6vw, 34px)', '4xl': 'clamp(30px, 4vw, 50px)', '5xl': 'clamp(34px, 5.2vw, 72px)',
} as const;

export const space = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 7: '32px', 8: '40px', 9: '56px', 10: '80px', 11: '112px' } as const;
/** Firm corners: soft enough to feel finished, tight enough to read as hardware rather than bubbles. */
export const radius = { xs: '4px', sm: '6px', md: '9px', lg: '12px', xl: '16px', pill: '999px' } as const;
export const shadow = {
  1: '0 1px 2px rgba(0, 0, 0, .4)',
  2: '0 12px 32px -8px rgba(0, 0, 0, .6)',
  3: '0 32px 80px -16px rgba(0, 0, 0, .75)',
  glow: `0 10px 34px -6px ${color.accentGlow}`,
  inset: 'inset 0 1px 0 rgba(255, 255, 255, .05)',
  // Pressable things: a top highlight and a soft lime bloom underneath, so the one action glows rather than shouts.
  pop: 'inset 0 1px 0 rgba(255, 255, 255, .35), 0 8px 22px -10px rgba(198, 255, 61, .6)',
  // Raised panels (menus, dialogs, cards on cards): a hairline highlight and a long, soft fall-off.
  'pop-lg': 'inset 0 1px 0 rgba(255, 255, 255, .05), 0 1px 0 rgba(0, 0, 0, .4), 0 28px 64px -24px rgba(0, 0, 0, .85)',
  'pop-ink': '0 10px 26px -12px rgba(0, 0, 0, .7)',
} as const;
export const motion = { ease: 'cubic-bezier(.2, .8, .2, 1)', fast: '.12s', base: '.2s', slow: '.4s' } as const;
export const layout = { wrap: '1240px', gutter: 'clamp(16px, 4vw, 40px)', nav: '58px' } as const;
export const z = { nav: 50, sticky: 20, modal: 120, toast: 200 } as const;

const vars: Record<string, string | number> = {
  ...Object.fromEntries(Object.entries(color).map(([k, v]) => [k.replace(/[A-Z0-9]/g, (m) => '-' + m.toLowerCase()), v])),
  'grad-accent': `linear-gradient(135deg, ${color.accentHi} 0%, ${color.accent} 45%, ${color.accent2} 100%)`,
  'grad-surface': `linear-gradient(180deg, rgba(255, 255, 255, .025), rgba(255, 255, 255, 0) 60%)`,
  'grad-text': `linear-gradient(100deg, ${color.accentHi} 0%, ${color.accent} 50%, ${color.cyan})`,
  'grad-hot': `linear-gradient(100deg, ${color.hot}, ${color.violet})`,
  'font-brand': font.brand, 'font-display': font.display, 'font-sans': font.sans, 'font-mono': font.mono,
  ...Object.fromEntries(Object.entries(size).map(([k, v]) => ['fs-' + k, v])),
  ...Object.fromEntries(Object.entries(space).map(([k, v]) => ['sp-' + k, v])),
  ...Object.fromEntries(Object.entries(radius).map(([k, v]) => ['r-' + k, v])),
  ...Object.fromEntries(Object.entries(shadow).map(([k, v]) => ['shadow-' + k, v])),
  ease: motion.ease, 'dur-fast': motion.fast, 'dur': motion.base, 'dur-slow': motion.slow,
  wrap: layout.wrap, gut: layout.gutter, 'nav-h': layout.nav,
  'z-nav': z.nav, 'z-sticky': z.sticky, 'z-modal': z.modal, 'z-toast': z.toast,
};

const face = (family: string, file: string, weights: string) =>
  `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weights};src:url(/fonts/${file}) format("woff2-variations"),url(/fonts/${file}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+FEFF,U+FFFD}`;

/** Every token as a CSS custom property on :root, plus the self-hosted fonts (served from /fonts). */
export const TOKENS_CSS =
  face('Inter', 'inter-latin-wght-normal.woff2', '100 900') +
  face('Unbounded', 'unbounded-latin-wght-normal.woff2', '200 900') +
  face('Space Grotesk', 'space-grotesk-latin-wght-normal.woff2', '300 700') +
  face('JetBrains Mono', 'jetbrains-mono-latin-wght-normal.woff2', '100 800') +
  `:root{color-scheme:dark;${Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';')}}`;
