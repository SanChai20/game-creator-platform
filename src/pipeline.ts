// One Durable Object per project runs its deploy → verify → publish jobs in order, outside any request,
// so a slow first deploy or a long browser check never times out the agent's tool call.
import { DurableObject } from 'cloudflare:workers';
import type { Env, Project, Version } from './env';
import { deployGame, playKey, waitHealthy } from './deploy';
import { getProject, getVersion, logEvent } from './projects';
import { browserVerify } from './verify';
import { now, parseJson, rid } from './util';
// @ts-ignore plain JS module
import { signPlayToken } from './runtime/game-worker.js';

export interface Job { kind: 'preview' | 'publish'; pid: string; n: number; origin: string; actor: string }

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
  let report: Record<string, any>, shot: Uint8Array | null = null;
  if (!health.ok) {
    report = { ok: false, summary: health.detail, checks: [{ id: 'deployed', ok: false, label: 'The deployed game responds', detail: health.detail }], errors: [] };
  } else {
    await stage(env, v, 'verifying', 'Running the game in a browser');
    const sid = 'vf_' + rid(12);
    await env.DB.prepare("INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES (?, ?, ?, 'preview', ?, 'verify', ?, ?)").bind(sid, p.id, v.n, p.owner_id, now(), now()).run();
    const token = await signPlayToken({ g: p.id, e: 'preview', u: p.owner_id, n: 'Verifier', k: 'verify', s: sid, x: Math.floor(now() / 1000) + 900 }, await playKey(env, p.id));
    const out = await browserVerify(env, `${url}?gcp_t=${token}&gcp_autostart=1`, !!parseJson<{ usesWebGPU?: boolean }>(v.manifest, {}).usesWebGPU);
    report = out.report; shot = out.shot;
    report.deploy = health.detail;
  }
  let shotKey: string | null = null;
  if (shot) { shotKey = `shots/${p.id}/${v.n}.png`; await env.FILES.put(shotKey, shot, { httpMetadata: { contentType: 'image/png' } }); }
  const ok = !!report.ok;
  await env.DB.prepare('UPDATE versions SET status = ?, stage = ?, report = ?, screenshot_key = ?, verified_at = ? WHERE project_id = ? AND n = ?')
    .bind(ok ? 'verified' : 'failed', String(report.summary || '').slice(0, 300), JSON.stringify(report), shotKey, ok ? now() : null, p.id, v.n).run();
  await logEvent(env, p.id, ok ? 'verified' : 'verify_failed', String(report.summary || ''), v.n, job.actor);
}

async function runPublish(env: Env, job: Job, p: Project, v: Version): Promise<void> {
  const url = await deployGame(env, job.origin, p, v, 'live');
  const health = await waitHealthy(env, url, v.n);
  if (!health.ok) { await logEvent(env, p.id, 'publish_failed', health.detail, v.n, job.actor); return; }
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET status = 'live', live_version = ?, published_at = COALESCE(published_at, ?), cover_key = COALESCE(cover_key, ?), updated_at = ? WHERE id = ? AND status != 'removed'").bind(v.n, t, v.screenshot_key, t, p.id),
    env.DB.prepare('UPDATE versions SET published_at = ? WHERE project_id = ? AND n = ?').bind(t, p.id, v.n),
  ]);
  await logEvent(env, p.id, 'published', `Version ${v.n} is live`, v.n, job.actor);
}
