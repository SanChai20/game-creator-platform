# Game storage

Every game on the platform has a storage limit: how much all of its files may add up to. This guide explains the limit, how it is enforced, how to build games that stay well inside it, and how to ask for more when a game truly needs it.

The numbers below are the defaults. The platform's administrators can change them, and can give one game a different amount. `get_started` (under `storage`) and `game_storage {project}` always show the current values for this platform and for that game.

## The limits

| Limit | Default | What counts |
| --- | --- | --- |
| Storage per game | 50 MB | Every file in the game's workspace, added up. Platform-hosted Three.js and `@gcp/` modules do not count. |
| Largest file | 20 MB | One file. |
| Files per game | 300 | Every file in the workspace. |

Each deployed version keeps its own frozen copy of the files, so a version is always the size the workspace was when it was deployed.

## Tell the developer early

The limit is part of the design, not an upload error to discover at the end. When you plan a game with a developer:

1. Say how much storage the game has (`get_started` or `game_storage {project}`).
2. Agree a plan for assets that fits: what is generated from code, what ships in the bundle, and what (if anything) is loaded at run time from the developer's own host.
3. Whenever an answer carries `storage.warning` (from 80% used, or over), tell the developer and adjust the plan before adding more.

## How it is enforced

- **Uploads.** `upload_files`, the upload URL (`PUT …?path=`) and zip uploads (`POST …/zip`) refuse a change that would take the game over its storage, the largest file, or the file count. `upload_files` checks the whole call first, deletions included, so swapping a large file for a smaller one in one call works; if anything does not fit, nothing in the call is saved. A zip's size is checked from its directory before it is unpacked, and again after.
- **Only growth is refused.** If a game is already over (its storage was lowered after it was uploaded), deleting or shrinking files always works.
- **Deploying.** `deploy_preview` (and its `dry_run`) reports a static-check error when the workspace is over its storage or file count, and deploys nothing.
- **Publishing.** `publish` refuses a new version that is over the game's storage. A rollback to a version that was live before is allowed.
- **Answers.** Every upload, `list_files`, `list_projects {project}` and `deploy_preview` answer includes `storage`:

```json
"storage": { "used": "41.3 MB", "storage": "50 MB", "free": "8.7 MB", "percent_used": 83,
  "warning": "The game has used 83% of its 50 MB storage (8.7 MB left). Tell the developer now, ..." }
```

Refusals use the codes `storage_full`, `file_too_large` and `too_many_files` (HTTP 413 from the upload URL) and say what to do next.

## Keep the game small

In the order worth trying:

1. **Generate it.** Meshes, terrain, vegetation, textures, skies, sound effects and music can be built from code at boot, from a seed. A generated forest is a few kilobytes of code instead of megabytes of models, and it can be different every run. See the guides `procedural-generation`, `meshes`, `materials-textures`, `animation` and `audio` on {{ORIGIN}}/guides, and the platform's `@gcp/` building blocks.
2. **Load it at run time.** Keep large or optional content (extra levels, music, high-resolution textures, cutscenes, big models) on a host the developer controls and fetch it while the game runs. See below.
3. **Compress what ships.** glTF with Draco or Meshopt geometry; KTX2 or WebP textures sized to how big they are drawn on screen; Opus or OGG audio at 96 kbps or less; no duplicate, unused or source files (`.psd`, `.blend`, uncompressed `.wav`). `game_storage {project}` lists the largest files and the space per kind of file.
4. **Use what the platform hosts.** Three.js and the `@gcp/` modules come from the import map and do not count against the game's storage.

## Loading content at run time

The game page has no Content-Security-Policy restricting connections or media, so `fetch()`, XHR, `<img>`, `<audio>`, `<video>`, Three.js loaders and `WebAssembly.instantiateStreaming` can load from any HTTPS host. There is no allow-list to ask for. What the host needs, and what the game should do:

- **CORS.** The host must send `Access-Control-Allow-Origin` (`*`, or the game's address) for `fetch()`, WebGL and WebGPU textures, and audio decoded with Web Audio. Object storage with public CORS (Cloudflare R2, S3, Google Cloud Storage) or a CDN works; a file-sharing page does not. Set `crossOrigin = 'anonymous'` on images and loaders (`new THREE.TextureLoader().setCrossOrigin('anonymous')`).
- **Boot without it.** Call `GCP.ready()` once the core game is playable, then stream the rest with `GCP.progress(f, label)` or an in-game loading state. The start-time budget in the `loading` guide still applies.
- **Verification sees it.** The verification browser requests everything the game requests, and a URL that answers with an error fails the "Every requested file is served" check. Keep the host reliable and every URL working when the version is verified.
- **Cache it.** Use the Cache Storage API or IndexedDB, keyed by versioned, immutable file names (`…/v3/level2.glb`), so returning players do not download it again.
- **Fail gracefully.** Retry, fall back to generated content, or show a clear message with `GCP.fatal()` if the game cannot run without it.
- **Same rules.** Content loaded at run time is part of the game: the platform's content rules apply. Load data and media with plain GET requests, not scripts (the static checks warn about imports from other hosts). Never put the player's play token or identity in those requests, and do not hold a WebSocket to another server from a background worker: the publish checks refuse both.

A complete example is in the `loading` guide under "Loading content from your own host".

## Asking for more

When a game truly needs more after all of the above (a large hand-made world, voiced dialogue, licensed music), ask:

```
game_storage {project, action: "request", megabytes: 120,
  reason: "Voiced dialogue in 4 languages (about 70 MB as Opus at 48 kbps). It must be there offline from the first scene, so it cannot be streamed."}
```

- `megabytes` is the new total for the game, not an amount to add. Creators can ask for up to 200 MB per game by default; an admin can set more.
- `reason` (at least 40 characters) says what needs the space and why generating it or loading it at run time does not work for it.
- Ask the developer before requesting. One request per game is open at a time; a new one replaces it.
- An admin reviews each request, unless the platform approves small ones at once. `game_storage {project}` shows the status and the answer; the game can use the new storage as soon as it is approved.
