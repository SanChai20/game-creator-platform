// Runs one corpus case through the static and browser checks and prints the full report (for debugging a case).
import { join } from 'node:path';
import * as H from './harness.mjs';
const id = process.argv[2];
const c = H.loadCase(join(H.ROOT, 'tests/moderation/corpus', id));
const platform = await H.startPlatform();
const st = await H.staticCheck(c, platform.origin);
if (!st.ok) { console.log('static:', JSON.stringify(st).slice(0, 1500)); process.exit(0); }
const url = await platform.deploy(c, st.manifest);
const { report } = await H.browserCheck(url, !!st.manifest.usesWebGPU, platform.origin);
console.log(JSON.stringify({ ok: report.ok, checks: report.checks.map((k) => [k.id, k.ok, k.detail]), errors: report.errors, metrics: report.metrics, page: report.page, conduct: report.conduct, playthrough: report.playthrough }, null, 1).slice(0, 6000));
await H.closeBrowser(); process.exit(0);
