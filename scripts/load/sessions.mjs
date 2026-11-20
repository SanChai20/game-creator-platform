// Signs in seeded players for players.mjs: writes sessions straight into the local D1 file and their cookies to
// tokens.json beside this script. node scripts/load/sessions.mjs <local D1 sqlite file> [count]
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const [file, count = '2000'] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout=5000');
const st = db.prepare('INSERT OR REPLACE INTO sessions (id, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)');
const out = [];
for (let i = 0; i < Number(count); i++) {
  const t = 'loadtok' + i + 'x'.repeat(20);
  st.run(createHash('sha256').update(t).digest('hex'), 'u_seed' + (5000 + i), Date.now(), Date.now() + 86400000, 'load');
  out.push(t);
}
writeFileSync(new URL('./tokens.json', import.meta.url), JSON.stringify(out));
console.log(`${out.length} sessions`);
