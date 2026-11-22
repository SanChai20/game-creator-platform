// Push notifications for the web app (cookie sign-in): the platform's public key, turning them on and off for this
// browser, which kinds to get, and a test. src/push.ts sends them; web/src/pwa.ts and web/public/sw.js are the browser.
import { Hono } from 'hono';
import { AppError, bad, type Env, type User } from '../env';
import { rateLimit, requireUser, sessionToken } from '../auth';
import { sha256 } from '../util';
import { PUSH_KINDS, readSubscription } from '../push-core';
import { dropSubscription, pushOff, saveSubscription, sendTest, setPushOff, subscribed, vapidKeys } from '../push';

type App = { Bindings: Env; Variables: { user: User | null; origin: string } };
export const push = new Hono<App>();
const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, any>>().catch(() => ({}))) as Record<string, any>;

push.get('/key', async (c) => c.json({ key: (await vapidKeys(c.env)).publicKey }));

// This browser's state: whether its subscription is on record for the account, and the kinds switched off.
push.post('/state', async (c) => {
  const u = requireUser(c), b = await body(c);
  return c.json({ subscribed: typeof b.endpoint === 'string' && await subscribed(c.env, u.id, b.endpoint), off: await pushOff(c.env, u.id), kinds: PUSH_KINDS });
});

push.post('/subscribe', async (c) => {
  const u = requireUser(c), b = await body(c), sub = readSubscription(b.subscription);
  if (!sub) throw bad('That is not a push subscription from a supported browser.');
  await rateLimit(c.env, 'push-sub:' + u.id, 30, 3600);
  const tok = sessionToken(c.req.raw);
  if (!tok) throw new AppError(401, 'Sign in first.', 'unauthenticated');
  await saveSubscription(c.env, u.id, await sha256(tok), sub, String(b.lang || 'en'), c.req.header('user-agent') || null);
  return c.json({ ok: true });
});

push.post('/unsubscribe', async (c) => {
  const u = requireUser(c), b = await body(c);
  if (typeof b.endpoint === 'string') await dropSubscription(c.env, u.id, b.endpoint);
  return c.json({ ok: true });
});

push.put('/prefs', async (c) => {
  const u = requireUser(c), b = await body(c);
  if (!Array.isArray(b.off)) throw bad('off: the kinds to switch off, as a list.');
  await setPushOff(c.env, u.id, b.off.map(String));
  return c.json({ off: await pushOff(c.env, u.id) });
});

push.post('/test', async (c) => {
  const u = requireUser(c), b = await body(c);
  await rateLimit(c.env, 'push-test:' + u.id, 5, 600);
  if (typeof b.endpoint !== 'string') throw bad('endpoint: this browser\'s subscription.');
  return c.json({ sent: await sendTest(c.env, u.id, b.endpoint) });
});
