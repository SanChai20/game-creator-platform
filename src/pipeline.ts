// One Durable Object per project runs its deploy → verify → publish jobs in order, outside any request,
// so a slow first deploy or a long browser check never times out the agent's tool call.
import { DurableObject } from 'cloudflare:workers';
import type { Env, Project, Version } from './env';
import { deployGame, onSharedHost, playKey, waitHealthy } from './deploy';
import { switchLive } from './go-live';
import { getProject, getVersion, logEvent } from './projects';
import { browserVerify } from './verify';
import { afterPublish } from './implementations';
import { syncMature } from './mature';
import { originalityCheck } from './originality-check';
import { gateText, noteWaivers, recordGate, releaseGate, type GateMode } from './release-gate';
import { now, parseJson, rid } from './util';
// @ts-ignore plain JS module
import { signPlayToken } from './runtime/game-worker.js';
// @ts-ignore plain JS module
import { verifierId } from './player-data.js';

/** mode (publish jobs): what kind of release this is, which decides the rules it meets (src/release-gate.ts). A job
    without one is a new release and meets every rule. */
export interface Job { kind: 'preview' | 'publish'; pid: string; n: number; origin: string; actor: string; mode?: GateMode }

export class Pipeline extends DurableObject<Env> {
  async start(job: Job): Promise<void> {
    const jobs = (await this.ctx.storage.get<Job[]>('jobs')) || [];
    jobs.push(job);
    await this.ctx.storage.put('jobs', jobs);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const jobs = (await this.ctx.storage.get<Job[]>('jobs')) || [];
    const job = jobs.shift();
    await this.ctx.storage.put('jobs', jobs);
    if (job) {
      try { await runJob(this.env, job); }
      catch (e) {
        const msg = String((e as Error).message || e).slice(0, 600);
        console.error('pipeline job failed', job, msg);
        await this.env.DB.prepare("UPDATE versions SET status = 'failed', stage = ?, report = ? WHERE project_id = ? AND n = ? AND status IN ('queued','deploying','verifying')")
          .bind('Failed: ' + msg.slice(0, 200), JSON.stringify({ ok: false, summary: msg, checks: [{ id: 'deployed', ok: false, label: 'Deployment succeeds', detail: msg }], errors: [] }), job.pid, job.n).run();
        await logEvent(this.env, job.pid, job.kind === 'publish' ? 'publish_failed' : 'deploy_failed', msg, job.n, job.actor);
      }
    }
    if (jobs.length) await this.ctx.storage.setAlarm(Date.now());
  }
}

export async function enqueue(env: Env, job: Job): Promise<void> {
  const stub = env.PIPELINE.get(env.PIPELINE.idFromName(job.pid)) as unknown as { start(job: Job): Promise<void> };
  await stub.start(job);
}

async function runJob(env: Env, job: Job): Promise<void> {
  const p = await getProject(env, job.pid);
  const v = await getVersion(env, job.pid, job.n);
  if (!p || !v) return;
  if (job.kind === 'preview') await runPreview(env, job, p, v);
  else await runPublish(env, job, p, v);
}

const stage = (env: Env, v: Version, status: string, text: string) =>
  env.DB.prepare('UPDATE versions SET status = ?, stage = ? WHERE project_id = ? AND n = ?').bind(status, text, v.project_id, v.n).run();

