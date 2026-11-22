# Notes for agents working in this repo

## Web is the only codebase (standing rule)

HearthCade is maintained for the web only. Every feature is specified, built and changed in `web/` and `src/`, and
every app (the installed PWA today, any future desktop or Android shell) picks it up by hot update, because each app is
a thin shell that loads `https://hearthcade.com`. Players never re-download an app for a change. Do not write
per-app code paths, bundle the web build into a shell, or precache the app shell in `web/public/sw.js`. See
[docs/apps.md](docs/apps.md) for the details and the few exceptions.
