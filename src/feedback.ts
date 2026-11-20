// The creator feedback queue: annotated screenshots of a game's preview, taken by its creator in the console, waiting for
// their agent. The console adds and removes items; the agent reads them with creator_feedback, which takes each item off
// the queue as it returns it, so nothing is read twice. A read item is kept for a day (TAKEN_KEEP_MS) where only the agent
// sees it (recent: true), so an answer that never reached it is not lost. Besides the annotated screenshot, an item can
// carry a few pictures of the creator's own (design mockups, references), each with its own marks. Only the game's owner reaches its queue (not admins, not other
// accounts), and the queue is small and short-lived: a few dozen items per game, kept a month at most. The rules for
// what an item holds are in feedback-rules.js (tests/feedback.mjs).
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from './env';
import { rateLimit } from './auth';
import { logEvent, ownedProject } from './projects';
import { getSettings } from './settings';
import { now, parseJson, rid } from './util';
// @ts-ignore plain JS module shared with the tests
import { FEEDBACK_LIMITS, FeedbackError, cleanAttachments, cleanContext, cleanMarks, cleanNote, describeMarks, parseImage } from './feedback-rules.js';

const ADDS_PER_HOUR = 60;   // per account, across games
const TAKEN_KEEP_MS = 24 * 3600000;   // a read item stays this long for creator_feedback { recent: true }
// Pictures one creator_feedback answer carries at most. Agents' clients refuse very large answers (several MB of images);
// items over the budget stay queued for the next call. The first item always goes, whatever its size (an item's pictures
// together are held to FEEDBACK_LIMITS.item_bytes, below this).
const ANSWER_IMAGE_BYTES = 3_500_000;

/** A picture the creator attached, as stored in feedback.attachments. */
interface Attached { key: string; type: string; bytes: number; width: number; height: number; marks: any[]; name?: string }

export interface FeedbackRow {
  id: string; project_id: string; owner_id: string; version: number | null; note: string; marks: string; context: string;
  image_key: string | null; bytes: number; width: number; height: number; created_at: number; taken_at?: number | null;
  attachments?: string | null;
}
const attachedOf = (r: { attachments?: string | null }) => parseJson<Attached[]>(r.attachments || '[]', []).filter((a) => a && a.key);
const keysOf = (r: { image_key: string | null; attachments?: string | null }) => [r.image_key, ...attachedOf(r).map((a) => a.key)].filter(Boolean) as string[];

/** The project, only for its owner: the feedback queue is the creator's conversation with their own agent. */
export async function feedbackProject(env: Env, user: User, idOrSlug: string): Promise<Project> {
  const p = await ownedProject(env, user, idOrSlug);
  if (p.owner_id !== user.id) throw forbidden('Only the game\'s creator can see its feedback queue.');
  return p;
}

const keyOf = (pid: string, id: string, type: string, n = 0) => `feedback/${pid}/${id}${n ? '-' + n : ''}.${type === 'image/png' ? 'png' : 'jpg'}`;
const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof FeedbackError) throw bad(e.message); throw e; } };

export async function pendingFeedback(env: Env, pid: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE project_id = ? AND taken_at IS NULL').bind(pid).first<{ n: number }>().catch(() => null);
  return r?.n || 0;
}

