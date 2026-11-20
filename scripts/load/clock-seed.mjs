// Seeds a play-clock test database (a staging copy, never production): node scripts/load/clock-seed.mjs <players> <games> > seed.sql
// Writes signed-in players (their cookies to clock-tokens.json beside this script) and free live games.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const [players = 1000, games = 20] = process.argv.slice(2).map(Number);
const t = Date.now(), out = ['PRAGMA defer_foreign_keys = true;'], toks = [];
out.push(`INSERT OR IGNORE INTO users (id, email, name, pw_hash, created_at) VALUES ('u_ldmaker', 'ldmaker@example.com', 'Load maker', 'x', ${t});`);
for (let g = 0; g < games; g++) {
  out.push(`INSERT OR IGNORE INTO projects (id, owner_id, slug, title, status, live_version, preview_version, next_version, price_cents, created_at, updated_at, published_at) VALUES ('ldgame${g}', 'u_ldmaker', 'load-game-${g}', 'Load game ${g}', 'live', 1, 1, 2, 0, ${t}, ${t}, ${t});`);
  out.push(`INSERT OR IGNORE INTO versions (project_id, n, manifest, status, created_at, verified_at, published_at) VALUES ('ldgame${g}', 1, '{}', 'verified', ${t}, ${t}, ${t});`);
}
for (let i = 0; i < players; i++) {
  const tok = 'ld' + randomBytes(24).toString('hex');
  out.push(`INSERT OR IGNORE INTO users (id, email, name, pw_hash, created_at) VALUES ('u_ld${i}', 'ld${i}@example.com', 'Load ${i}', 'x', ${t});`);
  out.push(`INSERT OR REPLACE INTO sessions (id, user_id, created_at, expires_at, ua) VALUES ('${createHash('sha256').update(tok).digest('hex')}', 'u_ld${i}', ${t}, ${t + 2 * 86400_000}, 'load');`);
  toks.push(tok);
}
writeFileSync(new URL('./clock-tokens.json', import.meta.url), JSON.stringify(toks));
console.log(out.join('\n'));
