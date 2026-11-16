# Design system

Everything the platform's pages look like comes from this folder. Pages compose these pieces and do not set their own colours, sizes or spacing.

| File | What it holds |
| --- | --- |
| `tokens.ts` | Colours, chart series colours, fonts, type scale, spacing, radii, shadows, motion, layout widths, z-index. Emitted as CSS custom properties (`TOKENS_CSS`). The web app injects it at start-up and the Worker inlines it into the server-rendered consent page, so both always match. |
| `ui.css` | Base styles and every component's styles, using only `var(--…)` tokens. |
| `components.tsx` | The React components. |
| `../styles.css` | Page layouts only (top bar, billboard, creators terminal, docs, game page, console grids). |

Fonts (Oxanium for titles and figures, IBM Plex Sans for text, Martian Mono for labels and code; all OFL) are self-hosted from `web/public/fonts/`. Chinese text falls back to the system CJK fonts.

## The look

A game cabinet's HUD after dark: violet-black ink, acid lime (`--accent`) for the one thing to do on a screen, and a soft lime glow (`--shadow-pop`) under the primary action, which lifts a pixel on hover and settles when pressed. Raised panels (menus, dialogs) use `--shadow-pop-lg`. Page titles are set in the wide brand face (`--font-brand`); section heads, card titles and figures use the display face. Small labels are mono and upper case, surfaces are flat panels with hairline borders, figures sit in joined strips (`StatGrid`), and `<mark>` (or `.hl`) sets the one phrase that matters most in lime. Keep pages short: details belong on `/docs`.

## Effects (`fx/`) and the cartoon game UI (`game.css`, `toon.tsx`)

Effects are on by default. The look is stylized cartoon on top of the site's neon palette: cel-shaded props with thick outlines, glossy buttons with a lip that squash when pressed, springy cards, star, coin and confetti bursts. Cartoon was chosen over pixel art because it is the broadest-reaching game style (it dominates casual games and appears in every top-grossing genre), while pixel art reads as a niche, nostalgic choice.

- **World behind the page** (`fx/world3d.ts`, Three.js, loaded as its own chunk after first paint): a banded cartoon sky with an instanced star field, a cel-shaded ringed planet, and props that pop in with an elastic scale. The store gets gems, coins, clouds and a gamepad; the creator pages (console, docs, creators, admin) get gears, toy blocks and a blueprint floor. Everything is generated in code: toon materials (`MeshToonMaterial` with a generated ramp, extended through `onBeforeCompile` with a rim light), inverted-hull outlines, `DataTexture`s computed from seeded noise, and meshes built from vertices or composed from primitives. Props stay in the margins beside the content column and fade where they pass behind text. On the full tier there is a light bloom, and the billboard and game posters are drawn as GPU surfaces (`data-gl="hero" | "poster"`, `data-gl-host` on a covering ancestor) with a glossy sweep on hover.
- **Fallback world** (`fx/world2d.ts`): the same scene painted once with Canvas 2D, for browsers without a usable WebGL 2.
- **Particle overlay** (`fx/overlay.ts`): a Canvas 2D layer above the page that never takes a click. Primary buttons, tabs and anything with `data-fx-burst="stars|coins|confetti|sparkle|hearts|gems"` burst when pressed; cards, categories and console rows twinkle while hovered; code can call `fxBurst(elementOrPoint, kind)`. It only runs a frame loop while particles are alive. Sprites are drawn in code (`fx/sprites.ts`).
- **Game UI** (`game.css`, `toon.tsx`): `ToonIcon` (inline SVG icons in the same cel style), `CountUp` (figures roll up like a score; `Stat` uses it and takes an `icon`), achievement-style toasts, springy hover and press states. All motion sits inside `prefers-reduced-motion: no-preference`.

Tiers (`fx/gl.ts`), decided once per page and again when the footer switch or the motion preference changes: **full** (WebGL 2 on a real GPU, desktop), **lite** (phones, weak devices, Save-Data: low resolution, 30 fps, fewer props, no bloom or GPU surfaces), **basic** (no WebGL 2, as on WebGL 1-only devices and old Safari or Android browsers, a software renderer, a failing driver: the Canvas 2D world plus the overlay), **still** (reduced motion: one frame, no particles), **off** (the footer switch, or no canvas at all). A failure at any point (the chunk will not load, a shader will not compile, a lost context) is remembered for the session and drops to basic; the page itself never depends on the layer. The world pauses in hidden tabs and steps down when frames run long. `localStorage.fx = 'force'` skips the GPU checks for testing; `__fx.plan` says which tier was chosen and why, and `__fx.stats` shows fps, CPU time and draw calls.

## The store (`../store.tsx`, `../store.css`)

The store is laid out for a catalogue of tens of thousands of games across many categories, with Steam's structure as the reference and a look of its own.

- **Identity.** A night arcade. Games sit in notched cartridges (two corners cut). Every category wears its own colour (`--h` from `genreHue(tag)`). Titles use the wide brand face (`--font-brand`, Oxanium). Sections are numbered like levels (`SectionHead`).
- **Navigation.** `StoreBar` sits under the top bar on every store page. It holds the Categories mega menu, the main lists, the discovery queue and instant search (`/` focuses it).
- **Front page.** One request, `/api/home`, returns everything the page shows:
  - `Stats`
  - `Spotlight`: the featured carousel, which holds still under reduced motion
  - `Since`: "Jump back in" and "new since your last visit"
  - `Cartridges`: categories
  - `TabbedLists`: rows with a preview of the game in focus
  - `Shelf`: sideways rows
  - `QueueBand`
- **Categories.** `/categories` lists every genre, as cartridges and then A to Z (`/api/categories`). Each genre has its own page at `/c/:tag` (`/api/categories/:tag`, which gives its numbers and related genres), followed by its full catalogue.
- **Catalogue.** `Catalogue` (in `pages/Browse.tsx`) powers `/browse` and every category page:
  - A filter sidebar: several genres at once (`tag=a,b`), price (`free`, `under5`, `paid`) and minimum rating (`rating=4`). It becomes a drawer on phones.
  - Sort, and a grid or list view (`GameRow`).
  - Numbered pages (`Pager`, 30 a page).
  - Every choice is kept in the address.
- **Discovery queue.** `/queue` shows games this browser has not opened yet, one at a time (`seenGames`, `markSeen`).
- **Game pages.**
  - A media area and a capsule.
  - The buy box.
  - About, controls and reviews.
  - A figure strip.
  - Shelves for "More from this creator" (`/api/games?by=`) and "More like this".
- **Long lists elsewhere.** The console's game list and the admin lists are searchable and paged too.

`verdict(g)` turns a rating into a word: Adored, Loved, Liked, Mixed or Rough. `rarity(g)` (Common to Legendary) gives each card its edge colour (`--rc`).

Return visits are kept in this browser only. `lastVisit()`, `recentPlays()` and `rememberPlay()` record when it was last here and which games it played.

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