/** Adds one item from the console. body: { image (data URL), note, marks, context, version, attachments: [{ image, marks, name }] }. */
export async function addFeedback(env: Env, user: User, p: Project, body: Record<string, unknown>) {
  const s = await getSettings(env);
  if (!s.feedback_enabled) throw new AppError(403, 'Creator feedback is switched off on this platform.', 'disabled');
  if (p.owner_id !== user.id) throw forbidden('Only the game\'s creator can add feedback.');
  const note = cleanNote(body.note), marks = wrap(() => cleanMarks(body.marks)), context = cleanContext(body.context);
  type Img = { bytes: Uint8Array; type: string; width: number; height: number };
  const img = wrap(() => parseImage(body.image)) as Img;
  const attached = wrap(() => cleanAttachments(body.attachments, img.bytes.byteLength)) as (Img & { marks: any[]; name?: string })[];
  if (!note && !marks.length && !attached.length) throw bad('Write a note or mark something on the screenshot first.');
  await rateLimit(env, 'feedback:' + user.id, ADDS_PER_HOUR, 3600);
  const max = Math.max(1, s.feedback_max_pending);
  if ((await pendingFeedback(env, p.id)) >= max) throw new AppError(409, `${max} items are already waiting for your agent. Remove some, or ask your agent to read them (creator_feedback).`, 'queue_full');
  const version = Number.isInteger(body.version) && (body.version as number) > 0 ? body.version as number : p.preview_version;
  const id = 'fb_' + rid(14), key = keyOf(p.id, id, img.type), t = now();
  const stored: Attached[] = attached.map((a, i) => ({ key: keyOf(p.id, id, a.type, i + 1), type: a.type, bytes: a.bytes.byteLength, width: a.width, height: a.height, marks: a.marks, ...(a.name ? { name: a.name } : {}) }));
  const keys = [key, ...stored.map((a) => a.key)], total = img.bytes.byteLength + stored.reduce((n, a) => n + a.bytes, 0);
  try {
    // every picture is stored before the row exists, so the agent never reads an item with a picture still on its way
    await Promise.all([env.FILES.put(key, img.bytes, { httpMetadata: { contentType: img.type } }),
      ...attached.map((a, i) => env.FILES.put(stored[i].key, a.bytes, { httpMetadata: { contentType: a.type } }))]);
    await env.DB.prepare('INSERT INTO feedback (id, project_id, owner_id, version, note, marks, context, image_key, bytes, width, height, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, p.id, p.owner_id, version ?? null, note, JSON.stringify(marks), JSON.stringify(context), key, total, img.width, img.height, t, JSON.stringify(stored)).run();
  } catch (e) { await env.FILES.delete(keys).catch(() => {}); throw e; }
  const said = note.slice(0, 120) || `${marks.length} mark${marks.length === 1 ? '' : 's'}`;
  await logEvent(env, p.id, 'feedback_added', stored.length ? `${said} (+${stored.length} attached picture${stored.length === 1 ? '' : 's'})` : said, version ?? null, 'console');
  return { id, pending: await pendingFeedback(env, p.id) };
}

/** The queue as the console shows it, oldest first. The picture comes from feedbackImage. */
export async function listFeedback(env: Env, p: Project) {
  const rows = await env.DB.prepare('SELECT * FROM feedback WHERE project_id = ? AND taken_at IS NULL ORDER BY created_at, id LIMIT 100').bind(p.id).all<FeedbackRow>();
  const s = await getSettings(env);
  return {
    enabled: s.feedback_enabled, max_pending: s.feedback_max_pending, keep_days: s.feedback_keep_days,
    items: rows.results.map((r) => ({ id: r.id, version: r.version, note: r.note, marks: parseJson(r.marks, []), context: parseJson(r.context, {}), width: r.width, height: r.height, bytes: r.bytes, created_at: r.created_at,
      attachments: attachedOf(r).map((a, i) => ({ n: i + 1, width: a.width, height: a.height, bytes: a.bytes, marks: a.marks || [], ...(a.name ? { name: a.name } : {}) })) })),
  };
}

/** One picture of an item: n 0 is the annotated screenshot, 1… the pictures the creator attached. */
export async function feedbackImage(env: Env, p: Project, id: string, n = 0): Promise<Response> {
  const r = await env.DB.prepare('SELECT image_key, attachments FROM feedback WHERE id = ? AND project_id = ?').bind(id, p.id).first<{ image_key: string | null; attachments: string | null }>();
  const key = !r ? null : n > 0 ? attachedOf(r)[n - 1]?.key : r.image_key;
  const obj = key ? await env.FILES.get(key) : null;
  if (!obj) throw notFound('That feedback item is gone: it was removed or your agent already read it.');
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
}

/** The creator removes an item by hand. */
export async function removeFeedback(env: Env, p: Project, id: string) {
  const r = await env.DB.prepare('DELETE FROM feedback WHERE id = ? AND project_id = ? RETURNING image_key, attachments').bind(id, p.id).first<{ image_key: string | null; attachments: string | null }>();
  if (!r) throw notFound('That feedback item is gone: it was removed or your agent already read it.');
  const keys = keysOf(r); if (keys.length) await env.FILES.delete(keys).catch(() => {});
  return { ok: true, pending: await pendingFeedback(env, p.id) };
}

/**
 * Text for one item as the agent reads it. `images` is the number in the answer of each of the item's pictures (the
 * screenshot, then each attached one), or null for a picture not included.
 */
function itemText(r: FeedbackRow, n: number, images: (number | null)[]) {
  const marks = parseJson<any[]>(r.marks, []), ctx = parseJson<Record<string, any>>(r.context, {}), attached = attachedOf(r);
  const shown = (i: number, w: number, h: number, what: string) => images[i] ? `${w} × ${h} px, shown below as image ${images[i]}.${what}` : 'not included: read the item to get it';
  return {
    item: n, id: r.id, version: r.version, taken_at: new Date(r.created_at).toISOString(),
    note: r.note || (attached.length ? '(no note: see the marks on the pictures)' : '(no note: see the marks on the picture)'),
    picture: r.image_key ? shown(0, r.width, r.height, ' Each mark is drawn on it with its number.') : 'missing',
    // a picture of the whole game (not the creator's own screenshot) maps straight onto the game's CSS pixels
    marks: describeMarks(marks, r.width, r.height, ctx.method !== 'upload' ? ctx.viewport : undefined),
    ...(ctx.viewport ? { screen: `${ctx.viewport.width} × ${ctx.viewport.height} CSS px${ctx.dpr && ctx.dpr !== 1 ? ` at ${ctx.dpr}× pixel ratio` : ''}${ctx.fullscreen ? ', fullscreen' : ''}${ctx.touch ? ', touch screen' : ''}` } : {}),
    ...(ctx.capture?.trimmed ? { capture_note: 'The browser drew the tab into only part of its capture frame; the picture was cut from the part it drew. If it still looks off, it is the browser\'s capture, not the game.' } : ctx.capture?.mismatch ? { capture_note: 'The page was resizing while the picture was taken; the game may look slightly off its edges.' } : {}),
    captured_from: ctx.exact ? `the exact frame the game drew when the creator pressed Capture, handed over by its GCP.test.onCapture hook${ctx.redrawn?.length ? ` (text fields over the game, ${ctx.redrawn.join(', ')}, drawn from the page)` : ''}` : ctx.method === 'screen' ? 'the browser\'s own pixels of the game, exactly as the creator saw it (tab capture)' : ctx.method === 'upload' ? 'a screenshot the creator took themselves and pasted or uploaded (exactly what they saw)' : ctx.method === 'page' ? 'the game page redrawing itself: its canvases and the page elements over them, frozen at one frame (close to what the creator saw, but icons, fonts or effects can differ)' : 'the game\'s canvas (HTML overlays such as menus made of page elements are not in the picture)',
    ...(ctx.browser ? { browser: ctx.browser } : {}),
    ...(ctx.frames !== undefined ? { frames_rendered: ctx.frames } : {}), ...(ctx.fps !== undefined ? { fps: ctx.fps } : {}),
    ...(ctx.label ? { loading_label: ctx.label } : {}),
    ...(ctx.errors?.length ? { errors_in_the_page: ctx.errors } : {}), ...(ctx.warnings?.length ? { console_errors: ctx.warnings } : {}),
    ...(ctx.state ? { game_state: ctx.state } : {}),
    // the creator's own pictures: what they want, not what the game shows
    ...(attached.length ? { attached_pictures: attached.map((a, i) => ({
      attached: i + 1, ...(a.name ? { file: a.name } : {}),
      picture: shown(i + 1, a.width, a.height, (a.marks || []).length ? ' Its marks are drawn on it with their numbers.' : ''),
      what: 'a picture the creator attached themselves (a design mockup, a reference or a photo), not a capture of the game: read it together with the note',
      ...((a.marks || []).length ? { marks: describeMarks(a.marks, a.width, a.height) } : {}),
    })) } : {}),
  };
}

/**
 * Takes up to `limit` items off the queue, oldest first, and returns them with their pictures. Each item is claimed in
 * one statement (two agents reading at once never get the same item) and kept for a day after, for recent: true. Items
 * whose pictures would make the answer too large stay queued for the next call. peek: count and notes only, nothing
 * taken. recent: the items read in the last day again, newest first, with their pictures; nothing changes.
 */
export async function takeFeedback(env: Env, p: Project, limit: number, peek: boolean, actor: string, recent = false) {
  const n = Math.max(1, Math.min(FEEDBACK_LIMITS.read_max, Math.round(limit) || 3)), t = now();
  if (peek) {
    const rows = await env.DB.prepare('SELECT * FROM feedback WHERE project_id = ? AND taken_at IS NULL ORDER BY created_at, id LIMIT 30').bind(p.id).all<FeedbackRow>();
    return { items: rows.results.map((r, i) => itemText(r, i + 1, [])), images: [] as { data: Uint8Array; type: string }[], pending: await pendingFeedback(env, p.id) };
  }
  let got: FeedbackRow[];
  if (recent) {
    got = (await env.DB.prepare('SELECT * FROM feedback WHERE project_id = ? AND taken_at > ? ORDER BY taken_at DESC, created_at DESC LIMIT ?').bind(p.id, t - TAKEN_KEEP_MS, n).all<FeedbackRow>()).results;
  } else {
    const rows = await env.DB.prepare('UPDATE feedback SET taken_at = ?3 WHERE id IN (SELECT id FROM feedback WHERE project_id = ?1 AND taken_at IS NULL ORDER BY created_at, id LIMIT ?2) AND project_id = ?1 AND taken_at IS NULL RETURNING *')
      .bind(p.id, n, t).all<FeedbackRow>();
    got = rows.results.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }
  const images: { data: Uint8Array; type: string }[] = [], items = [], back: string[] = [];
  let budget = ANSWER_IMAGE_BYTES;
  const load = async (key: string | null | undefined) => {
    const obj = key ? await env.FILES.get(key).catch(() => null) : null;
    return obj ? { data: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType || 'image/jpeg' } : null;
  };
  for (const r of got) {
    if (items.length && r.bytes > budget) { back.push(r.id); continue; }   // too much for one answer: the next call
    // all of an item's pictures go in the same answer, in order: the screenshot, then each attached one
    const pics = await Promise.all([load(r.image_key), ...attachedOf(r).map((a) => load(a.key))]);
    const numbers = pics.map((x) => (x ? (images.push(x), budget -= x.data.byteLength, images.length) : null));
    const text = itemText(r, items.length + 1, numbers);
    if (!pics[0]) text.picture = 'missing (the picture could not be loaded)';
    text.attached_pictures?.forEach((a, i) => { if (!pics[i + 1]) a.picture = 'missing (the picture could not be loaded)'; });
    items.push(text);
  }
  if (back.length && !recent) await env.DB.prepare(`UPDATE feedback SET taken_at = NULL WHERE project_id = ? AND id IN (${back.map(() => '?').join(', ')})`).bind(p.id, ...back).run();
  if (items.length && !recent) await logEvent(env, p.id, 'feedback_read', `Your agent read ${items.length} feedback item${items.length === 1 ? '' : 's'}`, null, actor);
  return { items, images, pending: await pendingFeedback(env, p.id) };
}

/** Daily: unread items past their keeping time and items read over a day ago, with their pictures. */
export async function purgeOldFeedback(env: Env, max = 200): Promise<number> {
  const s = await getSettings(env), before = now() - Math.max(1, s.feedback_keep_days) * 86400000;
  // unread past the keeping time, and read more than a day ago
  const rows = await env.DB.prepare('DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE created_at < ?1 OR taken_at < ?2 LIMIT ?3) RETURNING image_key, attachments').bind(before, now() - TAKEN_KEEP_MS, max).all<{ image_key: string | null; attachments: string | null }>();
  const keys = rows.results.flatMap(keysOf);
  // R2 deletes at most 1000 keys per call
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000)).catch(() => {});
  return rows.results.length;
}
