# Load testing against a local copy

Never point these at production. They run against `wrangler dev` with a local D1 database seeded to platform size.

```sh
npm run build
# a config without the bindings that need a Cloudflare login (Browser Rendering, Workers AI, Email) or routes
node -e 'const fs=require("fs");let t=fs.readFileSync("wrangler.jsonc","utf8");t=t.replace(/^\s*"(browser|ai|send_email)":.*$/gm,"").replace(/"routes": \[[\s\S]*?\],/,"");fs.writeFileSync("wrangler.loadtest.jsonc",t)'
echo PUBLIC_ORIGIN=http://127.0.0.1:8787 >> .dev.vars          # plus the README's .dev.vars
npx wrangler d1 migrations apply gcp-db --local -c wrangler.loadtest.jsonc
DB=$(ls .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata)
node scripts/load/seed.mjs "$DB" .          # 20k users, 40k games, 1M plays, 150k sales (USERS=, PROJECTS=, PLAYS= to change)
node scripts/load/sessions.mjs "$DB"        # signed-in players for players.mjs
npx wrangler dev -c wrangler.loadtest.jsonc --port 8787 &
node scripts/load/hit.mjs 1 5 '/api/games?sort=top&facets=0&x=$R'   # concurrency, seconds, paths ($R: a random number, a cache miss)
node scripts/load/players.mjs 100 30        # 100 players: play start, check-ins, heartbeats, saves, stats, scores
```

`wrangler dev` runs the Worker and D1 in one local process, so absolute throughput is far below production; compare the
time one request costs (cold, with `$R` in the address so the edge cache misses) and look for errors under concurrency.
D1 runs each database's queries one at a time, so the database time per request is what limits the platform.
