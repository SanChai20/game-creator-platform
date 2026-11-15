// Design tokens: the one place colours, type, spacing, radii, shadows and motion are defined.
// The web app injects TOKENS_CSS at start-up and the Worker inlines it into its server-rendered pages
// (the agent consent screen), so both stay in step. Change a value here and every surface follows.
// Plain data and strings only: this file is imported by the Worker as well as the browser.

export const color = {
  // Surfaces, darkest to lightest. The interface is the ink around the games.
  bg0: '#06070b', bg1: '#0c0e14', bg2: '#12151d', bg3: '#191d27', bg4: '#242a37',
  line: 'rgba(170, 182, 255, .08)', line2: 'rgba(170, 182, 255, .14)', line3: 'rgba(170, 182, 255, .26)',
  // Text
  text: '#eef0f6', text2: '#a3a9ba', text3: '#686e82',
  // Brand: a warm signal on cool ink.
  accent: '#ffb53d', accent2: '#ff7a2f', accentHi: '#ffd27a', accentInk: '#1a0f02',
  accentWash: 'rgba(255, 181, 61, .11)', accentGlow: 'rgba(255, 138, 48, .38)',
  // Atmosphere: used for glows and charts, never for meaning.
  violet: '#8f7cff', cyan: '#4fd8ff', pink: '#ff5fa2',
  // Meaning
  good: '#4ade9b', bad: '#ff6b6b', info: '#6cb6ff',
  goodWash: 'rgba(74, 222, 155, .11)', badWash: 'rgba(255, 107, 107, .1)', infoWash: 'rgba(108, 182, 255, .11)',
} as const;

/** Series colours for charts, in order. Readable on the dark surfaces and distinct from one another. */
export const chart = {
  series: [color.accent, color.violet, color.cyan, color.pink, color.good, color.info],
  grid: color.line, axis: color.text3, label: color.text2, empty: color.bg4,
} as const;

const cjk = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
export const font = {
  display: `"Space Grotesk", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, ${cjk}`,
  sans: `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", ${cjk}`,
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
} as const;

/** Type scale. The large steps grow with the viewport so headings hold their weight on phones and wide screens. */
export const size = {
  xs: '12px', sm: '13.5px', md: '15px', lg: '17px', xl: '20px', '2xl': '26px',
  '3xl': 'clamp(28px, 3.2vw, 42px)', '4xl': 'clamp(36px, 5.2vw, 68px)', '5xl': 'clamp(42px, 7vw, 100px)',
} as const;

export const space = { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 7: '32px', 8: '40px', 9: '56px', 10: '80px', 11: '112px' } as const;
export const radius = { xs: '6px', sm: '10px', md: '14px', lg: '20px', xl: '28px', pill: '999px' } as const;
export const shadow = {
  1: '0 1px 2px rgba(0, 0, 0, .4)',
  2: '0 12px 32px -8px rgba(0, 0, 0, .6)',
  3: '0 32px 80px -16px rgba(0, 0, 0, .75)',
  glow: `0 10px 34px -6px ${color.accentGlow}`,
  inset: 'inset 0 1px 0 rgba(255, 255, 255, .05)',
} as const;
export const motion = { ease: 'cubic-bezier(.2, .8, .2, 1)', fast: '.12s', base: '.2s', slow: '.4s' } as const;
export const layout = { wrap: '1320px', gutter: 'clamp(16px, 4vw, 48px)', nav: '64px' } as const;
export const z = { nav: 50, sticky: 20, modal: 120, toast: 200 } as const;

const vars: Record<string, string | number> = {
  ...Object.fromEntries(Object.entries(color).map(([k, v]) => [k.replace(/[A-Z0-9]/g, (m) => '-' + m.toLowerCase()), v])),
  'grad-accent': `linear-gradient(135deg, ${color.accentHi} 0%, ${color.accent} 38%, ${color.accent2} 100%)`,
  'grad-surface': `linear-gradient(180deg, rgba(255, 255, 255, .028), rgba(255, 255, 255, 0) 60%)`,
  'grad-text': `linear-gradient(100deg, ${color.text} 30%, ${color.accentHi} 70%, ${color.accent2})`,
  'font-display': font.display, 'font-sans': font.sans, 'font-mono': font.mono,
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
  face('Space Grotesk', 'space-grotesk-latin-wght-normal.woff2', '300 700') +
  face('JetBrains Mono', 'jetbrains-mono-latin-wght-normal.woff2', '100 800') +
  `:root{color-scheme:dark;${Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';')}}`;
