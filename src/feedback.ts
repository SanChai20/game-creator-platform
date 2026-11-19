// The creator feedback queue: annotated screenshots of a game's preview, taken by its creator in the console, waiting for
// their agent. The console adds and removes items; the agent reads them with creator_feedback, which takes each item off
// the queue as it returns it, so nothing is read twice. Only the game's owner reaches its queue (not admins, not other
// accounts), and the queue is small and short-lived: a few dozen items per game, kept a month at most. The rules for
// what an item holds are in feedback-rules.js (tests/feedback.mjs).
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from './env';
import { rateLimit } from './auth';
import { logEvent, ownedProject } from './projects';
import { getSettings } from './settings';
import { now, parseJson, rid } from './util';
// @ts-ignore plain JS module shared with the tests
import { FEEDBACK_LIMITS, FeedbackError, cleanContext, cleanMarks, cleanNote, describeMarks, parseImage } from './feedback-rules.js';

const ADDS_PER_HOUR = 60;   // per account, across games

export interface FeedbackRow {
  id: string; project_id: string; owner_id: string; version: number | null; note: string; marks: string; context: string;
  image_key: string | null; bytes: number; width: number; height: number; created_at: number;
}

/** The project, only for its owner: the feedback queue is the creator's conversation with their own agent. */
export async function feedbackProject(env: Env, user: User, idOrSlug: string): Promise<Project> {
  const p = await ownedProject(env, user, idOrSlug);
  if (p.owner_id !== user.id) throw forbidden('Only the game\'s creator can see its feedback queue.');
  return p;
}

const keyOf = (pid: string, id: string, type: string) => `feedback/${pid}/${id}.${type === 'image/png' ? 'png' : 'jpg'}`;
const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof FeedbackError) throw bad(e.message); throw e; } };

export async function pendingFeedback(env: Env, pid: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE project_id = ?').bind(pid).first<{ n: number }>().catch(() => null);
  return r?.n || 0;
}

