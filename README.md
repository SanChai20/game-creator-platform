# HearthCade

**Frontier craft, reusable by every agent.**

A platform where people publish web games made with their own AI agent (Claude, ChatGPT, Codex, Claude Code, Cursor, OpenCode or anything that speaks MCP), have each version checked for playability by a real browser, and sell or share it in a marketplace where players sign in, play, rate, review and buy. Everything runs on Cloudflare.

**Web games only.** The platform hosts games that run in a browser page: HTML, JavaScript, CSS and WebAssembly. Native, mobile, console and desktop builds are refused: uploads are checked by their bytes as well as their names, and a page that sends players to a download, an app store or another site fails the static checks. Engines that export to the web (Unity WebGL, Godot Web, Phaser, PlayCanvas, Babylon.js, Three.js) are welcome.

**Hosting, not authoring.** The MCP server covers deploying, going live, versions and the platform services (saves, leaderboards, multiplayer rooms, server code and more; `platform_services` and [the services guide](web/public/guides/services.md) list them all, with what is not provided). It does not tell agents how to make a game: engine, renderer, art and asset pipeline are the creator's.

## What is in here

| Part | Where | What it does |
| --- | --- | --- |
| Platform Worker | `src/` | API, OAuth, MCP server, deployment pipeline, realtime rooms, web app hosting |
| MCP server | `src/mcp/` | Tools for agents: get_started (rules, account, services, platform guides, the standards index), game_standards (the platform's standard for everything a game shows or hands over, and a check of the game against them), platform_services (the catalog of every service with its SDK calls, tools, live limits and what is not provided; also the `gcp://services` resource), projects, file uploads, game_metadata (the store-page checklist: detect, suggest, declare), compatibility requirements (detect, declare), game_storage (the game's storage, what uses it, how to stay inside it, requests for more), preview and verification, versions, publish, rollback, unpublish, stats, and the hosted services: game data (shared data, saves, leaderboards) and multiplayer rooms, plus find_implementations and get_implementation, which show how other creators' live games were built when they opted in (never code), plus debug_preview (drive the preview in a real browser: screenshots, clicks, taps, keys, typing, waits and the game's state) and creator_feedback (the creator's annotated screenshots, read once) |
| Web-only checks | `src/web-only.js` | Refuses programs, installers and archives by their bytes, and flags pages that lead to a native download, an app store or another site |
| Region checks | `src/region-hosts.js`, `docs/worldwide-access.md` | Warns at deploy when a game loads from hosts some regions block (Google Fonts, YouTube, analytics and others blocked in mainland China). The doc lists what else affects access by region |
| Game host | `src/game-host.ts`, `src/runtime/game-worker.js`, `docs/shared-game-host.md` | Serves every game from the platform Worker on `*.hearthcade.app` (the shared game host): the game runtime reads the version's files from R2, gates them behind a signed play token and injects the SDK. A game's `server/index.js` runs in a Dynamic Worker of its own; only games with server-run matches keep a standard Worker each |
| Game runtime | `web/public/sdk/gcp.js`, `docs/game-runtime.md` | The versioned layer injected into every game (live ones too) that makes it behave the same in every browser and on every device: fill-ins for what Safari and older browsers lack, fullscreen and orientation through the player, sound on the first tap, touch controls, pixel-density cap, storage and lost-graphics recovery. `GCP.runtime` reports the version and the fixes on. Tests in `tests/runtime.mjs` |
| Device checks | `src/device-checks.js`, `src/verify-core.js` | At deploy: warnings for what the runtime cannot fill in on iPhone and iPad (newer syntax, features Safari lacks, Ogg-only sound). At verification: the game is played again on an emulated iPhone and iPad (admin setting `verify_devices`). Tests in `tests/device-checks.mjs` |
| Agent debugging | `src/debug-core.js`, `src/debug.ts` | debug_preview: a Browser Rendering browser on the game's preview that the agent drives between calls (one per account, a few on the platform, closed after 3 idle minutes; admin settings under Debugging and feedback). Tests in `tests/debug.mjs` |
| Creator feedback | `src/feedback-rules.js`, `src/feedback.ts`, `web/src/feedback.tsx` | While playing the preview in the console, the creator captures the game, circles or points at what is wrong, attaches pictures of their own (design mockups, references) and marks them up too, writes a note and queues it; creator_feedback returns the items with their pictures and removes them. Owner only, size and rate limited. Tests in `tests/feedback.mjs`; `npm run test:debug` runs both against a live Worker, `npm run test:attach` the editor in a real browser (`tests/feedback-attach-browser.mjs`) |
| Verifier | `src/verify-core.js`, `src/verify.ts` | Opens a deployed game in a real browser and decides whether it is playable |
| Duplication check | `src/originality.js`, `src/originality-check.ts` | Before publishing: compares each verified version with other creators' live games and refuses copies and uploads that are not games. Two kinds of evidence: the code (fingerprints that survive renaming, identical files, asset hashes) and the identity (the same or a near title, the same tagline, the names of its characters, cards, enemies and places, the same look), so a game rebuilt from another's description or build skill is caught too; templates, kits and libraries are ignored. Building a game like another is allowed, taking its identity is not, and a refusal lists exactly what matched. Candidates come only from hash indexes (`fp_index`, `id_index` with a name sketch and screenshot bands), so a check costs the same however many games are live. No person reviews copies; three stages decide: the rules above settle clear cases (a copy, or nothing close); a close pair goes to `@cf/cloudflare/clef-flash` ($0.038 per M input tokens), whose confident "not a copy" is final; anything else (unsure, or "copy", which the cheap model never decides alone) goes to `@cf/cloudflare/clef` ($0.24 per M), whose answer is final. Answers are cached per pair for 30 days and every call counts against a daily cap; without an AI answer the rules stand. `clef-flash` also decides whether an interactive page is a game |
| Open implementation | `src/implementation.js`, `src/implementations.ts` | Opt-in cards that tell other agents how a live game is built, written from facts about the build, never its code |
| Build skills and the Creator Store | `src/skill-rules.js`, `src/skills.ts`, `web/src/pages/CreatorStore.tsx` | Each shared game's build skill: an agent skill its own agent writes (`build_skill`, prose only, code refused), kept in step with every release (publish waits for it), free or sold, listed under its game at `/creator-store` with Copy skill. Skill sales are their own table and figures. Tests in `tests/skills.mjs` |
| SDK | `web/public/sdk/gcp.js` | `GCP.ready()`, per-player saves and stats, the play record, leaderboards, rooms, test hooks. Injected into every game |
| Hosted modules | `web/public/kits/v1/` | `@gcp/…` modules (procedural core, building blocks, loop, input, Three.js and canvas helpers, multiplayer) that published games already import. Still served at `/kits/v1/`; agents are no longer pointed at them |
| Game standards | `src/standards.js`, `web/public/guides/standards.md` | One registry of everything a game or its agent provides (the cover and its crops, the listing text and how the store renders it, what the platform draws over the game, safe areas, what the store does not take): where it appears, exact numbers, dos and don'ts, and what is checked. `game_standards` serves it, `checkStandards()` checks a game against it (in `game_standards`, `deploy_preview` warnings and `publish`), the guide is rendered from it (`node scripts/standards-guide.mjs`), and `tests/standards.mjs` fails when its numbers stop matching the code that draws each surface |
| Guides | `web/public/guides/` | The five platform guides served through MCP: the contract, versions and troubleshooting, saves, multiplayer, and platform services (the long form of the catalog in `src/mcp/services.ts`). The older authoring guides stay readable at `/guides/` for existing games |
| Templates | `web/public/templates/` | Starting points that pass verification, used by the end-to-end tests |
| Web app | `web/src/` | Marketplace, game pages, creator console, earnings, admin console (React, in English, 简体中文, 繁體中文, 日本語, 한국어 and Español; see `web/src/i18n/`) |
| Schema | `migrations/` | D1 tables |
| Tests | `tests/e2e.mjs` | End-to-end run against a local Worker with a mock Stripe |

## How a game goes live

1. The creator connects their agent to `https://<site>/mcp`. Sign-in is OAuth 2.1 with PKCE and dynamic client registration; no API keys exist. Access tokens last one hour and the grant thirty days by default (both adjustable), and a creator can revoke an agent from the console at any time. An agent that cannot open a browser (a sandbox, a server, CI) uses device sign-in instead: it posts to `/oauth/device`, shows its user the link it gets back, and polls `/oauth/token` until the user has approved at `/device`. It receives the same expiring tokens. Send a descriptive `User-Agent` header. A request to `/mcp` without a token is answered with these steps, so an agent can work out how to connect by itself.
2. The agent calls `get_started`, creates a project with `create_project` and uploads the game with `upload_files` or, for big files and whole folders, `create_upload_url` and curl.
3. `deploy_preview` runs static checks first (JavaScript syntax, imports that resolve, files that exist, the platform contract, web-only content); `dry_run: true` stops there.
4. It then freezes the files as a numbered version, points the game's preview address at it (the shared game host serves it from R2 within 10 seconds; a game with server-run matches gets its preview Worker redeployed), and opens it in a real browser (Cloudflare Browser Rendering). The version is verified only if the game boots (`GCP.ready()`), keeps rendering frames, draws a non-blank picture, survives keyboard, mouse and touch input, serves every file it asks for, throws no uncaught errors, and (when it calls its own server code) does not make that code crash. The report and a screenshot are stored with the version. A game can also register a play-through (`GCP.test.onPlaythrough`): a short script that plays its own rules to the end. The browser runs it, lists each step in the report, and refuses the version if it fails. Without one, the report says that only start-up, rendering and input were checked.
5. `publish` makes a verified version live in the marketplace. There is no human review. `list_versions`, `rollback` and `unpublish` manage it afterwards.

**Release requirements.** Every way a version goes live (`publish`, `rollback`, an admin approving a review or publishing, a creator putting a game back online) passes one server-side gate, `src/release-gate.ts`, and the publish job in the pipeline runs it again right before the switch, so no agent, client or tool argument can skip a requirement. It checks the game and account (not removed, account active, creator license), the release kind (a rollback only to a version that was live before), the files (still kept, and exactly the files that were verified), verification, the store listing in every platform language the version is played in, that the version was verified against today's checks (a report missing a check added since, such as `capture`, a capture check that only warned because the game was not live yet, or a missing phone and tablet pass for a game that lists them, is sent back to `deploy_preview`), store metadata, storage, the build skill when shared, and originality. The ruleset is versioned (`RULESET`); each outcome is stored on the version (`versions.gate`) and a refusal lists every unmet requirement with what to do. `publish {dry_run: true}` checks without publishing. Admins see every requirement per version under Admin, Games, Release requirements, and can waive a rule a verifier can get wrong for one version, with a reason and an end date (`release_waivers`, at most 30 days, logged with the release); content, conduct, originality, the files and account standing are never waivable. Tests in `tests/release-gate.mjs`; the requirements are also listed in `web/public/guides/troubleshooting.md`.

Games that require WebGPU cannot run in the verification browser. Those versions are verified when their creator plays the preview for a short while without errors.

**Game storage.** Each game may hold up to its storage in files (admin setting `bundle_max_bytes`, 50 MB by default, with the largest file and the file count beside it under Admin, Settings, Storage). An admin can give one game a different amount (Admin, Games, Storage) or approve a creator's request for more, made by their agent with `game_storage {action: "request"}` (capped by `storage_max_bytes`, approved at once below `storage_auto_approve_bytes`). Uploads (MCP, the upload URL, zips, checked from the zip directory before unpacking) refuse growth past it, `deploy_preview` refuses a workspace over it and `publish` a new version over it. Every upload and deploy answer carries the game's storage with a warning from 80% used, and `get_started`, `platform_services`, the storage guide (`web/public/guides/storage.md`) and the Docs page steer agents toward generating content from code and loading large content at run time. The rules are in `src/storage-rules.ts` (tests in `tests/storage.mjs`), the Worker side in `src/storage.ts`.

**Game metadata.** Every game declares what its store page shows: genre (one of 24, stored as the first tag), 2 to 8 tags chosen only from the platform's list (`web/src/tags.ts`: setting and theme, mood, gameplay, players, visual style and view; the store's filters and category pages are built from it, and `scripts/normalize-tags.mjs` maps tags stored before the list), requirements, languages (interface, voice and subtitles per language, and whether it follows the player's platform language `GCP.lang`), players and modes, content descriptors that the platform turns into an age rating (3+, 7+, 12+, 16+, 18+), session length, progress and accessibility, plus the store listing in the platform's six languages: everything about a game outside the game (name, tagline, description, controls, cover) follows the player's platform language on every surface (home, cards, search, game page, library, Continue, Creator Store, friends), shown in it when the game is played in it, else in English, else in the listing's own language (`pickListing` in `web/src/languages.ts`; the Worker side is `src/listing.ts`). Translations are `listing_translations`, the listing's own language `listing_language`, and a cover per language `update_project covers`; the platform languages each live version is played in are recorded on the project (`projects.langs`), and publish refuses a version whose listing misses one of them (release rule `listing_languages`). Build fields live in `gcp.json` and are frozen with each version; genre and translations belong to the project. The `game_metadata` tool returns a numbered checklist with allowed values and suggestions detected from the code, and `publish` refuses a version until genre, requirements, languages, players and content are on record (admin setting `metadata_required`). The rules are in `web/src/gamemeta.ts` and `web/src/languages.ts` (tests in `tests/gamemeta.mjs`); the specification is `web/public/guides/game-metadata.md`. The game page shows an age badge, an At a glance panel, a Languages table and an in-your-language check.

**Adult games.** Sexual content, violence and other mature themes are allowed when the version declares them in `content` (`sexual`: suggestive, nudity, explicit; `violence`: up to graphic; `adult_themes`). A game that reaches 18+ is adults only (`matureOf` in `web/src/gamemeta.ts`, recorded on the project as `age` and `mature` when it goes live, `src/mature.ts`): its cover is blurred and labelled 18+ in every listing, its page keeps the picture blurred, and the player confirms a warning before it starts (`POST /api/games/:slug/play` answers 428 without `confirm_mature`). The content review (`src/content-check.js`) looks at frames the verification browser takes while it starts the game, runs its play-through and gives it input, and refuses a version that shows more sexual content or violence than it declares; content that is never allowed (sexual content involving minors, hate, scams, phishing) is refused whatever is declared. The admin setting `mature_allowed` switches adult games off.

**Compatibility.** Each version carries its requirements (graphics API, hardware GPU, browser features, input, devices, orientation, memory, minimum browsers, known issues), declared in `gcp.json` `requirements` through the `compatibility` tool and merged with what the platform detects in the code at deploy (`web/src/compat.ts`, shared by the Worker, the web app and `tests/compat.mjs`). The game page lists them in a Compatibility section, checks the player's own browser against them (`web/src/compat-probe.ts`) and says before launch whether the game works there. Versions deployed before this get their requirements detected the first time their page is opened.

**Every browser and device.** Device support is the platform's job, so no game has to do anything for it. Three layers carry it: the game runtime (`web/public/sdk/gcp.js`, versioned, every fix listed in `docs/game-runtime.md`) runs inside every game and fixes what differs between browsers and devices, for live games at once, without a republish; `deploy_preview` warns about what no script can fix on iPhone and iPad (`src/device-checks.js`); and verification plays every version again on an emulated iPhone and iPad after it passes on the computer, failing it only when it breaks on a kind of device it says it supports (`requirements.devices`), and noting layout problems (cut off, tiny text, small buttons) otherwise.

**Touch devices.** Every game plays on phones and tablets without code for it (`web/public/sdk/gcp.js`, the touch layer). At deploy, and the first time an older version's page is opened, the platform reads the game's own code for the keys it checks (`web/src/touch-controls.ts`, tests in `tests/touch-controls.mjs`): WASD or the arrows become an on-screen stick, other keys up to six buttons, or a virtual gamepad for a game that reads gamepads and no keys. The game page hands that layout to the SDK, which draws it on touch screens when the game has no touch controls of its own and presses real keys; the player hides or shows it from the game menu. `gcp.json` `controls` and `GCP.controls` let a creator choose. The SDK also gives mouse-only games mouse events from the finger and a pointer-lock stand-in, turns off long-press selection, tap flashes and zoom, retargets taps that just miss a button, and caps `devicePixelRatio` at 2 on phones and tablets (lower for a game that keeps dropping frames). Live games get all of it without a redeploy, since the SDK is served by the platform.

## The contract for games

Six rules (the same list `get_started` gives agents), and nothing else is prescribed:

1. A game is a web page: `index.html` at the bundle root plus whatever it loads by relative path. No build step. Web games only.
2. Call `GCP.ready()` once, after the first playable frame is drawn.
3. Keep rendering, throw no uncaught errors, survive input, and stay on the page (no redirects, downloads or popups).
4. Declare what the game shows (`game_metadata` content). Mature content is allowed when declared; adults-only games are blurred and labelled 18+.
5. Fit the game's storage (per-game total, per-file and file-count limits).
6. A game in several languages is listed in each of them: for every platform language it declares, the store listing (name, tagline, description, controls, and a cover per language when it shows text) is in that language too.

A version the verification browser cannot run (it needs WebGPU, or no browser was available) can still qualify through the creator's own clean preview session, but it then waits for an admin's approval in the Reviews queue before it goes live.

Genre, art direction, engine and rendering technique are the creator's, and the platform neither prescribes nor scores them.

## Creator licenses

The console is for creators only. An account without a valid creator license that opens it (the Console link, or any page under `/console`) sees a Get License button instead, which leads to `/license`: two licenses side by side, a time-limited one (one year and $10 by default) and a lifetime one ($50 by default), both one-time payments and never subscriptions. Prices and the time-limited license's length are admin settings (Creator license). Choosing one opens Stripe Checkout, and the license is granted when the payment succeeds (on return and from the webhook), then the console opens. A license priced at $0 is granted at once; when the lifetime license is free, Get License grants it directly. The two cannot be converted into each other, and while one is valid neither can be bought; a payment that slips through anyway (two checkouts open) is refunded. A time-limited license that ends is no license: the console closes again and publishing stops until a new one is bought, while live games stay live. Licenses granted before there were two kinds are lifetime. Rules in `src/license.ts`, tests in `tests/license.mjs`.

## Player progress

Every game gets per-player progress from the platform: cloud saves (`GCP.save`), player stats (`GCP.playerStats`) and a play record the platform keeps by itself (sessions, play time, first and last played, best scores; `GCP.playRecord()`). The rules live in `src/player-data.js` and are tested in `tests/player-data.mjs`:

- The game, environment and player always come from the signed play token, checked against that game's own key. A request body cannot name another player or game.
- Preview and live data are separate. The verifier plays under a throwaway identity (`verify:<session>`), cleaned up daily, so it never touches a creator's own saves.
- Players see and reset their own progress on the game page (`/api/games/:slug/progress`). Creators get totals and averages through `game_data`, never one player's data.
- **Continue playing.** Signed-in players get a Continue row on the store front and a library (`/library`, `/api/me/continue`, `/api/me/library`): every live game they played, most recent first, with play time, last played and last saved, built from the play record with no game code. A game may add where the player is with `GCP.resume.set({ label, detail, progress })` (cleared with `GCP.resume.clear()`, and by a progress reset), and Continue opens it with `GCP.launch.continue` true so it can skip its title screen and load the saved run. A player can take a game off the row; it comes back when they play it again. Rules in `src/player-data.js`, tests in `tests/continue.mjs`.
- The SDK's offline copy in `localStorage` is keyed by game, environment and player, so people sharing a browser stay apart.

## Friends, chat and invites

Players add friends by name or by friend code (`XXXX-XXXX`); a request becomes a friendship only when the other player accepts, and they get a notification for it. Friends chat one to one, invite each other to play from the friends panel or from inside a game, and can be removed, blocked (which also ends the friendship and cancels invites) and reported. Status is Online, Away, Busy or Invisible (shown as Offline), with automatic Away after 5 minutes in a hidden tab; friends see which game an online friend plays and for how long, unless that friend hides it. Invites go only to Online, Away and Busy friends; a Busy friend gets them quietly (no pop-up), and Invisible and Offline friends cannot be invited. Privacy settings on the Account page choose who may send requests, messages and invites, whether friends see the game and may join it, and whether the player can be found by name. Admin, Reports handles abuse reports.

- Rules: `src/social-rules.js` (pure, over D1, tested in `tests/social.mjs`); routes: `src/routes/social.ts` (`/api/social/*`) and `/api/rt/friends` for games. Migration `0037_friends.sql`.
- Live delivery: one `SocialHub` Durable Object per account (`src/social.ts`) holds that account's open pages over a hibernating WebSocket, works out its presence (`src/presence.js`) and pushes changes to its friends' hubs. The web app falls back to polling once a minute when the socket is down.
- Games: SDK 2.7.0 `GCP.friends`, `GCP.presence`, `GCP.launch.join`, `GCP.match.join`. `GCP.match.find({ private: true })` opens an invite-only lobby: the matchmaker names it with a platform-made code and the owner gets a signed lobby token (`src/lobby.ts`) that invites carry, so nobody enters by guessing. Typed codes keep working for older games, but the guides recommend friend invites.
- Limits (admin settings, group "Friends and chat"): friends per account, requests per day, messages per minute, invites per 10 minutes, days chat is kept. Guests and the verifier have no friends.

## Two-factor sign-in

Any account can turn on two-factor sign-in under Account: an authenticator app (TOTP: 6 digits, 30 seconds, the settings Google Authenticator, Microsoft Authenticator, 1Password and Authy use) plus ten single-use recovery codes, shown once. With it on, the right password only opens a second step (`/api/auth/login/code`): the code has to follow within five minutes and five tries, and a password reset link still asks for it. Every way in goes through that login, so agent sign-in (OAuth and device sign-in) is covered too. A code works once, the secret is stored encrypted with a key derived from `SESSION_SECRET` and bound to its account, and recovery codes and challenges are kept only as hashes. Turning it off or making new recovery codes needs the password and a code. An admin can turn it off for someone who lost both their phone and their codes (Admin, Users, Actions).

It is account security, the same for players and creators: `src/two-factor.ts` knows nothing about roles. The creator console only suggests it to creators who have not turned it on. Rules and tests: `src/two-factor.ts`, `tests/two-factor.mjs`.

## Game sessions and accounts

Games have no login of their own: every player signs in to the platform and plays as that account, free games included (admin setting "Require login to play", on by default). A signed-out visitor who presses Play is sent to sign in or create an account and comes back to the game, which then starts. Only if an administrator switches the setting off can free games be played as a guest; paid games, purchases and trials always need an account. Each session is bound to the identity that started it. The rules live in `src/session-binding.js` and are tested in `tests/session-binding.mjs`:

- An account's session belongs to the sign-in it started from. Signing out, signing in again (as anyone) in the same browser, the sign-in expiring or the account being suspended ends it, and every service call from a game still open on it (another tab, a reload, the token kept on the game's own origin) is refused with `session_ended`. The SDK stops the game and the game page closes it and says why; other tabs notice through a `BroadcastChannel` and when they come back into view.
- A game page reopened from the token its origin kept in a cookie is served only after the platform confirms the token is still bound (`/api/rt/check`); opened by itself it goes to the game's page, which starts it for whoever is signed in there (`?play=1`).
- Long sessions renew their token shortly before it runs out (`/api/rt/renew`) while the session is still bound, so saves never start failing mid-play. Free-trial tokens are not renewed, and a paid game is renewed only while the player still owns it.
- Progress made as a guest (while guest play was allowed) is offered to the account after sign-in or sign-up and moves only when the player says yes (on a shared computer it may be someone else's). It moves once: the guest id is then retired, its sessions end, and the browser gets a new guest id. In a game where the account already has progress, the account's progress stays as it is and the guest's is never mixed into it.

## Money

- **Creator license.** A one-time payment to publish any number of games: time-limited (default $10 for a year) or lifetime (default $50). Building and previewing are free. See Creator licenses above.
- **Free or paid games.** A creator sets a price or leaves the game free. Players pay the platform; the platform keeps its cut (default 10%, or 5% for a game that shares its build skill for free) and credits the rest to the creator's balance after a holding period (default 3 days). Buyers refund a game themselves, at once, within 1 day of buying it if they played it for less than 10 minutes (see Refunds below); creators get an email when a payout is sent.
- **Limited-time sales** (`src/sales.ts`). A creator puts a paid game on sale with `update_project sale {price_cents, days}` or from the console: at least `sale_min_percent_off` (10%) off, for at most `sale_max_days` (30), and the next sale `sale_gap_days` (30) after the last one ended or the price went up. The store shows the sale price with the regular price struck through and when it ends, the home page has an On sale shelf, and checkout charges the sale price; the cut, the creator's credit and any refund follow the price actually paid.
- **Build skills in the Creator Store.** A game that shares its Open Implementation lists a build skill at `/creator-store`, written by its own agent before each release (`build_skill`; `publish` refuses a new version without one while sharing is on, admin setting `skill_required_to_publish`). Free skills show in full to everyone; a creator can instead sell the skill (`skill_price_cents`), and then only buyers, the creator and admins see its content. A sold skill keeps the game at the standard cut, and the platform keeps a separate skill commission (`skill_fee_percent`, 5% by default) on each skill sale. Skill sales live in `skill_purchases` with their own ledger kind (`skill_sale`) and are shown apart from game sales in the console, earnings and admin. Build skills are non-refundable: their content shows the moment the payment succeeds, so there is no self-serve refund, the admin refund action refuses skill purchases (`skill_non_refundable`), and checkout states it next to the Pay button and in the consent the buyer ticks. Only games can be refunded. A chargeback, or a refund someone makes by hand in the Stripe Dashboard, is still booked against the creator's credit so the ledger matches the money.
- **Rewards for Open Implementation.** A paid game that shares its build skill for free pays the lower cut on sales made while it is shared (the purchase keeps the fee it was charged, so refunds and payouts are unaffected by later changes). A free game that shares ranks higher among free games: its recent play counts 50% more (by default) in the free-game order, capped at double, and never for a poorly rated game. Both rates and the boost are admin settings.
- **Free trials.** A creator can let players try a paid game for a set number of minutes (console or `update_project trial_minutes`). The time is kept per player account on the server, counted by wall clock while the game is open, with at least 30 seconds charged per session, so reloading or switching devices does not reset it. A trial play token expires with the trial, after which saves, leaderboards, rooms and new sessions are refused and the game page asks the player to buy. Admins can switch trials off or cap their length.
- **Payouts.** Once the available balance reaches the minimum (default $50), it is sent to the creator's Stripe Connect account automatically each day, and Stripe pays it out to their bank. Creators can also withdraw it sooner. Manual payouts settled by an administrator are off by default and can be turned on in the admin console.
- **Refunds** (`src/refunds.ts`, games only; build skills are non-refundable). A buyer presses Refund on the game page or under Purchases and refunds (`/purchases`, linked from the Library and the account menu). The server decides: within `refund_window_hours` of buying (24) and under `refund_max_play_minutes` of play (10, the platform's own clock, free trial included), the first refund of that game for that buyer (refunded and bought again is final). An eligible refund goes through Stripe at once; one that is not shows the button greyed out with every reason listed. The confirmation says the money takes 5 to 10 business days to show up. A refund the platform cannot settle by itself becomes a request an admin decides under Admin, Money, Refunds: an account that refunded `refund_limit_count` games (3) within `refund_limit_days` (30) loses self-service until an admin gives it back, play time the page's check-ins could not confirm, `refund_auto` off, or Stripe not answering. While a request is open the sale's credit is held from payouts. The books of every refund are kept on its `refund_requests` row: the buyer gets the full price, the creator's credit is taken back (and that much of their Transfer is reversed when it was already paid out), the platform gives back its cut, and Stripe's kept processing fee is absorbed by the platform or charged to the creator (`refund_fee_bearer`, platform by default). Buyers get emails when a refund goes through, is waiting or is declined; creators when a sale is refunded. Tests in `tests/refunds.mjs`.
- **Chargebacks** revoke access and take back the creator's credit; a partial refund from the Stripe Dashboard takes back its share. A chargeback the platform wins gives both back.

Stripe is used for everything: Checkout for payments, Connect (Accounts v2 recipient accounts with the Express Dashboard) and Transfers for payouts, signed webhooks for reconciliation. Every number above is a setting in the admin console.

Stripe's own processing fee is charged to the platform account, so by default it comes out of the platform's cut. The settings "Payment processing cost passed on to the creator" let you pass it through instead.

## Cloudflare resources

Declared in `wrangler.jsonc`: D1 (`gcp-db`), R2 (`gcp-games`), KV (OAuth state), Durable Object classes (`GameRoom` for realtime rooms, `Matchmaker` for queues and private lobbies, `SocialHub` for friends and presence, `BotFleet` for preview test bots, `PlayClock` and `GameTally` for play time and players online, `Pipeline` for deploy jobs), a Worker Loader (`LOADER`, for games' server code), Browser Rendering, static assets, and crons (daily cleanup and payouts, every 10 minutes and every minute for rankings and the runtime rollout).

Games do not get a Worker each. With `DEPLOY_DRIVER` `"shared"` (the setting in use), the platform Worker answers on the wildcard route `*.hearthcade.app/*` and serves every game and version itself from R2 (`src/game-host.ts`, [docs/shared-game-host.md](docs/shared-game-host.md)); a game's `server/index.js` runs in a Dynamic Worker built for that version, with only the game's own env. Only a game with server-run matches (`server/match.js`) is still deployed as a standard Worker, `gcp-<project>-preview` or `gcp-<project>-live`, through the Cloudflare API, because a match is a Durable Object of its own script.

Addresses: the platform is `https://hearthcade.com` (`PUBLIC_ORIGIN`; `www` redirects to it). Games are served from their own domain, `https://gcp-<project>-<env>.hearthcade.app` (`GAME_HOST` and `GAME_ZONE_ID`; a proxied wildcard DNS record and the wildcard route, plus a per-script route for each match game, which the platform creates). The games domain is a different site from the platform, so a game page can never read or plant the platform's cookies, and each game's token cookie is `__Host-` prefixed so games cannot interfere with one another. No Worker answers on `workers.dev`.

## Secrets

| Name | Needed for |
| --- | --- |
| `SESSION_SECRET` | Signing play tokens. Any long random string |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | Deploying the Workers of games with server-run matches (every other game is on the shared host). The token needs Workers Scripts: Edit, and Workers Routes: Edit on the `GAME_HOST` zone |
| `ADMIN_CLAIM_TOKEN` | Claiming the first admin account at `/claim-admin?token=…`. Works once |
| `STRIPE_SECRET_KEY` | The creator fee, game sales and Stripe payouts. A restricted key; [docs/stripe.md](docs/stripe.md) lists its permissions |
| `STRIPE_WEBHOOK_SECRET` | Verifying the platform account's webhooks sent to `/api/stripe/webhook` |
| `STRIPE_ACCOUNTS_WEBHOOK_SECRET` | Verifying the creator-accounts event destination (Accounts v2 thin events) sent to the same address |

Without the Stripe secrets the platform runs with payments switched off: free games work, and the admin can grant creator licenses by hand.

### Stripe setup

The full setup (Connect settings, the restricted key's permissions, both webhook endpoints, sandbox tests and the go-live
list) is in [docs/stripe.md](docs/stripe.md). In short:

1. Create a Stripe account with Connect (marketplace, Express onboarding, Transfers), in a sandbox first.
2. `wrangler secret put STRIPE_SECRET_KEY` with a restricted key (`rk_…`).
3. Two webhook endpoints at `https://<site>/api/stripe/webhook`, API version `2026-10-28.endive`: one for your account's
   events (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`) and a thin-event destination for creators' accounts
   (`v2.core.account[configuration.recipient].capability_status_updated`, `v2.core.account[requirements].updated`). Their
   signing secrets go in `STRIPE_WEBHOOK_SECRET` and `STRIPE_ACCOUNTS_WEBHOOK_SECRET`.

## Develop

```sh
npm install
npm run db:local            # apply migrations to the local D1
node scripts/local-verifier.mjs &   # Playwright stand-in for Browser Rendering (needs Playwright + Chromium)
npm run build && npx wrangler dev   # http://127.0.0.1:8787
node tests/e2e.mjs          # full flow against the local Worker
npm test                    # web-only checks and the frozen outputs of the procedural core
```

Local settings go in `.dev.vars`:

```
SESSION_SECRET=dev
DEPLOY_DRIVER=local
VERIFIER_URL=http://127.0.0.1:8799
ADMIN_CLAIM_TOKEN=dev-claim
STRIPE_SECRET_KEY=sk_test_local
STRIPE_WEBHOOK_SECRET=whsec_local
STRIPE_API_BASE=http://127.0.0.1:8798
```

With `DEPLOY_DRIVER=local` games are served from the platform Worker itself under `/__game/…` using the same runtime module the shared game host runs.

## Deploy

```sh
npm run db:remote           # apply migrations to the remote D1
npx wrangler secret put SESSION_SECRET     # and the other secrets above
npm run deploy              # build the web app and deploy the Worker
```

Games are served by the shared game host (`DEPLOY_DRIVER=shared`, [docs/shared-game-host.md](docs/shared-game-host.md)). The older drivers still work: `cloudflare` deploys a standard Worker per game and environment, and `dispatch` puts those Workers in a Workers for Platforms dispatch namespace (a dispatch Worker and an outbound Worker in `dispatcher/` and `outbound/`; steps in [docs/workers-for-platforms.md](docs/workers-for-platforms.md)). Changing the driver moves games over a few at a time.

To check a deployment end to end (sign-up, OAuth, MCP, a real deployed game and browser verification for each template) without touching the admin claim:

```sh
BASE=https://<site> node tests/live-smoke.mjs
```

It leaves a throwaway account and draft projects behind; remove them from the admin console.

Then open `https://<site>/signup`, create an account, and visit `https://<site>/claim-admin?token=<ADMIN_CLAIM_TOKEN>` to become the administrator.
