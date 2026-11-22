// The bot contract, as the checks see it. Test bots (src/bots.ts) do by themselves everything that is the same in every
// online game: a session, the matchmaker, rooms, invites, the connection and its network. What needs the game's own rules
// (saying hello in a room, marking ready, picking, every move in a match) only the game can say, in server/bot.js
// (src/runtime/bot-runner.js has the hooks). This reads a build and says which hooks the game needs and which it has, so
// the preview and publish checks can ask the agent for the missing ones, and the Test players panel can explain them.

const ROOM_RE = /\bGCP\s*(?:\?\.|\.)\s*room\s*\(/;
const INVITE_RE = /\bfriends\s*(?:\?\.|\.)\s*(?:open|invite)\s*\(/;
const hookRe = (name) => new RegExp(`(?:^|[\\s,{])(?:async\\s+)?${name}\\s*(?:\\([^)]*\\)\\s*\\{|:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>))`, 'm');

/**
 * texts: Map or object of path -> source for the build's text files; paths: every path in the build.
 * Returns { online, match, room, invites, file, hooks: { think, actions, room, invite } }.
 */
export function botContract(texts, paths) {
  const get = (p) => (texts instanceof Map ? texts.get(p) : texts[p]);
  const list = [...paths];
  const client = list.filter((p) => !/^(server)\//.test(p) && /\.(m?js|html)$/.test(p));
  const match = list.includes('server/match.js');
  let room = false, invites = false;
  for (const p of client) { const s = get(p) || ''; if (!room && ROOM_RE.test(s)) room = true; if (!invites && INVITE_RE.test(s)) invites = true; if (room && invites) break; }
  const file = list.includes('server/bot.js');
  const src = file ? String(get('server/bot.js') || '') : '';
  // the hooks named in the default export, as shorthand or by reference: export default { thinkMs: 80, think, room: onRoom }
  const exported = new Set();
  const def = src.match(/export\s+default\s*\{([^{}]*)\}/);
  if (def) for (const part of def[1].split(',')) { const m = part.trim().match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$.]*\s*)?$/); if (m) exported.add(m[1]); }
  const has = (name) => !!file && (hookRe(name).test(src) || exported.has(name));
  const hooks = { think: has('think'), actions: has('actions'), room: has('room'), invite: has('invite') };
  return { online: match || room, match, room, invites, file, hooks };
}

/** What a build is missing for its test bots, as check warnings ({ file, message, hint }). */
export function botIssues(b) {
  if (!b || !b.online) return [];
  const out = [], hint = 'get_started {topic: "bots"} has the contract and an example. The platform connects, matchmakes, accepts invites and simulates the network; server/bot.js does what needs your game\'s rules.';
  const what = [b.match && 'server-run matches (server/match.js)', b.room && 'rooms (GCP.room)'].filter(Boolean).join(' and ');
  if (!b.file) {
    out.push({ file: 'server/bot.js', message: `This online game (${what}) has no server/bot.js, so the platform's test bots can join it but never play: they cannot say hello, mark themselves ready, pick or move, and a lobby that waits for them waits forever.`, hint: `Add server/bot.js: ${b.match ? 'think(view, me, ctx) for the match' : ''}${b.match && b.room ? ', ' : ''}${b.room ? 'room(ctx) for what a player sends in your rooms (hello, ready, moves)' : ''}${b.room && b.invites ? ', and invite(join) if your game turns an invite into a room code of its own' : ''}. ${hint}` });
    return out;
  }
  if (b.match && !b.hooks.think && !b.hooks.actions) out.push({ file: 'server/bot.js', message: 'The game runs matches (server/match.js) but server/bot.js has no think() or actions(), so test bots in a match never move.', hint: `Add think(view, me, ctx) returning one input, as the page passes to match.input(). ${hint}` });
  if (b.room && !b.hooks.room) out.push({ file: 'server/bot.js', message: 'The game uses rooms (GCP.room) but server/bot.js has no room(), so test bots in a room never send anything: no hello, no ready, no moves.', hint: `Add room(ctx) returning the messages a player's page would send now ([{ d }] to everyone, { d, to } to one), from ctx.state, ctx.messages and ctx.joined. ${hint}` });
  if (b.room && b.invites && !b.hooks.invite) out.push({ file: 'server/bot.js', message: 'The game invites friends into rooms, but server/bot.js has no invite(join): an invited test bot takes the invite\'s data.room as the room code exactly. If your game builds the code from it (a prefix, say), the bot ends up in the wrong room.', hint: `Add invite(join, ctx) returning { room: <the code your game passes to GCP.room> }. ${hint}` });
  return out;
}
