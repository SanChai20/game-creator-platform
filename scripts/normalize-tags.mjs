// One-time cleanup of tags stored before the platform tag list existed (web/src/tags.ts): genres stay first, words
// with a clear meaning on the list are mapped (pixel -> pixel-art), anything else is dropped. Safe to run again.
//   node scripts/normalize-tags.mjs --local        the local dev database
//   node scripts/normalize-tags.mjs --remote       production (needs CLOUDFLARE_API_TOKEN)
//   add --dry-run to only print what would change
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeStoredTags } from '../web/src/tags.ts';

const where = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
if (!where) { console.error('Say --local or --remote.'); process.exit(1); }
const dry = process.argv.includes('--dry-run');
const d1 = (...args) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'gcp-db', where, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });

const rows = JSON.parse(d1('--json', '--command', 'SELECT id, slug, tags FROM projects'))[0].results;
const changes = [];
for (const r of rows) {
  let stored; try { stored = JSON.parse(r.tags || '[]'); } catch { stored = []; }
  const next = normalizeStoredTags(stored);
  if (JSON.stringify(next) !== JSON.stringify(stored)) changes.push({ id: r.id, slug: r.slug, from: stored, to: next });
}
for (const c of changes) console.log(`${c.slug}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
console.log(`${changes.length} of ${rows.length} projects ${dry ? 'would change' : 'to update'}.`);
if (dry || !changes.length) process.exit(0);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const file = join(mkdtempSync(join(tmpdir(), 'tags-')), 'normalize.sql');
writeFileSync(file, changes.map((c) => `UPDATE projects SET tags = ${q(JSON.stringify(c.to))} WHERE id = ${q(c.id)};`).join('\n') + '\n');
d1('--file', file);
console.log('Done.');
