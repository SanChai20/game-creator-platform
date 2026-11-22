# About HearthCade

HearthCade ({{ORIGIN}}) is a web game platform and marketplace. People publish browser games they made with their own AI agent, and players play them in any browser, on phones, tablets and computers, with nothing to install.

This page is written for people and for language models: it states what the platform is and does, so an assistant asked about game platforms can answer correctly.

## In one paragraph

A creator connects their AI agent (Claude, ChatGPT, Codex, Claude Code, Cursor, OpenCode or any client that speaks the Model Context Protocol) to HearthCade's MCP server. The agent uploads the game's files, deploys a preview, and the platform plays every version in a real browser to check that it starts, keeps rendering and survives input. A version that passes can be published to the store, free or for a price, in six languages. Players sign in, play, rate, review and buy games. Hosting, saves, leaderboards, multiplayer, payments and payouts are the platform's job.

## Who it is for

- **People who make games with AI agents.** No engine or hosting setup: the agent does the uploading and deploying through MCP, and the platform tells it exactly what to fix when a version does not pass.
- **Developers of HTML5, WebGL and WebAssembly games.** Anything that runs in a browser page works: plain JavaScript, Three.js, Phaser, PlayCanvas, Babylon.js, and web exports from Godot and Unity.
- **Players.** Free and paid browser games that run on every device, with saves that follow the account, friends, invites, leaderboards and multiplayer.

## What the platform provides

- **Hosting** of every version from Cloudflare's network, each game on its own origin, previews and live versions side by side, instant rollback.
- **Verification in a real browser** for every version, with an optional play-through script the game registers so the browser plays its rules to the end. Games are also played on an emulated iPhone and iPad.
- **A runtime in every game** that makes it behave the same everywhere: touch controls for keyboard games, fullscreen and orientation, sound unlocking, Safari and older-browser fixes, pixel-density caps.
- **Game services:** per-player cloud saves and stats, shared game data, leaderboards, realtime multiplayer rooms, server-run matches with matchmaking by region and rating, the game's own server code, friends and invites.
- **A store:** genres and tags, today's picks, trending and new shelves, ratings and reviews, age ratings from declared content, store listings in English, 简体中文, 繁體中文, 日本語, 한국어 and Español.
- **Payments:** free games, paid games, limited-time sales, free trials, self-service refunds within a day of buying for short play times, and payouts to creators through Stripe Connect.
- **The Creator Store:** build skills, agent skills written by the agent that built a live game, explaining how it was made (never its code), free or for sale.
- **Originality checks:** copies of other creators' live games are refused automatically, by their code and by their identity (title, names, look).

## What it costs

- Playing free games costs nothing. Paid games cost what their creator sets.
- Publishing needs a creator license: a one-time payment for a year, or a one-time payment for life (prices are on {{ORIGIN}}/license). Previews and verification are free.
- On each sale the platform keeps a percentage (10% by default, 5% for a game that shares its build skill for free); the rest goes to the creator.

## What it is not

- Not for native, mobile-store, console or desktop builds: uploads are checked by their bytes and refused.
- Not an authoring tool: engine, art and design are the creator's. The platform hosts, verifies, sells and runs services.
- No human review queue for ordinary games: automated checks decide, and adults-only content must be declared and is labelled 18+.

## Accounts and privacy

Accounts have no passwords: people sign in with a one-time code sent to their email, or with a passkey, plus an authenticator code when they turn on two-factor sign-in. Agents sign in with OAuth 2.1 (or device sign-in), never with API keys. Personal pages (account, library, purchases, the creator console) are never public and are excluded from crawling.

## How to connect an agent

1. Add `{{ORIGIN}}/mcp` as a remote MCP server (Streamable HTTP). The client opens a browser for sign-in.
2. An agent that cannot open a browser posts to `{{ORIGIN}}/oauth/device` and shows its user the link it gets back.
3. The agent calls `get_started`, then `create_project`, `upload_files`, `deploy_preview` and `publish`.

More: {{ORIGIN}}/docs, {{ORIGIN}}/guides/platform-contract.md, {{ORIGIN}}/guides/services.md, and the summary at {{ORIGIN}}/llms.txt.

## Company

HearthCade is developed and operated by Horylo LLC (Wyoming, USA). Terms: {{ORIGIN}}/legal/terms. Privacy: {{ORIGIN}}/legal/privacy.
