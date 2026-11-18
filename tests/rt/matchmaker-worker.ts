// A minimal Worker around the platform's Matchmaker Durable Object, for tests/matchmaker-live.mjs (run under wrangler
// dev with a local D1 that has the platform's migrations). /seat forwards a seat the way the /api/rt/match route builds
// it (the route itself needs a signed-in play token); /seed adds play sessions; /match reads a recorded match.
export { Matchmaker } from '../../src/matchmaker';
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const u = new URL(request.url);
    if (u.pathname === '/seed') {
      const ids = (u.searchParams.get('plays') || '').split(',').filter(Boolean);
      for (const id of ids) {
        const [play, user] = id.split(':');
        await env.DB.prepare("INSERT OR REPLACE INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, 'g1', 1, 'live', ?, 'player', 0, 0)").bind(play, user).run();
      }
      return Response.json({ ok: true });
    }
    if (u.pathname === '/match') return Response.json(await env.DB.prepare('SELECT * FROM matches WHERE id = ?').bind(u.searchParams.get('id')).first());
    const seat = JSON.parse(u.searchParams.get('seat') || 'null');
    const name = seat?.code ? `g1:live:code:${seat.code}` : `g1:live:q:${seat?.q}:${seat?.size}:${seat?.min}:${seat?.teams}:${seat?.mode}`;
    return env.MATCHMAKER.get(env.MATCHMAKER.idFromName(name)).fetch(request);
  },
};
