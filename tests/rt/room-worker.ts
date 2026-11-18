// A minimal Worker around the platform's GameRoom Durable Object, for tests/room-live.mjs (run under wrangler dev).
// It skips play tokens: the query string carries what the platform's /api/rt/room route would put there.
export { GameRoom } from '../../src/room';
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const u = new URL(request.url);
    const id = env.ROOMS.idFromName(u.searchParams.get('r') || 'test');
    return env.ROOMS.get(id).fetch(request);
  },
};
