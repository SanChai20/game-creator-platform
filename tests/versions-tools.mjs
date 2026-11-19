// What the version tools tell an agent (found building Void Echoes): a failed version can be checked again without a new
// number, the version list says which checks failed and how to read any report, the upload URLs come as plain fields, and
// publish says where an open-implementation choice it did not make came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts'), verify = read('src/verify-core.js');

test('deploy_preview retry_version re-checks only the newest failed version, a few times', () => {
  assert.match(tools, /retry_version: \{ type: 'integer'/);
  const fn = tools.slice(tools.indexOf('async function retryPreview'), tools.indexOf('/** Tells the agent when its creator'));
  assert.match(fn, /is not the newest version/);
  assert.match(fn, /v\.status !== 'failed'/);
  assert.match(fn, /RETRY_LIMIT/);
  assert.match(fn, /status = 'queued'[^"]*AND status = 'failed'/, 'only a failed row is requeued, atomically');
  assert.match(fn, /enqueue\(c\.env, \{ kind: 'preview', pid: p\.id, n,/, 'same version number');
});

test('list_versions rows carry the summary and failed checks, and point at the full report', () => {
  assert.match(tools, /\.\.\.failedChecks\(v\)/);
  assert.match(tools, /for the full report of a version/);
});

test('create_upload_url returns bare URLs next to the commands', () => {
  assert.match(tools, /file_url: `\$\{base\}\?path=`, zip_url: `\$\{base\}\/zip`/);
});

test('publish reports who turned open implementation on when the call left it out', () => {
  assert.match(tools, /open_implementation: await sharingSource\(c, q, a\.open_implementation\)/);
  assert.match(tools, /kind = 'implementation_opened'/);
});

test('a slow but live loop gets more time on the frame and input checks', () => {
  assert.match(verify, /f1 > 0 && f1 < o\.minFrames && k < 2/);
  assert.match(verify, /!domGame && f2 > 0 && f2 < need && k < 2/);
});
