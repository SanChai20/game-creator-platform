# Design system

Everything the platform's pages look like comes from this folder. Pages compose these pieces and do not set their own colours, sizes or spacing.

| File | What it holds |
| --- | --- |
| `tokens.ts` | Colours, chart series colours, fonts, type scale, spacing, radii, shadows, motion, layout widths, z-index. Emitted as CSS custom properties (`TOKENS_CSS`). The web app injects it at start-up and the Worker inlines it into the server-rendered consent page, so both always match. |
| `ui.css` | Base styles and every component's styles, using only `var(--…)` tokens. |
| `components.tsx` | The React components. |
| `../styles.css` | Page layouts only (top bar, billboard, creators terminal, docs, game page, console grids). |

Fonts (Inter, Space Grotesk, JetBrains Mono, all OFL) are self-hosted from `web/public/fonts/`. Chinese text falls back to the system CJK fonts.

## The look

A game cabinet's HUD: violet-black ink, acid lime (`--accent`) for the one thing to do on a screen, and a hard hot-pink offset shadow (`--shadow-pop`) on anything you can press, which drops onto the page when pressed. Labels are mono and upper case, surfaces get corner ticks, and `<mark>` (or `.hl`) is the highlighter for the one phrase that matters most. Keep pages short: details belong on `/docs`.

## GPU layer (`fx/`)

The site renders through a persistent WebGL 2 pipeline behind the DOM (`fx/pipeline.ts`): a noise field in the brand colours → a scene where game covers, the billboard and game posters are drawn as textured quads at their DOM positions (hover ripple, RGB split, parallax) → bloom → post-processing (chromatic aberration, scanlines, grain, vignette, and a pixelate-and-scan transition on page changes). Text and controls stay in the DOM.

To let the GPU draw a picture, mark its element with `data-gl="tile" | "hero" | "poster"` (the picture comes from `data-gl-src` or the element's first `<img>`). If an ancestor has a background that would cover the canvas, mark it `data-gl-host`. The DOM picture is hidden only after its texture is drawn and comes back on any failure.

Tiers (`fx/gl.ts`): **full** (desktop with a GPU), **lite** (phones and weak devices: background and post only, 30 fps), **still** (reduced motion: one frame), **off** (no WebGL 2, a software renderer, or the footer switch). The pipeline pauses in hidden tabs, lowers its resolution and then its tier when frames run long, and recovers once from a lost context. `localStorage.fx = 'force'` skips the device checks for testing; `__fx.stats` shows fps and CPU time per frame.

## The store (`../store.tsx`)

The home page and the browse page are built for a catalogue of tens of thousands of games. `/api/home` returns the spotlight, the shelves, the genres and the key numbers in one request; `/api/games` is paged (`limit`, `offset`, with `total` and `next_offset`; `facets=0` skips the genre counts). The building blocks live in `store.tsx`: `SearchBox` (instant results, `/` to focus), `Spotlight` (rotating picks; still under reduced motion), `Stats`, `Shelf` (a sideways row with "See all"), `Genres`, `Since` ("Jump back in" and "new since your last visit") and `MoreLike` (game pages). Shelves never assume a fixed number of games, and the browse grid loads the next page as you scroll.

Games are collectibles everywhere: `rarity(g)` in `lib.tsx` (Common, Rare, Epic, Legendary, earned from ratings and plays) gives each card its colour (`--rc`). `GameTile` is the collectible card used in every grid and shelf.

Return visits: `lastVisit()`, `recentPlays()` and `rememberPlay()` in `lib.tsx` keep, in this browser only, when it was last here and which games it played. Live "playing now" counts come with every game (`playing`).

## Tokens

CSS names are the TypeScript keys in kebab case: `color.accentWash` is `var(--accent-wash)`, `space[4]` is `var(--sp-4)`, `size['3xl']` is `var(--fs-3xl)`, `radius.lg` is `var(--r-lg)`. A few composites are added: `--grad-accent`, `--grad-surface`, `--grad-text`.

For charts, import `chart` from `ui/tokens`: `chart.series` is the ordered series palette, plus `grid`, `axis`, `label` and `empty`.

## Components

Import from `web/src/ui` (`import { Card, Stat } from '../ui'`).

- **Actions:** `Button` (`variant` primary · secondary · ghost · danger, `size` sm · md · lg, `to` for an app link, `href` for a plain link, `block`), `PlayButton`.
- **Layout:** `PageHeader` (eyebrow or `back`, title, `badge`, `sub`, `actions`), `Section`, `Card` (`title`, `aside`, `actions`, `pad`, `tone="accent"`), `ListRow`, `Tabs`.
- **Data:** `StatGrid` + `Stat` (`tone="accent"`, `to`), `KeyValue`, `Table` (use `className="n"` on numeric cells), `Bars`, `ChartBlock`, `CheckRow`.
- **Labels:** `Badge` (`tone` good · bad · accent · info · neutral, `dot`), `StatusBadge`, `Eyebrow`, `Chip`.
- **Feedback:** `Notice` (`tone`, `title`, `actions`), `EmptyState`, `Spinner`, `Modal`, `Code` (with copy).
- **Forms:** `Field`, `Input` (`mono`), `Select`, `Textarea`, `Switch`, `SearchInput`, `Segmented`.
- **Lists:** `Steps`, `Ticks`.

A new console view (for example an analytics dashboard) is typically `PageHeader` + `Tabs` + `StatGrid` of `Stat` + `Card`s holding `ChartBlock`/`Bars` and `Table`.
