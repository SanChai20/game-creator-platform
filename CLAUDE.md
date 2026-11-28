# Notes for agents working in this repo

## Web is the only codebase (standing rule)

HearthCade is maintained for the web only. Every feature is specified, built and changed in `web/` and `src/`, and
every app (the installed PWA today, any future desktop or Android shell) picks it up by hot update, because each app is
a thin shell that loads `https://hearthcade.com`. Players never re-download an app for a change. Do not write
per-app code paths, bundle the web build into a shell, or precache the app shell in `web/public/sw.js`. See
[docs/apps.md](docs/apps.md) for the details and the few exceptions.

## No accent bars (standing design rule)

The owner dislikes stripe indicators, so the site never marks anything with a coloured bar on one side. That covers
left, right, top and bottom border bars, one-sided inset shadows (`inset 4px 0 0 …`, `inset 0 -3px 0 …`), and thin
`::before`/`::after` bars. It applies to tabs, nav items, sub-nav links, cards and card titles, stats, notices, toasts,
badges, quotes, heading underlines, list rows and selected items. Show state another way:

- the current tab or nav item: a filled plate or pill (`background: var(--text)` or the area colour, light text);
- a highlight, a selected row or a callout: a soft tinted background (`rgb(var(--accent-rgb) / .1)`, `var(--sunk)`);
- emphasis: colour and font weight.

Neutral 1px dividers between regions are fine. Triangles, chevrons, ticks and spinners drawn with borders are shapes,
not bars. `tests/no-accent-bars.mjs` reads every stylesheet and component and fails if a stripe comes back.
