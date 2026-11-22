// A platform for tests/bots-live.mjs: the real runtime routes (/api/rt/*, src/routes/rt.ts), the real Matchmaker and the
// real BotFleet Durable Objects, a local D1 with the platform's migrations, a local R2 for the game's files and the
// Worker Loader for server/bot.js. The game's own Worker runs in a second wrangler dev (the test builds it). /seed
// creates the game, its preview version and the creator; /start launches a fleet like startBots does once its checks pass.
import { Hono } from 'hono';
import { rt } from '../../src/routes/rt';
import { launchFleet, followCreator } from '../../src/bots';
// @ts-ignore plain JS module
import { fleetRequest } from '../../src/bots-core.js';
export { Matchmaker } from '../../src/matchmaker';
export { BotFleet } from '../../src/bots';
export { GameRoom } from '../../src/room';

const app = new Hono<{ Bindings: any }>();
// as the platform answers (src/index.ts): an AppError is its status and { error, code }
app.onError((e: any, c) => (e && e.status && e.code ? c.json({ error: e.message, code: e.code }, e.status) : c.json({ error: String(e?.message || e) }, 500)));
app.route('/api/rt', rt);
app.post('/seed', async (c) => {
  const b = await c.req.json<{ files: Record<string, string>; manifest: unknown; version?: number }>(), db = c.env.DB, t = Date.now(), n = b.version || 1;
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO users (id, email, name, pw_hash, created_at) VALUES ('owner1', 'o@x.test', 'Creator', 'x', ?)").bind(t),
    db.prepare("INSERT OR REPLACE INTO projects (id, owner_id, slug, title, created_at, updated_at, preview_version) VALUES ('gtest1', 'owner1', 'noctelle-test', 'Noctelle', ?, ?, ?)").bind(t, t, n),
    db.prepare("INSERT OR REPLACE INTO versions (project_id, n, created_at, manifest, files) VALUES ('gtest1', ?, ?, ?, ?)").bind(n, t, JSON.stringify(b.manifest), JSON.stringify(Object.keys(b.files).map((path) => ({ path, size: b.files[path].length })))),
    db.prepare("INSERT OR REPLACE INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES ('ps_owner', 'gtest1', 1, 'preview', 'owner1', 'owner', ?, ?)").bind(t, t),
  ]);
  for (const [path, text] of Object.entries(b.files)) await c.env.FILES.put(`v/gtest1/${n}/${path}`, text);
  return c.json({ ok: true });
});
app.post('/start', async (c) => {
  const b = await c.req.json<any>();
  const r = fleetRequest(b.request, { maxBots: 15, maxMinutes: 30 });
  if (!r.ok) return c.json(r, 400);
  const fleet = await launchFleet(c.env, { project: 'gtest1', version: b.version || 1, owner: 'owner1', cfg: r.cfg, platform: b.platform, game: b.game });
  return c.json({ fleet });
});
const stub = async (c: any) => {
  const f = await c.env.DB.prepare("SELECT do_name FROM bot_fleets WHERE project_id = 'gtest1' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").first();
  return f ? c.env.BOTS.get(c.env.BOTS.idFromName(f.do_name)) : null;
};
app.get('/status', async (c) => { const s = await stub(c); return c.json(s ? await s.status() : { running: false }); });
app.post('/act', async (c) => { const s = await stub(c); return c.json(await s.act(await c.req.json())); });
app.post('/stop', async (c) => { const s = await stub(c); return c.json(s ? await s.stop('test over') : { stopped: false }); });
app.get('/db', async (c) => c.json((await c.env.DB.prepare(c.req.query('q')!).all()).results));
app.get('/health', (c) => c.text('ok'));
export default app;
