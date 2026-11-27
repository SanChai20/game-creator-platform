// The MCP introduces itself: an agent that connects cold learns every tool and what it is for from the server
// instructions and get_started, and every guide or template it is pointed at opens through MCP, with no outside docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { TOOL_GROUPS, SCOPE, TESTING, toolLines, toolMap } = await import('../src/mcp/overview.ts');
const { STANDARDS, renderStandards } = await import('../src/standards.js');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tools = read('src/mcp/tools.ts') + read('src/mcp/collab-tools.ts'), server = read('src/mcp/server.ts');
const names = [...tools.matchAll(/^    name: '([a-z_]+)', title:/gm)].map((m) => m[1]);
const guides = [...tools.matchAll(/\{ topic: '([\w-]+)', file: '([\w-]+)'/g)].map((m) => ({ topic: m[1], file: m[2] }));
const SERVED = ['platform-contract', 'game-metadata', 'troubleshooting', 'saves', 'multiplayer', 'matches', 'test-bots', 'storage', 'input', 'standards', 'services', 'testing'];

test('every tool is introduced once, in one group, with what it is for', () => {
  assert.ok(names.length >= 27, `found ${names.length} tools`);
  const listed = TOOL_GROUPS.flatMap((g) => g.tools.map(([n]) => n));
  assert.deepEqual([...listed].sort(), [...names].sort(), 'TOOL_GROUPS and TOOLS hold the same tools');
  assert.equal(new Set(listed).size, listed.length, 'no tool is listed twice');
  for (const g of TOOL_GROUPS) for (const [n, what] of g.tools) assert.ok(what.length > 20, `${n} says what it is for`);
  const lines = toolLines();
  for (const n of names) assert.match(lines, new RegExp(`^- ${n}: `, 'm'), n);
  assert.equal(Object.values(toolMap()).reduce((k, g) => k + Object.keys(g.tools).length, 0), names.length);
});

test('the server instructions carry the scope, the tool map and the testing loop', () => {
  assert.match(server, /export const INSTRUCTIONS = `\$\{WEB_ONLY\}/);
  for (const k of ['SCOPE.covers', 'SCOPE.yours', 'SCOPE.self_contained', 'toolLines()']) assert.ok(server.includes('${' + k + '}'), k);
  assert.match(server, /get_started \{topic: "testing"\}/);
  assert.match(SCOPE.yours, /design is yours and the creator's/);
  assert.match(SCOPE.yours, /neither prescribes nor scores/);
  assert.match(SCOPE.yours, /only the player's experience/);
  assert.match(SCOPE.self_contained, /No outside documentation is needed/);
  for (const t of ['debug_preview', 'creator_feedback', 'preview_bots', 'dry_run', 'get_stats']) assert.ok(TESTING.some((l) => l.includes(t)), t);
  // get_started hands the same map over, for clients that drop server instructions
  assert.match(tools, /tools: toolMap\(\),/);
  assert.match(tools, /testing_and_feedback: \{ loop: TESTING/);
});

test('the testing guide is served and names every testing tool', () => {
  assert.ok(guides.some((g) => g.topic === 'testing' && g.file === 'testing'));
  const md = read('web/public/guides/testing.md');
  for (const t of ['deploy_preview', 'list_versions', 'debug_preview', 'creator_feedback', 'preview_bots', 'game_standards', 'publish', 'get_stats', 'onPlaythrough', 'onState', 'onCapture', 'zoom', 'png']) assert.ok(md.includes(t), t);
  assert.doesNotMatch(md, /genre is required|must be a/i);
});

test('every guide a served guide or a standard points to opens through MCP', () => {
  const files = new Set(guides.map((g) => g.file));
  for (const s of STANDARDS) if (s.guide) {
    const f = s.guide.match(/^\/guides\/([\w-]+)\.md/)?.[1];
    assert.ok(f && files.has(f), `${s.id}: ${s.guide} is not a guide this server serves`);
  }
  for (const f of SERVED) assert.ok(existsSync(new URL(`../web/public/guides/${f}.md`, import.meta.url)), f);
  // the older authoring guides stay on the web for existing games, but a served guide never sends an agent there
  const authoring = ['performance', 'rendering-pipelines', 'procedural-generation', 'meshes', 'materials-textures', 'animation', 'audio', 'building-blocks', 'realistic-materials', 'loading'];
  for (const f of SERVED) {
    // the standards guide is rendered with the origin when served through MCP (get_started {topic: "standards"})
    const md = f === 'standards' ? renderStandards('https://example.test') : read(`web/public/guides/${f}.md`);
    for (const a of authoring) assert.doesNotMatch(md, new RegExp(`/guides/${a}\\b|the ${a} guide|see ${a}\\b`), `${f}.md points at the ${a} authoring guide`);
    assert.doesNotMatch(md, /\]\(\/guides\//, `${f}.md has a relative /guides/ link an MCP agent cannot open`);
  }
});

test('template images are MCP resources', () => {
  assert.match(tools, /name: 'cover', path: '\/guides\/cover-template\.png'/);
  assert.match(tools, /name: 'safe-area', path: '\/guides\/safe-area-template\.png'/);
  assert.match(server, /gcp:\/\/templates\//);
  assert.match(server, /mimeType: 'image\/png', blob: b64/);
  for (const p of ['cover-template.png', 'safe-area-template.png']) assert.ok(existsSync(new URL(`../web/public/guides/${p}`, import.meta.url)), p);
});
