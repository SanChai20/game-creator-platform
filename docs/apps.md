# Apps on every platform: web is the only codebase

**Standing rule (from the owner).** Every feature is specified, built and maintained for the web only. Every other
platform (iPhone, iPad, Android, Windows, Mac, Linux) inherits it through hot updates. A player never re-downloads an
app to get a change. When a feature is added, changed or removed, the description given is how it works on the web,
and nothing is written separately for an app.

## How every app gets web changes

Every app is a thin shell that loads `https://hearthcade.com` (`PUBLIC_ORIGIN`). It never bundles a copy of the web app.

| Platform | What the player installs | How a web deploy reaches it |
| --- | --- | --- |
| iPhone, iPad, Android, desktop Chrome and Edge, Safari on Mac | The PWA: `web/public/manifest.webmanifest`, `web/public/sw.js`, `web/src/install.ts` | The next time it opens. The service worker fetches pages from the network first and caches only hashed build files (`/assets/…`), so a deploy is never held back |
| Desktop app, if built (Tauri; deferred, no signing yet) | A shell whose window opens `https://hearthcade.com` | The same: the window loads the live site |
| Android APK, if built (Trusted Web Activity) | A shell that opens `https://hearthcade.com` in Chrome | The same |

A shell itself changes only for a native ability the web cannot reach (a tray icon, a native fullscreen bridge). Those
changes are rare and are installed by the shell's own updater in the background (the Tauri updater, or the APK's
update), never by asking the player to download again. A feature that only needs web code never touches a shell.

## Rules for changes

- Build every feature in `web/` and `src/` only. Do not fork behaviour per app. Where a platform differs (iPhone has no
  element fullscreen, for example), the web code detects it, as `web/src/install.ts` and `web/src/player.tsx` already do.
- Never precache the app shell in `sw.js` and never bundle the web build into a shell. Either would let an old version
  outlive a deploy. Pages stay network-first. Bump `VERSION` in `sw.js` only when its own caching rules change.
- A shell may expose a native call to the web only for `hearthcade.com`, and the web must keep working without it (it
  feature-detects the call and falls back to the browser API).
- A change that needs a new shell build is the exception. Say so explicitly before making it.

## Why not bundle the web build and sync it over the air

Bundling the web build in each app and updating it over the air (Capacitor Live Updates, a custom download-and-swap) was
considered and rejected. It adds a second release channel, version skew between the API and old bundles on players'
devices, and rollback and half-downloaded-bundle cases to handle. Remote loading has one deploy and one version
everywhere, and a rollback is a web redeploy. Its cost is that an app opens offline only with what the service worker
kept (the app shell; games already need the network for their play token), and the first open after a deploy fetches
the new files. The PWA already works this way.
