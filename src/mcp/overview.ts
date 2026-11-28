// What an agent is told the moment it connects: what the platform covers, what it leaves to the agent and the creator,
// and every tool with what it is for. The server instructions (initialize), get_started and the "testing" guide all
// read it from here, so the introduction never drifts from TOOLS (tests/mcp-overview.mjs holds every tool to one group).

/** The platform's scope in one breath: what it does, and what it never decides. */
export const SCOPE = {
  covers: 'Hosting (projects, uploads, numbered versions on a private preview, downloading, checking out and comparing versions from any machine, publishing, rollback, storage), the SDK (window.GCP, injected into every game page: start-up, saves, stats, leaderboards, shared data, rooms, server-run matches, friends, display, touch controls, interface scale, test hooks) and testing and feedback (static checks, a real-browser verification of every version on a computer, an emulated iPhone and iPad, a browser you drive on the preview, the creator\'s annotated screenshots, bot players for online games, standards checks, a publish dry run, live analytics and runtime errors).',
  yours: 'The game\'s design is yours and the creator\'s: genre, rules, mechanics, art, engine (or none), renderer, interface, sound, length and scope. The platform neither prescribes nor scores any of it. Its checks judge only the player\'s experience: the game starts, keeps running, answers input on computers, tablets and phones, throws no errors and stays on the page; and around that, honest content descriptors, originality and the store metadata. game_standards describes the platform\'s own surfaces (cover crops, menu button, safe areas) as recommendations that never block a version.',
  self_contained: 'Everything needed is on this server: the tool descriptions and answers, get_started (rules, workflow, account, a guide per topic), platform_services (every service with its live limits), and the same guides and catalog as MCP resources (gcp://guides/<topic>, gcp://services, gcp://templates/<name>). No outside documentation is needed; every answer says what to call next.',
};

export interface ToolGroup { id: string; title: string; tools: [name: string, what: string][] }

