# Design system

Everything the platform's pages look like comes from this folder. Pages compose these pieces and do not set their own colours, sizes or spacing.

| File | What it holds |
| --- | --- |
| `tokens.ts` | Colours for both themes, chart series colours, fonts, type scale, spacing, radii, shadows, motion, layout widths, z-index. Emitted as CSS custom properties (`TOKENS_CSS`). The web app injects it at start-up and the Worker inlines it into the server-rendered consent page, so both always match. |
| `ui.css` | Base styles and every component's styles, using only `var(--…)` tokens. |
| `components.tsx` | The React components. |
| `theme.ts` | Day and night: follows the system until the visitor picks one (`gcp.theme` in local storage), applied as `data-theme` on `<html>`. |
| `icons.tsx`, `count.tsx` | The few line icons the shell uses, and `CountUp` for figures. |
| `fx/` | The one rendered scene (`CelScene`) and the rules for when it may run. |
| `../app.css` | The shell (top bar, phone tab bar, footer) and the pages outside the store. |
| `../store.css` | The store: search, shelves, categories, the catalogue, the queue and the game page. |

Fonts (Bricolage Grotesque for titles, figures and labels; Geist for text; Geist Mono for code; all OFL) are self-hosted from `web/public/fonts/`. Chinese, Japanese and Korean text falls back to the system CJK fonts.

## The look

"Cel": the page is shaded the way a toon renderer shades a model. Two tones and a hard edge: **paper** is the lit side, **ink** (any block with the `.ink` class, which re-points the same token names at the ink tones) is the shade side, and **flare** (`--accent`) is the one hot colour, kept for the thing to do and the thing that is live. Where one tone meets another it does so through a slanted cut or a halftone screen (`--dots`), never a soft glow. There are two themes, day and night; `.ink` blocks look the same in both.

The structure is a web platform's: a top bar with search, sections, a sidebar of filters, cards, tables. The pieces inside it take their shapes from current stylized games, and that is the rule for anything new:

