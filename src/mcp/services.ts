// The catalog of platform services, as agents read it: what each one is, how it works, how a game or an agent
// reaches it (SDK calls, MCP tools, HTTP), its limits and how to use it well. Also what the platform does not
// provide, so an agent plans around it instead of looking for it. Served by the platform_services tool and the
// gcp://services resource; the long form is the "services" guide (web/public/guides/services.md).
// Pure data over the settings, so tests/services.mjs can check it against the SDK and the tool list without a Worker.
import type { Settings } from '../settings';

export type Availability = 'available' | 'disabled' | 'automatic';
export interface Service {
  id: string;
  name: string;
  category: 'hosting' | 'player data' | 'multiplayer' | 'runtime' | 'quality' | 'business' | 'insight' | 'agent access';
  status: Availability;
  what: string;
  how_it_works: string;
  use_for: string[];
  sdk: string[];          // calls the game makes on window.GCP
  mcp_tools: string[];    // tools the agent calls on this server
  http?: string[];        // other addresses an agent or a shell uses
  limits: Record<string, string | number | boolean>;
  guidelines: string[];
  guide: string | null;   // get_started {topic} with the details
}
export interface Missing { need: string; status: 'not provided'; instead: string }

const MB = 1024 * 1024;
const mb = (n: number) => `${Math.round((n / MB) * 10) / 10} MB`;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const on = (b: boolean): Availability => (b ? 'available' : 'disabled');