/** Every tool once, grouped by what it is for. */
export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'start', title: 'Start and reference', tools: [
    ['get_started', 'call first: rules, workflow, account and license, limits, the SDK overview; topic returns one guide in full'],
    ['platform_services', 'every hosted service (saves, leaderboards, rooms, matches, server code, friends, display…) with SDK calls, tools, live limits, and what is not provided'],
    ['game_standards', 'how the platform\'s own surfaces behave (cover crops, listing text, menu button, safe areas, loading hand-off) and a check of a game against them; advice only'],
    ['find_implementations', 'search how other creators\' live games were built, when they chose to share it (never code)'],
    ['get_implementation', 'one shared game\'s build card, and its build skill when free'],
  ] },
  { id: 'hosting', title: 'Hosting and release', tools: [
    ['create_project', 'one project per game; returns the id every other tool takes'],
    ['upload_files', 'write, edit (exact text replace) or delete workspace files, up to 40 in one call'],
    ['create_upload_url', 'a curl URL for big or binary files, or a whole folder as a zip'],
    ['list_files', 'the workspace with sizes and hashes'],
    ['game_storage', 'how much storage the game uses and has, how to stay inside it, asking for more'],
    ['deploy_preview', 'static checks, then a new numbered version on the private preview, verified in a real browser (dry_run: static checks only)'],
    ['list_versions', 'every version with its status, who deployed it and what it was built on, or one version\'s full verification report (waits for a running check)'],
    ['pull_version', 'download any version\'s complete files (or the workspace) as a zip or file by file, to carry on from another machine or agent'],
    ['checkout_version', 'make the workspace exactly one version\'s files; refuses to discard changes that are in no version unless forced'],
    ['diff_versions', 'files added, removed and changed between two versions or a version and the workspace, with line diffs'],
    ['publish', 'make a verified version live; dry_run: true lists every release requirement with its fix'],
    ['rollback', 'make an earlier live version live again'],
    ['unpublish', 'take the game offline (versions stay)'],
    ['list_projects', 'this account\'s games and the ones shared with it (with your role), or one in detail with links and the newest report'],
    ['delete_project', 'remove a project that is not live and nobody bought (two calls, confirm)'],
  ] },
  { id: 'team', title: 'Working together (people and agents)', tools: [
    ['collaborators', 'who works on the game and with which role (read, write, maintain, admin); invite, change roles, answer invitations sent to you'],
    ['branches', 'a working copy per developer or agent, forked from main; bring main in (conflicts marked), resolve, delete; main\'s protection'],
    ['change_requests', 'propose a branch for main, review it (approve, request changes, comment), merge it (three-way merge, verified as a new main version)'],
  ] },
  { id: 'store', title: 'Store page and listing', tools: [
    ['game_metadata', 'the store-page checklist: genre, tags, requirements, languages, players, content (age rating), listing and translations; check, then declare'],
    ['compatibility', 'what the game needs from the browser and device, detected from the code and declared'],
    ['update_project', 'title, tagline, description, cover (and one per language), price, trial, sale, sharing'],
    ['build_skill', 'the game\'s build skill, written before each release while sharing is on'],
    ['jam', 'game jams and festivals: list them, see the entries and results, enter or withdraw a game'],
    ['devlog', 'news posts on the game page, announced to the game\'s players; patch notes go with publish {patch_notes}'],
  ] },
  { id: 'testing', title: 'Testing and feedback', tools: [
    ['debug_preview', 'drive the preview in a real browser: screenshots (PNG, zoom), clicks, taps, keys, typing, waits, eval; returns the game\'s state and errors; desktop, phone, tablet, iPhone and iPad viewports'],
    ['creator_feedback', 'the creator\'s annotated screenshots and notes from playing the preview; read every session'],
    ['bundles', 'group your paid games so owning one lowers the price of the rest'],
    ['coupons', 'discount codes and single-use free keys for a paid game, for streamers, press and giveaways'],
    ['playtest', 'invite real players to the preview by link, ask them questions, read how each played and what they said'],
    ['preview_bots', 'bot players in the preview for online games: real matchmaker and rooms, regions, bad networks, drops, invites, with the game\'s server/bot.js'],
    ['get_stats', 'players online, sessions and play time, devices, ratings, reviews, sales, and the errors players\' browsers reported'],
  ] },
  { id: 'services', title: 'Running services', tools: [
    ['game_data', 'the game\'s database per environment: seed shared data, aggregate saves and stats, read or clear leaderboards'],
    ['game_room', 'look inside or reset a realtime multiplayer room'],
  ] },
];

/** Where each testing and feedback capability lives, for get_started and the server instructions. */
export const TESTING = [
  'deploy_preview {dry_run: true}: static checks only (syntax with the line, imports, missing files, the GCP.ready() contract, web-only content, storage).',
  'deploy_preview: every version is opened in a real browser and verified: it boots (GCP.ready()), keeps answering, draws a picture, reacts to input, survives random bot play, loads every file, throws no uncaught errors; then it is played on an emulated iPhone and iPad. Your own GCP.test.onPlaythrough script runs and is reported step by step. list_versions {project, version} reads any report.',
  'debug_preview: see and play the preview yourself, on any viewport, with exact screenshots and the game\'s state.',
  'creator_feedback: what the creator marked up while playing the preview.',
  'preview_bots: online games played by bots over the real network path.',
  'game_standards {project, action: "check"} and publish {dry_run: true}: advice on the platform\'s surfaces, and every release requirement with its fix.',
  'get_stats: after release, how players play and the errors their browsers hit.',
];

/** The tool map as plain lines, for the server instructions. */
export const toolLines = () => TOOL_GROUPS.map((g) => `${g.title}:\n${g.tools.map(([n, w]) => `- ${n}: ${w}`).join('\n')}`).join('\n');
/** The tool map as an object, for get_started. */
export const toolMap = () => Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, { title: g.title, tools: Object.fromEntries(g.tools) }]));