async function runPreview(env: Env, job: Job, p: Project, v: Version): Promise<void> {
  await stage(env, v, 'deploying', 'Deploying the preview Worker');
  const url = await deployGame(env, job.origin, p, v, 'preview');
  await env.DB.prepare('UPDATE projects SET preview_version = ?, updated_at = ? WHERE id = ?').bind(v.n, now(), p.id).run();
  await stage(env, v, 'deploying', 'Waiting for the preview Worker to answer');
  const health = await waitHealthy(env, url, v.n);
  let report: Record<string, any>, shot: Uint8Array | null = null, frames: Uint8Array[] = [];
  if (!health.ok) {
    report = { ok: false, summary: health.detail, checks: [{ id: 'deployed', ok: false, label: 'The deployed game responds', detail: health.detail }], errors: [] };
  } else {
    await stage(env, v, 'verifying', 'Running the game in a browser');
    // The verifier plays under a throwaway identity of its own: it starts from no save and never touches the creator's progress.
    // The two-player check's guest page gets a second one, so a server-run match (seated by player id) sees two players.
    const [sid, sid2] = ['vf_' + rid(12), 'vf_' + rid(12)], key = await playKey(env, p.id), x = Math.floor(now() / 1000) + 900;
    const play = env.DB.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, ?, ?, 'preview', ?, 'verify', ?, ?)");
    await env.DB.batch([play.bind(sid, p.id, v.n, p.owner_id, now(), now()), play.bind(sid2, p.id, v.n, p.owner_id, now(), now())]);
    const token = await signPlayToken({ g: p.id, e: 'preview', u: verifierId(sid), n: 'Verifier', k: 'verify', s: sid, x }, key);
    const guestToken = await signPlayToken({ g: p.id, e: 'preview', u: verifierId(sid2), n: 'Verifier 2', k: 'verify', s: sid2, x }, key);
    const mf = parseJson<{ usesWebGPU?: boolean; compat?: { requirements?: { devices?: string[]; orientation?: string } } }>(v.manifest, {}), req = mf.compat?.requirements || {};
    const device = { devices: Array.isArray(req.devices) && req.devices.length ? req.devices : ['desktop', 'tablet', 'mobile'], orientation: String(req.orientation || 'any') };
    const out = await browserVerify(env, `${url}?gcp_t=${token}&gcp_autostart=1`, !!mf.usesWebGPU, job.origin, `${url}?gcp_t=${guestToken}&gcp_autostart=1`, device, p.status === 'live');
    report = out.report; shot = out.shot; frames = out.frames || [];
    report.deploy = health.detail;
  }
  let shotKey: string | null = null;
  if (shot) { shotKey = `shots/${p.id}/${v.n}.png`; await env.FILES.put(shotKey, shot, { httpMetadata: { contentType: 'image/png' } }); }
  // the frames the content review looks at: what the verification browser saw while it played the game
  if (frames.length) {
    report.frames = frames.map((_, i) => `shots/${p.id}/${v.n}-play-${i}.jpg`);
    await Promise.all(frames.map((f, i) => env.FILES.put(report.frames[i], f, { httpMetadata: { contentType: 'image/jpeg' } })));
  }
  if (report.ok) {
    await stage(env, v, 'verifying', 'Comparing with other creators\' games');
    try { await originalityCheck(env, p, { ...v, screenshot_key: shotKey }, report); }
    catch (e) { console.error('originality check failed', p.id, v.n, e); report.notes = [...(report.notes || []), 'The originality check could not run for this version; it runs again when the version is published.']; }
  }
  const ok = !!report.ok;
  await env.DB.prepare('UPDATE versions SET status = ?, stage = ?, report = ?, screenshot_key = ?, verified_at = ? WHERE project_id = ? AND n = ?')
    .bind(ok ? 'verified' : 'failed', String(report.summary || '').slice(0, 300), JSON.stringify(report), shotKey, ok ? now() : null, p.id, v.n).run();
  await logEvent(env, p.id, ok ? 'verified' : 'verify_failed', String(report.summary || ''), v.n, job.actor);
}

async function runPublish(env: Env, job: Job, p: Project, v: Version): Promise<void> {
  // The authoritative check: every platform requirement, right before the version goes live, whoever asked for it.
  const mode: GateMode = job.mode === 'rollback' || job.mode === 'restore' ? job.mode : 'publish';
  const gate = await releaseGate(env, p, v, { mode });
  await recordGate(env, gate);
  if (!gate.ok) { await logEvent(env, p.id, 'publish_failed', gateText(gate), v.n, job.actor); return; }
  const url = await deployGame(env, job.origin, p, v, 'live');
  // the store labels the game from the version going live (an adults-only game is blurred and asks players to confirm); before it is live
  const health = await switchLive(env, p, v, url, await onSharedHost(env, p.id, 'live'), waitHealthy, () => syncMature(env, p.id, v));
  if (!health.ok) { await logEvent(env, p.id, 'publish_failed', health.detail, v.n, job.actor); return; }
  await noteWaivers(env, gate, job.actor);
  await logEvent(env, p.id, 'published', `Version ${v.n} is live`, v.n, job.actor);
  await afterPublish(env, p.id);
}