/** Adds one item from the console. body: { image (data URL), note, marks, context, version }. */
export async function addFeedback(env: Env, user: User, p: Project, body: Record<string, unknown>) {
  const s = await getSettings(env);
  if (!s.feedback_enabled) throw new AppError(403, 'Creator feedback is switched off on this platform.', 'disabled');
  if (p.owner_id !== user.id) throw forbidden('Only the game\'s creator can add feedback.');
  const note = cleanNote(body.note), marks = wrap(() => cleanMarks(body.marks)), context = cleanContext(body.context);
  if (!note && !marks.length) throw bad('Write a note or mark something on the screenshot first.');
  const img = wrap(() => parseImage(body.image)) as { bytes: Uint8Array; type: string; width: number; height: number };
  await rateLimit(env, 'feedback:' + user.id, ADDS_PER_HOUR, 3600);
  const max = Math.max(1, s.feedback_max_pending);
  if ((await pendingFeedback(env, p.id)) >= max) throw new AppError(409, `${max} items are already waiting for your agent. Remove some, or ask your agent to read them (creator_feedback).`, 'queue_full');
  const version = Number.isInteger(body.version) && (body.version as number) > 0 ? body.version as number : p.preview_version;
  const id = 'fb_' + rid(14), key = keyOf(p.id, id, img.type), t = now();
  await env.FILES.put(key, img.bytes, { httpMetadata: { contentType: img.type } });
  try {
    await env.DB.prepare('INSERT INTO feedback (id, project_id, owner_id, version, note, marks, context, image_key, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, p.id, p.owner_id, version ?? null, note, JSON.stringify(marks), JSON.stringify(context), key, img.bytes.byteLength, img.width, img.height, t).run();
  } catch (e) { await env.FILES.delete(key).catch(() => {}); throw e; }
  await logEvent(env, p.id, 'feedback_added', note.slice(0, 120) || `${marks.length} mark${marks.length === 1 ? '' : 's'}`, version ?? null, 'console');
  return { id, pending: await pendingFeedback(env, p.id) };
}

/** The queue as the console shows it, oldest first. The picture comes from feedbackImage. */
export async function listFeedback(env: Env, p: Project) {
  const rows = await env.DB.prepare('SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at, id LIMIT 100').bind(p.id).all<FeedbackRow>();
  const s = await getSettings(env);
  return {
    enabled: s.feedback_enabled, max_pending: s.feedback_max_pending, keep_days: s.feedback_keep_days,
    items: rows.results.map((r) => ({ id: r.id, version: r.version, note: r.note, marks: parseJson(r.marks, []), context: parseJson(r.context, {}), width: r.width, height: r.height, bytes: r.bytes, created_at: r.created_at })),
  };
}

export async function feedbackImage(env: Env, p: Project, id: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT image_key FROM feedback WHERE id = ? AND project_id = ?').bind(id, p.id).first<{ image_key: string | null }>();
  const obj = r?.image_key ? await env.FILES.get(r.image_key) : null;
  if (!obj) throw notFound('That feedback item is gone: it was removed or your agent already read it.');
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
}

/** The creator removes an item by hand. */
export async function removeFeedback(env: Env, p: Project, id: string) {
  const r = await env.DB.prepare('DELETE FROM feedback WHERE id = ? AND project_id = ? RETURNING image_key').bind(id, p.id).first<{ image_key: string | null }>();
  if (!r) throw notFound('That feedback item is gone: it was removed or your agent already read it.');
  if (r.image_key) await env.FILES.delete(r.image_key).catch(() => {});
  return { ok: true, pending: await pendingFeedback(env, p.id) };
}

/** Text for one item as the agent reads it. */
function itemText(r: FeedbackRow, n: number) {
  const marks = parseJson<any[]>(r.marks, []), ctx = parseJson<Record<string, any>>(r.context, {});
  return {
    item: n, id: r.id, version: r.version, taken_at: new Date(r.created_at).toISOString(),
    note: r.note || '(no note: see the marks on the picture)',
    picture: r.image_key ? `${r.width} × ${r.height} px, shown below as image ${n}. Each mark is drawn on it with its number.` : 'missing',
    marks: describeMarks(marks, r.width, r.height),
    ...(ctx.viewport ? { screen: `${ctx.viewport.width} × ${ctx.viewport.height}${ctx.fullscreen ? ', fullscreen' : ''}${ctx.touch ? ', touch screen' : ''}` } : {}),
    captured_from: ctx.method === 'screen' ? 'the browser\'s own pixels of the game, exactly as the creator saw it (tab capture)' : ctx.method === 'upload' ? 'a screenshot the creator took themselves and pasted or uploaded (exactly what they saw)' : ctx.method === 'page' ? 'the game page redrawing itself: its canvases and the page elements over them, frozen at one frame (close to what the creator saw, but icons, fonts or effects can differ)' : 'the game\'s canvas (HTML overlays such as menus made of page elements are not in the picture)',
    ...(ctx.browser ? { browser: ctx.browser } : {}),
    ...(ctx.frames !== undefined ? { frames_rendered: ctx.frames } : {}), ...(ctx.fps !== undefined ? { fps: ctx.fps } : {}),
    ...(ctx.label ? { loading_label: ctx.label } : {}),
    ...(ctx.errors?.length ? { errors_in_the_page: ctx.errors } : {}), ...(ctx.warnings?.length ? { console_errors: ctx.warnings } : {}),
    ...(ctx.state ? { game_state: ctx.state } : {}),
  };
}

/**
 * Takes up to `limit` items off the queue, oldest first, and returns them with their pictures. Each item is deleted in
 * the same statement that claims it, so two agents reading at once never get the same item, and its picture is deleted
 * after it was read. peek: count and notes only, nothing taken.
 */
export async function takeFeedback(env: Env, p: Project, limit: number, peek: boolean, actor: string) {
  const n = Math.max(1, Math.min(FEEDBACK_LIMITS.read_max, Math.round(limit) || 3));
  if (peek) {
    const rows = await env.DB.prepare('SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at, id LIMIT 30').bind(p.id).all<FeedbackRow>();
    return { items: rows.results.map((r, i) => ({ ...itemText(r, i + 1), picture: 'not included: read the item to get it' })), images: [] as { data: Uint8Array; type: string }[], pending: await pendingFeedback(env, p.id) };
  }
  const rows = await env.DB.prepare('DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE project_id = ?1 ORDER BY created_at, id LIMIT ?2) AND project_id = ?1 RETURNING *')
    .bind(p.id, n).all<FeedbackRow>();
  const got = rows.results.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const images: { data: Uint8Array; type: string }[] = [], items = [];
  for (const r of got) {
    const obj = r.image_key ? await env.FILES.get(r.image_key).catch(() => null) : null;
    const bytes = obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    if (bytes) images.push({ data: bytes, type: obj!.httpMetadata?.contentType || 'image/jpeg' });
    items.push({ ...itemText(r, items.length + 1), ...(bytes ? {} : { picture: 'missing (the picture could not be loaded)' }) });
  }
  await Promise.all(got.filter((r) => r.image_key).map((r) => env.FILES.delete(r.image_key!).catch(() => {})));
  if (got.length) await logEvent(env, p.id, 'feedback_read', `Your agent read ${got.length} feedback item${got.length === 1 ? '' : 's'}`, null, actor);
  return { items, images, pending: await pendingFeedback(env, p.id) };
}

/** Daily: unread items past their keeping time, with their pictures. */
export async function purgeOldFeedback(env: Env, max = 200): Promise<number> {
  const s = await getSettings(env), before = now() - Math.max(1, s.feedback_keep_days) * 86400000;
  const rows = await env.DB.prepare('DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE created_at < ? LIMIT ?) RETURNING image_key').bind(before, max).all<{ image_key: string | null }>();
  const keys = rows.results.map((r) => r.image_key).filter(Boolean) as string[];
  if (keys.length) await env.FILES.delete(keys).catch(() => {});
  return keys.length;
}
