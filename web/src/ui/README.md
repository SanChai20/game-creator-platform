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

A game cabinet's HUD after dark: violet-black ink, acid lime (`--accent`) for the one thing to do on a screen, and a soft lime glow (`--shadow-pop`) under the primary action, which lifts a pixel on hover and settles when pressed. Raised panels (menus, dialogs) use `--shadow-pop-lg`. Nothing moves on its own: no marquees, no tilt or foil, no rotated stickers. Page titles are set in the wide brand face (`--font-brand`); section heads, card titles and figures use the display face. Small labels are mono and upper case, surfaces are flat panels with hairline borders, figures sit in joined strips (`StatGrid`), and `<mark>` (or `.hl`) sets the one phrase that matters most in lime. Keep pages short: details belong on `/docs`.

## GPU layer (`fx/`)

The site renders through a persistent WebGL 2 pipeline behind the DOM (`fx/pipeline.ts`): a noise field in the brand colours → a scene where game covers, the billboard and game posters are drawn as textured quads at their DOM positions (hover ripple, RGB split, parallax) → bloom → post-processing (chromatic aberration, scanlines, grain, vignette, and a pixelate-and-scan transition on page changes). Text and controls stay in the DOM.

To let the GPU draw a picture, mark its element with `data-gl="tile" | "hero" | "poster"` (the picture comes from `data-gl-src` or the element's first `<img>`). If an ancestor has a background that would cover the canvas, mark it `data-gl-host`. The DOM picture is hidden only after its texture is drawn and comes back on any failure.

Tiers (`fx/gl.ts`): **full** (desktop with a GPU), **lite** (phones and weak devices: background and post only, 30 fps), **still** (reduced motion: one frame), **off** (no WebGL 2, a software renderer, or the footer switch). The pipeline pauses in hidden tabs, lowers its resolution and then its tier when frames run long, and recovers once from a lost context. `localStorage.fx = 'force'` skips the device checks for testing; `__fx.stats` shows fps and CPU time per frame.

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