/** Every service the platform offers to games and the agents that build them, with this platform's live limits. */
export function platformServices(s: Settings, origin: string): Service[] {
  return [
    {
      id: 'hosting', name: 'Game hosting and delivery', category: 'hosting', status: 'available',
      what: 'Serves each version of a game from its own Cloudflare Worker, one address for the preview and one for the live game.',
      how_it_works: 'Uploaded files sit in a workspace. deploy_preview freezes them as a numbered, immutable version in R2 and points the game\'s preview Worker at it; publish points the live Worker at a verified version, and rollback points it back. The Worker gates index.html behind a signed play session, injects the SDK and an import map, and serves every other file with its content type, range requests and caching (5 minutes on live, revalidated on preview).',
      use_for: ['Any web game: HTML, JavaScript, CSS, WebAssembly, and web exports from Unity, Godot, Phaser, PlayCanvas, Babylon.js or Three.js', 'Assets the game needs (models, audio, wasm) within its storage, streamed with range requests', 'Instant rollback to any earlier version'],
      sdk: ['GCP.env', 'GCP.version', 'GCP.gameId'],
      mcp_tools: ['create_project', 'upload_files', 'create_upload_url', 'list_files', 'deploy_preview', 'list_versions', 'publish', 'rollback', 'unpublish', 'list_projects'],
      http: [`PUT ${origin}/api/upload/<token>?path=<file> (one file) and POST ${origin}/api/upload/<token>/zip (a folder as a zip), from create_upload_url`],
      limits: { upload_url_minutes: 30, files_per_bundle: s.bundle_max_files, bundle_size: mb(s.bundle_max_bytes), file_size: mb(s.file_max_bytes), projects_per_creator: s.projects_per_user, build_step: 'none: upload what the browser runs', storage: 'per game; see the storage service' },
      guidelines: ['index.html at the bundle root; load everything else by relative path. Paths are case sensitive.', 'Bundle code libraries rather than loading them from a CDN at run time; a bundled file cannot disappear. Large media is different: see the storage service.', 'Upload big or binary files and whole folders with create_upload_url and curl, not upload_files.', 'Every deploy_preview is a new version; fix and redeploy instead of editing a version.'],
      guide: 'versions',
    },
    {
      id: 'storage', name: 'Game storage', category: 'hosting', status: 'available',
      what: 'A storage limit for each game: how much all its files may add up to, with the largest file and the number of files. The platform sets a default for every game and can give one game more.',
      how_it_works: `Every game may use ${mb(s.bundle_max_bytes)} unless the platform set a different amount for it. upload_files, the upload URL and zip uploads refuse a change that would take the game over (only growth is refused: deleting or shrinking always works), deploy_preview refuses a workspace that is over, and publish refuses a new version that is over (a rollback to a version that was live before is allowed). Every upload, list_files, list_projects and deploy_preview answer carries storage (used, storage, free, percent_used) and a warning from 80% used. ${s.storage_requests_open ? `A creator can ask for more with game_storage {action: "request"}, up to ${mb(s.storage_max_bytes)} per game; ${s.storage_auto_approve_bytes > 0 ? `requests up to ${mb(s.storage_auto_approve_bytes)} are approved at once and larger ones` : 'each request'} waits for an admin.` : 'Requests for more storage are closed on this platform.'}`,
      use_for: ['Knowing, before choosing assets, how much the game can ship', 'Seeing what uses the space (game_storage lists it per kind of file and the largest files)', 'Asking for more when a game truly needs it'],
      sdk: [],
      mcp_tools: ['game_storage', 'list_files', 'upload_files', 'list_projects'],
      limits: { storage_per_game: mb(s.bundle_max_bytes), largest_file: mb(s.file_max_bytes), files_per_game: s.bundle_max_files, requests: s.storage_requests_open ? `up to ${mb(s.storage_max_bytes)} per game` : 'closed', approved_at_once_up_to: s.storage_auto_approve_bytes > 0 ? mb(s.storage_auto_approve_bytes) : 'none: an admin reviews each request', counts: 'every file in the workspace; platform-hosted Three.js and @gcp/ modules do not count' },
      guidelines: [
        'Tell the developer the game\'s storage when planning it, and again when an answer carries storage.warning.',
        'Generate meshes, terrain, textures, sound and music from code at boot instead of shipping them (get_started guides "procedural-generation", "meshes", "materials-textures", "audio").',
        'Load large or optional content at run time from a host the developer controls: any HTTPS host that sends CORS headers works, with plain GET requests. Call GCP.ready() once the core game plays and stream the rest; every URL must work when the version is verified.',
        'Compress what ships: Draco or Meshopt glTF, KTX2 or WebP textures, Opus/OGG audio.',
        'Ask for more (game_storage {action: "request"}) only after that, with the developer\'s agreement and a concrete reason.',
      ],
      guide: 'storage',
    },
    {
      id: 'libraries', name: 'Hosted libraries and import map', category: 'hosting', status: 'available',
      what: 'Three.js (WebGL and WebGPU builds, addons) and the platform\'s optional @gcp/ helper modules, served by the platform and wired up with an import map.',
      how_it_works: 'Unless index.html has its own <script type="importmap">, the platform adds one so `import * as THREE from \'three\'`, `three/webgpu`, `three/tsl`, `three/addons/…` and `@gcp/…` resolve with no bundler. get_started lists the exact addresses under import_map.',
      use_for: ['Three.js games without bundling Three.js', 'Optional helpers (frame loop, input, HUD, synthesised sound, host-authoritative netcode) from @gcp/'],
      sdk: [], mcp_tools: ['get_started'],
      http: [`${origin}/vendor/three-<version>/…`, `${origin}/kits/v1/<module>.js`],
      limits: { own_import_map: 'if the page has one, the platform adds none: list every bare import there' },
      guidelines: ['Using them is optional; any engine or library in the bundle works.', 'Pin any CDN URL you use to an exact version.'],
      guide: 'contract',
    },
    {
      id: 'lifecycle', name: 'SDK and game lifecycle', category: 'runtime', status: 'available',
      what: 'window.GCP, injected at the top of every game page before any game code runs.',
      how_it_works: 'The SDK reports loading progress, readiness and fatal errors; records uncaught errors, failed file loads and console.error; sends a heartbeat every 15 seconds that measures active play time (tab visible, frames advancing); and gives the game the signed-in player. Outside the platform (a local file or dev server) it runs standalone with a local player and offline fallbacks, so the same code runs everywhere.',
      use_for: ['Telling the platform when the game is playable', 'A loading bar the verification report can show', 'Reporting why a game could not start'],
      sdk: ['GCP.ready(info)', 'GCP.progress(f, label)', 'GCP.fatal(err)', 'GCP.stats(obj)', 'GCP.standalone', 'GCP.sdk', 'GCP.portrait'],
      mcp_tools: ['get_started'],
      limits: { ready_timeout_seconds: s.verify_ready_timeout_s, heartbeat_seconds: 15 },
      guidelines: ['Call GCP.ready() exactly once, right after the first playable frame is drawn.', 'Never import or bundle the SDK; guard with `if (window.GCP)` only for tests outside the platform.', 'Every SDK call that reaches the network resolves instead of throwing.'],
      guide: 'contract',
    },
    {
      id: 'identity', name: 'Player accounts and play sessions', category: 'player data', status: 'available',
      what: 'Every game is opened by a signed-in platform account. The game gets that player\'s id and display name, and every service call is tied to them.',
      how_it_works: `${s.require_login_to_play ? 'Players must be signed in ("Require login to play" is on).' : 'Free games can also be played as a guest ("Require login to play" is off): GCP.player.guest is true, the id is kept per browser, and paid games still need an account.'} Pressing Play on the game page starts a play session: the platform signs a play token (HMAC with the game's own key) naming the game, environment (preview or live) and player, valid ${6} hours (a free-trial token only as long as the trial has left). The game Worker checks it before serving index.html; the SDK keeps it out of reach of the page's own scripts and attaches it to every service call. Accounts, sign-in, purchases and the game page are the platform's; a game never handles passwords or emails.`,
      use_for: ['Greeting the player by name', 'Opening in the player\'s platform language (GCP.lang) when the game declares languages.follows_platform', 'Telling players apart in rooms', 'Keying anything per player in server code (env.player.id)'],
      sdk: ['GCP.player', 'GCP.player.guest', 'GCP.env', 'GCP.lang'],
      mcp_tools: [],
      limits: { session_hours: 6, player_fields: 'id, name (display name only), guest', login_required: s.require_login_to_play, guest_session_hours: 1 },
      guidelines: ['Never ask for emails, real names or anything personal inside a game.', 'GCP.player.id is stable per account: use it, not localStorage, to recognise a player.', 'A player may open the game in two tabs: rooms give each connection its own peer id.'],
      guide: 'saves',
    },
    {
      id: 'saves', name: 'Cloud saves', category: 'player data', status: 'available',
      what: 'Per-player, per-game JSON storage in the platform database (D1), following the player across devices and versions.',
      how_it_works: 'GCP.save writes through to the server and keeps a copy in localStorage keyed by game, environment and player. The server takes the game, environment and player from the play token, never from the request, so a game cannot read another player\'s or another game\'s data. Preview and live are separate. The verifier plays under a throwaway identity, so it starts from no save and never touches real progress. Players can see and reset their progress on the game page.',
      use_for: ['Progress, unlocks, settings, inventories', 'Save slots', 'Anything a player would miss on another device'],
      sdk: ['GCP.save.get(key)', 'GCP.save.set(key, value)', 'GCP.save.remove(key)'],
      mcp_tools: ['game_data'],
      limits: { keys_per_player: 64, bytes_per_value: '256 KB', key_length: '1 to 120 characters', offline: 'falls back to localStorage; set resolves false' },
      guidelines: ['Load the save before GCP.ready(); save at checkpoints, every 20 to 30 seconds while playing, and on visibilitychange (hidden).', 'Put a version field in every save and migrate old shapes on load.', 'Treat a loaded save as untrusted input.', 'Creators see counts and totals (game_data summary), never one player\'s save.'],
      guide: 'saves',
    },
    {
      id: 'player_stats', name: 'Player stats', category: 'player data', status: 'available',
      what: 'Named numbers per player and game, updated atomically on the server.',
      how_it_works: 'add, max, min and set run as single statements on the server, so two tabs never lose an increment. Players see the numbers on the game page; game_data summary aggregates them across players (count, sum, average, minimum, maximum).',
      use_for: ['Levels cleared, coins, kills, best lap, chapter reached', 'Achievement-style milestones (there is no separate achievements service)'],
      sdk: ['GCP.playerStats.add(name, n)', 'GCP.playerStats.max(name, v)', 'GCP.playerStats.min(name, v)', 'GCP.playerStats.set(name, v)', 'GCP.playerStats.get(name)', 'GCP.playerStats.all()'],
      mcp_tools: ['game_data'],
      limits: { names_per_player: 64, name_length: '1 to 60 characters', offline: 'resolves null' },
      guidelines: ['Use readable names (levels_cleared, not lc): players see them.'],
      guide: 'saves',
    },
    {
      id: 'play_record', name: 'Play record', category: 'player data', status: 'automatic',
      what: 'What the platform records by itself for each player in each game, with no game code.',
      how_it_works: 'Built from the heartbeats: sessions, active play seconds, first and last played, last version played, plus the player\'s stats, best leaderboard scores and save totals.',
      use_for: ['A "welcome back" message', 'Skipping the tutorial for returning players', 'A total-time line on a stats screen'],
      sdk: ['GCP.playRecord()'],
      mcp_tools: ['game_data'],
      limits: {},
      guidelines: ['Read it once at boot; it changes only every 15 seconds.'],
      guide: 'saves',
    },
    {
      id: 'shared_data', name: 'Shared game data', category: 'player data', status: 'available',
      what: 'Game-wide JSON every player of the game can read: levels, configuration, a message of the day, a daily seed.',
      how_it_works: 'Stored per game and environment. Players read it with GCP.shared.get; only the creator (game_data set, through MCP) and the game\'s server code (env.store without a player) can write it, so players cannot tamper with it.',
      use_for: ['Level packs and balance numbers changed without a new version', 'Events and announcements', 'A daily challenge written by server code'],
      sdk: ['GCP.shared.get(key)'],
      mcp_tools: ['game_data'],
      limits: { bytes_per_value: '256 KB', key_length: '1 to 120 characters' },
      guidelines: ['Seed preview and live separately: game_data {env: "preview"} for the preview.', 'Have a built-in default for when a key is missing.'],
      guide: 'saves',
    },
    {
      id: 'leaderboards', name: 'Leaderboards', category: 'player data', status: 'available',
      what: 'Named boards that keep each player\'s best score, highest or lowest first.',
      how_it_works: 'submit keeps the better of the stored and the new score per player and board; top returns the leading rows with the player\'s display name and a me flag. Boards exist once something is submitted. The verifier\'s scores are never stored.',
      use_for: ['High scores', 'Fastest times (order "asc")', 'Per-level or per-season boards (board name per level or season)'],
      sdk: ['GCP.leaderboard.submit(board, score, order)', 'GCP.leaderboard.top(board, limit, order)'],
      mcp_tools: ['game_data'],
      limits: { board_name: 'up to 40 characters', top_rows: '1 to 100', entries: 'one best score per player per board' },
      guidelines: ['Scores sent from the page can be forged; for boards that matter, check the run in server code and keep the trusted score there.', 'Use the same order for submit and top.', 'game_data {action: "clear_leaderboard"} resets a board (e.g. for a new season).'],
      guide: 'saves',
    },
    {
      id: 'multiplayer', name: 'Realtime multiplayer rooms', category: 'multiplayer', status: 'available',
      what: 'WebSocket rooms on the platform\'s servers: presence, a host with automatic migration, messages to everyone, one peer or the host, and a stored snapshot for late joiners.',
      how_it_works: 'GCP.room(code) connects to one Durable Object per game, environment and room code, created by the first player to join. The first player in is the host; when the host leaves, the longest-connected player becomes host. The room relays messages, it does not run game logic: the host is the authority. The host can store one snapshot that every newcomer gets in its open event. The SDK reconnects by itself with backoff. An empty room forgets everything. Rooms use WebSocket hibernation, so idle rooms cost nothing.',
      use_for: ['Real-time co-op and versus games', 'Turn-based games (the host checks each move and stores the state)', 'Shared worlds while players are connected', 'Lobbies by room code (friends share a code)'],
      sdk: ['GCP.room(code, { max })', 'room.on(open | join | leave | host | message | state | close | error, fn)', 'room.off(type, fn)', 'room.send(data, to)', 'room.setState(data)', 'room.leave()', 'room.id / room.hostId / room.isHost / room.peers / room.state / room.connected'],
      mcp_tools: ['game_room', 'get_stats'],
      limits: { players_per_room: s.room_max_peers, players_per_room_hard_cap: 64, message_size: '64 KB', state_size: '256 KB', room_code: 'up to 40 characters', message_format: 'JSON (text frames); binary frames are dropped', reconnect: 'up to 6 tries with backoff; not after "room full" (4003)' },
      guidelines: ['Send inputs or deltas at 10 to 20 per second, not every frame; send snapshots from the host.', 'Use room.setState for what a late joiner needs, not for every tick.', 'Play remote movement through GCP.smooth so it stays smooth on a jittery connection.', 'A room only lives while someone is in it: keep anything that spans sessions in server code (env.store) or saves.', 'Register GCP.test.onTwoPlayers so verification proves two browsers end up in the same world.', 'The game must still boot and call GCP.ready() alone in a room.'],
      guide: 'multiplayer',
    },
    {
      id: 'smoothing', name: 'Network smoothing', category: 'multiplayer', status: 'available',
      what: 'A playback buffer for one remote stream that turns network jitter into smooth movement.',
      how_it_works: 'push each sample with its send time (room messages carry it as meta.at); value() or sample() every frame plays back slightly behind the newest sample with an adaptive delay, extrapolates briefly when a message is late, and never goes backwards.',
      use_for: ['Remote player positions', 'Host snapshots on guests'],
      sdk: ['GCP.smooth({ delay, minDelay, maxDelay, extrapolate })', 'buffer.push(value, sentAt)', 'buffer.value()', 'buffer.sample()', 'buffer.clear()', 'buffer.age', 'buffer.last'],
      mcp_tools: [],
      limits: { blended: 'numbers, and number fields of objects and arrays one level deep' },
      guidelines: ['One buffer per remote stream (per player, or one for host snapshots).'],
      guide: 'multiplayer',
    },
    {
      id: 'server_code', name: 'Game server code', category: 'runtime', status: on(s.allow_server_code),
      what: 'Optional server/index.js in the bundle, run inside the game\'s own Cloudflare Worker for requests under /api/.',
      how_it_works: 'At deploy the platform uploads the server/ modules into the game\'s Worker; the Worker never serves them as files (any path under server/ answers 404, in preview and live). GCP.server(path, init) calls it with the player\'s play token attached; the module gets env.GAME, env.player (verified, or null) and env.store, which reads and writes shared data and any player\'s save for this game through the platform. It runs on the standard Workers runtime (fetch, Web Crypto, streams). It has no access to the platform\'s own data or secrets, and no bindings of its own (no KV, D1, Durable Objects, cron or AI).',
      use_for: ['Validating scores and runs before they count', 'Daily challenges and seeds', 'State that spans sessions: persistent worlds, turn-based games played over days', 'Anything players must not be able to tamper with'],
      sdk: ['GCP.server(path, init)'],
      mcp_tools: ['upload_files', 'deploy_preview', 'game_data'],
      limits: { allowed_on_this_platform: s.allow_server_code, entry: 'server/index.js with export default { fetch(request, env, ctx) }', imports: 'other files under server/ by relative path', store: '256 KB per value' },
      guidelines: ['Most games need none; use it when something must be decided where players cannot tamper with it.', 'Files under server/ are never served to players (the game Worker answers 404 for them); everything else in the bundle is public. Keep secrets out of client files.', 'There is no secrets store: a key written into server/ is readable by you through MCP and by the platform\'s automated checks, so use only keys you could rotate, and rotate them if a project is shared.', 'Keep each request short; check env.player before trusting a caller.'],
      guide: 'saves',
    },
    {
      id: 'display', name: 'Display, fullscreen and devices', category: 'runtime', status: 'available',
      what: 'Fullscreen from inside the play frame (also on iPhone), orientation lock, touch detection and the platform\'s exit button on phones.',
      how_it_works: 'The game page frames the game and tells the SDK how it is shown; the <html> element carries gcp-fullscreen and gcp-touch classes. On phones and tablets Play enters fullscreen at once, inside the safe area, locked to the declared orientation where the browser allows it.',
      use_for: ['On-screen touch controls when display.touch is true', 'Landscape- or portrait-only games', 'A fullscreen button'],
      sdk: ['GCP.fullscreen(on)', 'GCP.display', 'GCP.onDisplay(fn)', 'GCP.setDisplay({ orientation, exitButton })'],
      mcp_tools: ['compatibility'],
      limits: { allowed_in_frame: 'fullscreen, gamepad, pointer lock, audio after a gesture', not_allowed: 'camera, microphone, geolocation' },
      guidelines: ['Call GCP.fullscreen() from a tap or key press.', 'Declare orientation with the compatibility tool so phones are handled before launch.'],
      guide: 'contract',
    },
    {
      id: 'compatibility', name: 'Compatibility requirements', category: 'quality', status: 'available',
      what: 'Each version carries what it needs from the player\'s browser: graphics API, GPU, features, input, devices, orientation, memory, minimum browsers and known issues.',
      how_it_works: 'Declared in gcp.json "requirements" (the compatibility tool writes it) and merged with what the platform detects in the code at deploy. The store page lists them and checks the player\'s own browser before launch.',
      use_for: ['Warning players before a game that cannot run on their device', 'Marking a game mobile-ready'],
      sdk: [], mcp_tools: ['compatibility', 'list_versions'],
      limits: { known_issues: 12, notes: '300 characters' },
      guidelines: ['Declare the weakest graphics API the game still runs with.', 'compatibility {action: "check"} first; it suggests a block from the code.'],
      guide: 'contract',
    },
    {
      id: 'verification', name: 'Verification and test hooks', category: 'quality', status: 'automatic',
      what: 'Every preview is opened in a real browser (Cloudflare Browser Rendering) and must boot, keep rendering, show a picture, survive keyboard, mouse and touch, load every file and throw no uncaught errors. Only a verified version can be published.',
      how_it_works: 'deploy_preview runs static checks (syntax, imports, missing files, web-only content), deploys, then the browser check. A game can register a play-through that plays its own rules to the end, and a two-player check that the verifier runs in two pages sharing one room. The report and a screenshot are stored with the version. WebGPU-only games are verified by a short clean play of the preview by their creator.',
      use_for: ['Proof that the game is playable before it goes live', 'Automated end-to-end tests of your own rules'],
      sdk: ['GCP.test.onAutostart(fn)', 'GCP.test.onStart(fn)', 'GCP.test.onPlaythrough(fn)', 'GCP.test.onTwoPlayers(fn)', 'GCP.test.twoPlayers', 'GCP.test.autostart', 'GCP.test.seed', 'GCP.test.param(name)'],
      mcp_tools: ['deploy_preview', 'list_versions'],
      limits: { ready_timeout_seconds: s.verify_ready_timeout_s, min_frames: s.verify_min_frames, observe_seconds: s.verify_observe_s, playthrough_seconds: Math.min(45, Math.max(3, s.verify_playthrough_s)), playthrough_steps: 60, human_preview_seconds: s.verify_human_min_seconds },
      guidelines: ['deploy_preview {dry_run: true} runs only the static checks.', 'The verification browser has no GPU: keep the first scene light or adapt quality.', 'Register onPlaythrough; without it the report says only start-up, rendering and input were checked.'],
      guide: 'versions',
    },
    {
      id: 'publish_checks', name: 'Publish checks (originality, content, web only)', category: 'quality', status: 'automatic',
      what: 'Before a verified version can go live it is compared with other creators\' live games, checked for harmful content and abusive code, and confirmed to be a web game.',
      how_it_works: 'Code fingerprints that survive renaming, identical files and a screenshot hash catch copies (platform templates, kits and common libraries are ignored). Workers AI decision models review only borderline cases under a daily cap. Native programs, installers, app-store links and redirects to other sites are refused.',
      use_for: ['Knowing why publish refused a version (the report names the check and the fix)'],
      sdk: [], mcp_tools: ['deploy_preview', 'list_versions', 'publish'],
      limits: {},
      guidelines: ['Starting from platform templates or kits is fine.', 'Game violence and horror are fine; sexual content, hate, scams, phishing, miners and password forms are not.', 'Multiplayer must go through GCP.room: a background worker talking to an outside server is treated as a miner.'],
      guide: 'versions',
    },
    {
      id: 'marketplace', name: 'Marketplace listing, ratings and reviews', category: 'business', status: 'available',
      what: 'Each live game has a store page with title, tagline, description, tags, controls, cover, standardized metadata (genre, languages, players and modes, content and age rating, session length, progress, accessibility, compatibility), ratings and reviews.',
      how_it_works: `update_project sets the listing; game_metadata detects, suggests and declares the standardized metadata (genre on the project, the rest in gcp.json, frozen with each version), and publish is refused until the required fields are on record. Players rate and review from the game page${s.review_requires_play ? ' after a counted play' : ''}; a play counts after ${s.play_min_seconds} seconds of active play.`,
      use_for: ['Discoverability by tag and category', 'Telling players how to play'],
      sdk: [], mcp_tools: ['update_project', 'game_metadata', 'list_projects', 'get_stats'],
      limits: { cover: 'png, jpg or webp, under 2 MB', counted_play_seconds: s.play_min_seconds },
      guidelines: ['Fill controls with the actual keys and touch gestures.', 'Set a cover from a real in-game picture.', 'Run game_metadata before the first publish; it lists what is missing.'],
      guide: 'metadata',
    },
    {
      id: 'payments', name: 'Paid games, free trials and payouts', category: 'business', status: on(s.paid_games_enabled),
      what: 'A creator can sell a game for a one-time price, offer a timed free trial, and withdraw earnings. Payments and payouts run on Stripe.',
      how_it_works: `Players buy on the game page with Stripe Checkout; the platform keeps ${s.platform_fee_percent}% and credits the rest to the creator after ${s.earnings_hold_days} days. A free trial is kept per account on the server by wall-clock time; when it ends the SDK pauses the game, shows a buy prompt, and saves, leaderboards and rooms answer 402. Withdrawals go to a bank through Stripe Connect once the balance reaches ${usd(s.withdraw_min_cents)}. Publishing needs a one-time creator license${s.creator_fee_required ? ` (${usd(s.creator_fee_cents)})` : ' (not required on this platform)'}.`,
      use_for: ['Premium games', 'Demo-then-buy with trial_minutes'],
      sdk: [], mcp_tools: ['update_project', 'get_stats', 'get_started'],
      limits: { price_range: `${usd(s.game_price_min_cents)} to ${usd(s.game_price_max_cents)}`, platform_cut_percent: s.platform_fee_percent, free_trials: s.trials_enabled ? `up to ${s.trial_max_minutes} minutes` : 'disabled', earnings_hold_days: s.earnings_hold_days, withdraw_minimum: usd(s.withdraw_min_cents) },
      guidelines: ['The game itself never takes payments: no in-game purchases, and no links to outside stores.', 'A paid game\'s code does not need to check ownership; the platform only opens it for owners and trial players.', 'Ask the user before setting or changing a price.'],
      guide: null,
    },
    {
      id: 'analytics', name: 'Analytics and runtime errors', category: 'insight', status: 'automatic',
      what: 'Players online now, room occupancy, sessions, unique, new and returning players, play time, session lengths, devices, browsers, versions, trials, sales, ratings and the errors real players hit.',
      how_it_works: 'Computed from the SDK\'s heartbeats, room presence and the errors players\' browsers report. Only real players of the live game count in the history; the creator\'s own plays and the verifier do not.',
      use_for: ['Finding where players drop off', 'Catching errors that only happen on some devices', 'Checking a release'],
      sdk: [], mcp_tools: ['get_stats', 'game_data'],
      limits: { window_days: '1 to 90', online_window_seconds: 60 },
      guidelines: ['There are no custom analytics events; use player stats (aggregated by game_data summary) to count what matters.', 'Read runtime_errors after every publish.'],
      guide: null,
    },
    {
      id: 'open_implementations', name: 'Open implementations', category: 'insight', status: 'available',
      what: 'Cards that tell agents how other creators\' live games were built, when those creators opted in. Never code.',
      how_it_works: 'find_implementations searches shared games by kind, engine or technique and shows the common patterns; get_implementation returns one card (engine, rendering, input, audio, assets, platform services, loop, structure, play-through, summary).',
      use_for: ['Learning how games of a kind are built here before starting one'],
      sdk: [], mcp_tools: ['find_implementations', 'get_implementation', 'update_project', 'publish'],
      limits: {},
      guidelines: ['Ask the user before sharing their game\'s card (update_project {open_implementation: true}).'],
      guide: null,
    },
    {
      id: 'agent_access', name: 'Agent access (MCP and OAuth)', category: 'agent access', status: 'available',
      what: 'This MCP server: tools, guides as resources and a publish prompt, for any MCP client.',
      how_it_works: `Streamable HTTP at ${origin}/mcp, stateless. Sign-in is OAuth 2.1 with PKCE and dynamic client registration; no API keys exist. Agents that cannot open a browser use device sign-in (${origin}/oauth/device, the user approves at ${origin}/device). Access tokens last ${Math.round(s.oauth_access_ttl_s / 60)} minutes and are refreshed with the refresh token; the grant lasts ${Math.round(s.oauth_grant_ttl_s / 86400)} days or until the user revokes it in the console.`,
      use_for: ['Building, publishing and running games from any agent'],
      sdk: [], mcp_tools: ['get_started', 'platform_services'],
      http: [`${origin}/mcp`, `${origin}/oauth/device`, `${origin}/oauth/token`, `${origin}/.well-known/oauth-authorization-server`, `${origin}/guides/<guide>.md`],
      limits: { access_token_minutes: Math.round(s.oauth_access_ttl_s / 60), grant_days: Math.round(s.oauth_grant_ttl_s / 86400) },
      guidelines: ['On 401, refresh the token instead of signing in again.', 'On workers.dev, send a descriptive User-Agent header.'],
      guide: 'versions',
    },
  ];
}

