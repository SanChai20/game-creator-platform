#!/usr/bin/env node
// Refreshes the workbench's copy of the official ACP Registry (https://github.com/agentclientprotocol/registry), the
// list of agents Zed and JetBrains offer. The workbench supports exactly these agents; the site also serves the live
// registry (/acp/registry.json), so this snapshot is what the bridge and the page fall back to when it cannot be read.
//
//   node scripts/acp-registry.mjs                      from the published index (cdn.agentclientprotocol.com)
//   node scripts/acp-registry.mjs --from <clone>       from a clone of the registry repository (same rules as its build)
//
// Writes acp-bridge/registry.json (what the bridge launches), web/src/workbench/registry.json (what the page lists)
// and web/public/acp-icons/<id>.svg (the agents' monochrome icons).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const BASE = 'https://cdn.agentclientprotocol.com/registry/v1/latest';
// the registry's own build leaves these out of registry.json (github-copilot is the older entry; github-copilot-cli
// is the one listed)
const EXCLUDE = new Set(['github-copilot']);

const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null;
let agents, icons = new Map();
if (from) {
  agents = [];
  for (const dir of readdirSync(from).sort()) {
    const file = join(from, dir, 'agent.json');
    if (dir.startsWith('.') || !existsSync(file) || EXCLUDE.has(dir)) continue;
    const a = JSON.parse(readFileSync(file, 'utf8'));
    delete a.preview;   // never in the published registry
    a.icon = `${BASE}/${a.id}.svg`;
    agents.push(a);
    const icon = join(from, dir, 'icon.svg');
    if (existsSync(icon)) icons.set(a.id, readFileSync(icon, 'utf8'));
  }
} else {
  const r = await fetch(INDEX);
  if (!r.ok) throw new Error(`${INDEX}: ${r.status}`);
  agents = (await r.json()).agents.filter((a) => !EXCLUDE.has(a.id) && !/\(legacy ID\)$/.test(a.name));
  for (const a of agents) { const i = await fetch(a.icon).catch(() => null); if (i?.ok) icons.set(a.id, await i.text()); }
}
agents.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
const at = new Date().toISOString().slice(0, 10);

writeFileSync(join(root, 'acp-bridge/registry.json'), JSON.stringify({ source: INDEX, snapshot: at, agents }, null, 1) + '\n');
// the page needs what Zed shows, and how each one starts (to say what it needs), not the download addresses
const kinds = (d) => ({ ...(d.npx ? { npx: d.npx.package } : {}), ...(d.uvx ? { uvx: d.uvx.package } : {}), ...(d.binary ? { binary: Object.keys(d.binary).sort() } : {}) });
const slim = agents.map((a) => ({ id: a.id, name: a.name, version: a.version, description: a.description, repository: a.repository || null, website: a.website || null, license: a.license_url || null, authors: a.authors || [], dist: kinds(a.distribution || {}) }));
mkdirSync(join(root, 'web/src/workbench'), { recursive: true });
writeFileSync(join(root, 'web/src/workbench/registry.json'), JSON.stringify({ snapshot: at, agents: slim }) + '\n');
const iconDir = join(root, 'web/public/acp-icons');
rmSync(iconDir, { recursive: true, force: true }); mkdirSync(iconDir, { recursive: true });
for (let [id, svg] of icons) {
  svg = svg.slice(Math.max(0, svg.indexOf('<svg')));   // an XML declaration or doctype before it is dropped
  if (/^[a-z0-9-]+$/.test(id) && /^<svg[\s>]/.test(svg) && !/<script|\son\w+\s*=/i.test(svg)) writeFileSync(join(iconDir, id + '.svg'), svg.trim() + '\n');
}
console.log(`${agents.length} agents (${icons.size} icons), snapshot ${at}`);