- **Slabs.** Buttons, chips, tabs and segmented controls are a straight label on a slanted plate (`--skew`). The plate is a pseudo-element, so text, hit area and focus ring stay square. The primary action is flare with a hard-edged shade facet that slides on hover and an echo plate behind it.
- **Capitals.** Titles, labels, buttons and figures are Bricolage Grotesque, condensed, heavy and upper case. Running text is Geist in sentence case.
- **Menu headings.** A section opens with a title over a rule that has a lit, slanted segment (`.section-h`, `.sh`); a panel title carries a slanted pip.
- **HUD readouts.** Figures (`Stat`, the store's counters) are a lit tick, a small label, a heavy number and a halftone corner. Bars that show a share are segmented meters.
- **Selection.** A game cover lifts off a halftone shadow and four corner brackets close in on it; rows and menu items light a marker on their leading edge.
- **Labels.** Every tag, badge, chip and status line is one shape, borrowed from the buttons: a 20 to 28px slanted plate (`--skew`) behind a straight label, with a flat fill and no edge line. The plate is `::after` and takes its fill from `--pl` and a solid bar on its leading edge from `--bar`. A label that reports a state lights that bar in its tone, like a menu row in focus; a descriptive one is a plain neutral plate that lights an accent bar on hover. Colour means state (good, bad, warn, info, accent), never decoration. Status labels (`Badge`, `StatusBadge`, `.trial-tag`, `.ltag`) are capitals (`dot={false}` drops the bar but keeps the tint); descriptive labels (`.gtag`, `.glance-chips`, `.act-chip`, `.price`) are sentence case and neutral; labels over a picture (`.ovl`, `.live-pill`, `.art-trial`, `.mature-tag`, `.stage-badge`) are a dark plate; verdict lines (`.cpill`) add a round mark in the state's colour beside words in the text colour. `.stick` ("Featured") is the one solid fill. Rarity keeps its diamond pip, "what players think" its signal bars, and the age rating is a monochrome tile that only takes a colour at 16+ and 18+. Callouts (`Notice`, `.seal`, `.glance-warn`, `.mature-note`) read like an unlock banner: a wash of their tone that fades across the panel, a solid bar on the leading edge, a cut top-right corner and a halftone screen in the far corner, set by `--nt`. No hairline edges on any of them.
- **Genre colour.** Every category has a hue (`--h`), used as a flat facet on an ink tile (tags stay neutral).

Motion is small and tied to the pointer: a plate slides, a cover lifts, a marker grows. Nothing moves on its own beside the content. Keep pages short: details belong on `/docs`.

## Effects (`fx/`)

One effect: `CelScene`, a dusk landscape drawn by a WebGL 2 fragment shader in flat bands with a halftone sun and rim-lit ridges. It only appears inside large ink blocks (the creators lead, the home page pitch, sign-in, not found), never behind or beside content. Underneath it is the same picture painted in CSS (`.scene` in `ui.css`), which is what shows until the canvas is ready and whenever it is not used.

Tiers (`fx/gl.ts`): **live** (WebGL 2: the shader animates slowly), **still** (reduced motion, Save-Data: one frame), **off** (the footer's Effects switch, no WebGL 2, or a failure, which is remembered for the session: the CSS painting). The page never depends on the canvas.

## Loading (`skeleton.tsx`, `../skeletons.tsx`)

Nothing that waits on the network shows a spinner. `skeleton.tsx` has the pieces (`Sk`, `SkText`, `SkStats`, `SkCard`, `SkRows`, `SkTable`, `SkBars`, inside a `Skeleton` frame that announces "Loading" once); `../skeletons.tsx` composes them into the outline of each page with the page's own layout classes, so content lands where its outline was. `RouteSkeleton` picks the outline for a path and `AppSkeleton` adds the top bar's, for the moment before the app has its session. Parts that load on their own (search results, shelves, a player's progress, connected agents, filter lists) carry their own outline, and a picture shows the same sheen until it arrives. A new page that loads data returns its skeleton while `loading && !data`. With reduced motion the sheen stands still.

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

CSS names are the TypeScript keys in kebab case: `color.accentWash` is `var(--accent-wash)`, `space[4]` is `var(--sp-4)`, `size['3xl']` is `var(--fs-3xl)`, `radius.lg` is `var(--r-lg)`. Each colour also has an `-rgb` form for use at any opacity: `rgb(var(--accent-rgb) / .3)`.

For charts, import `chart` from `ui/tokens`: `chart.series` is the ordered series palette, plus `grid`, `axis`, `label` and `empty`.

## Components

Import from `web/src/ui` (`import { Card, Stat } from '../ui'`).

- **Actions:** `Button` (`variant` primary · secondary · ghost · danger, `size` sm · md · lg, `to` for an app link, `href` for a plain link, `block`), `PlayButton`.
- **Layout:** `PageHeader` (eyebrow or `back`, title, `badge`, `sub`, `actions`), `Section`, `Card` (`title`, `aside`, `actions`, `pad`, `tone="accent"`), `ListRow`, `Tabs`.
- **Data:** `StatGrid` + `Stat` (`tone="accent"`, `to`), `CountUp`, `KeyValue`, `Table` (use `className="n"` on numeric cells), `Bars`, `ChartBlock`, `CheckRow`.
- **Labels:** `Badge` (`tone` good · bad · accent · info · neutral, `dot`), `StatusBadge`, `Eyebrow`, `Chip`.
- **Feedback:** `Notice` (`tone`, `title`, `actions`), `EmptyState`, `Spinner`, `Modal`, `Code` (with copy).
- **Forms:** `Field`, `Input` (`mono`), `Select`, `Textarea`, `Switch`, `SearchInput`, `Segmented`.
- **Lists:** `Steps`, `Ticks`.

A new console view (for example an analytics dashboard) is typically `PageHeader` + `Tabs` + `StatGrid` of `Stat` + `Card`s holding `ChartBlock`/`Bars` and `Table`.