/** What the platform does not provide, and what to do instead. */
export const NOT_PROVIDED: Missing[] = [
  { need: 'AI models for games (text, images, speech)', status: 'not provided', instead: 'The platform uses Workers AI only for its own checks. Generate assets while building, or call an outside API from server code (files under server/ are never served to players; never put a key in client files).' },
  { need: 'In-game purchases, currencies sold for money, subscriptions', status: 'not provided', instead: 'Sell the whole game (update_project price_cents) or offer a free trial. In-game currencies earned by play can live in saves or player stats.' },
  { need: 'Checking from game code whether the player bought the game', status: 'not provided', instead: 'Not needed: the platform only opens a paid game for owners and players with trial time left, and pauses it when a trial ends.' },
  { need: 'Achievements and badges', status: 'not provided', instead: 'Track milestones with GCP.playerStats (players see them on the game page) and show them in the game.' },
  { need: 'Friends, chat, invites, player profiles', status: 'not provided', instead: 'Share a room code (GCP.room(code)) and relay chat over room.send. Moderate any text players type.' },
  { need: 'Matchmaking and a list of open rooms', status: 'not provided', instead: 'Use fixed or player-shared room codes; for a lobby list, have players join a "lobby" room and advertise their own codes there.' },
  { need: 'Server-authoritative simulation inside rooms', status: 'not provided', instead: 'The host player is the authority; rooms relay and keep one snapshot. Validate results that matter in server code.' },
  { need: 'Persistent rooms and worlds while nobody is connected', status: 'not provided', instead: 'Store the world in server code with env.store (or the host saves it) and load it when the room opens again.' },
  { need: 'Secrets, environment variables or extra bindings (KV, D1, R2, cron) for server code', status: 'not provided', instead: 'Use env.store for data. A key can be written into server/ (never served to players), but there is no secrets store or rotation: prefer keys you can revoke.' },
  { need: 'Asset hosting beyond the game\'s storage (a CDN or bucket for large downloads)', status: 'not provided', instead: 'Generate content from code, or load it at run time from a host the developer controls (any HTTPS host with CORS). game_storage {project} explains both and asks for more storage when a game truly needs it.' },
  { need: 'Custom analytics events', status: 'not provided', instead: 'Count what matters with player stats; game_data summary aggregates them across players.' },
  { need: 'Uploads from players (screenshots, levels, avatars)', status: 'not provided', instead: 'Keep small player-made content as JSON in saves (256 KB per key) or, through server code, in shared data.' },
  { need: 'Push notifications and email to players', status: 'not provided', instead: 'None; use shared data for in-game announcements.' },
  { need: 'Camera, microphone and geolocation', status: 'not provided', instead: 'Blocked in the play frame. Design for keyboard, mouse, touch and gamepad.' },
  { need: 'Native, mobile, console or desktop builds and app-store links', status: 'not provided', instead: 'Web games only; engines with a web export are welcome.' },
];

export const DISCOVERY = [
  'platform_services: this catalog, with this platform\'s live limits. Pass service for one entry.',
  'get_started: rules, workflow, account status and a short services overview. get_started {topic} returns a guide: "services" is the long form of this catalog.',
  'MCP resources: gcp://services (this catalog as JSON) and gcp://guides/<topic> (each guide as Markdown).',
  'The same guides on the web: /guides/<file>.md, and the Docs page at /docs#services.',
];
