// Build skills: what a game shares through Open Implementation. A skill is an agent skill (a SKILL.md) that the game's own
// development agent writes about how the game is built, so another developer's agent can build something similar. It
// carries the game's practices, never its source: fenced or indented code, HTML tags, code-dense lines and long inline
// code are refused with the line they are on, so the agent can rewrite them as prose. Plain JavaScript so node tests can
// import it directly; the Worker side is src/skills.ts.

export const SKILL_LIMITS = { min_chars: 600, max_chars: 60000, description_max: 300, min_sections: 3, inline_code_max: 60 };

/** The sections an agent is asked to cover. Only three level-two headings are required; these are the suggestion. */
export const SKILL_OUTLINE = [
  { heading: 'What you are building', ask: 'The kind of game, its core loop in a few sentences, what makes it feel good, and the scope a first playable version needs.' },
  { heading: 'Architecture', ask: 'How the game is put together: engine or none, modules and what each one owns, how state flows between simulation, rendering and interface, and in what order to build them.' },
  { heading: 'Rendering and art', ask: 'How things are drawn (renderer, camera, lighting, materials, effects), how art is made (procedural or files), and the choices that gave the look.' },
  { heading: 'Game loop and feel', ask: 'Timing (fixed step or delta time), movement and physics, juice (screen shake, hit pause, particles), and the numbers that were tuned and why.' },
  { heading: 'Controls and devices', ask: 'Keyboard, mouse, touch and gamepad handling, phones and tablets, interface scaling and orientation.' },
  { heading: 'Content and progression', ask: 'Levels, waves, unlocks, balance, difficulty curve, saves and what the player keeps between sessions.' },
  { heading: 'Platform services', ask: 'Which platform services the game uses (saves, leaderboards, rooms, matches, server code) and how, by name, not by code.' },
  { heading: 'Performance', ask: 'Budgets and the techniques that kept frame time inside them on phones.' },
  { heading: 'Testing and release', ask: 'The play-through hook, what verification checks, how a release is prepared, and what to check by hand.' },
  { heading: 'Pitfalls', ask: 'What went wrong while building it and how it was solved, so another agent avoids it.' },
];

const CODE_START = /^\s*(?:const|let|var|function|import|export|class|return|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|async\s+function|def |#include|public |private |@media|\$\(|document\.|window\.[\w.]+\s*=)/;
const TAG = /<\/?(?:script|style|div|span|canvas|html|head|body|template|svg|path|iframe|link|meta|button|input|section|p|a|img|ul|li|table|tr|td|br|hr|h[1-6])\b[^>]*>/i;

/** Splits off a leading YAML front matter block; its description (if any) is kept. */
export function splitFrontMatter(text) {
  const m = String(text || '').replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: String(text || ''), description: '' };
  const d = m[1].match(/^description:\s*(.+)$/m);
  return { body: String(text).slice(m[0].length), description: d ? d[1].trim().replace(/^["']|["']$/g, '') : '' };
}

/** Cleans what an agent sent: front matter and a leading level-one title come off (the platform writes both). */
export function normalizeSkill(text, description = '') {
  const fm = splitFrontMatter(String(text || '').replace(/\r\n?/g, '\n'));
  let body = fm.body.replace(/^\s*#\s+[^\n]*\n/, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const desc = String(description || fm.description || '').replace(/\s+/g, ' ').trim().slice(0, SKILL_LIMITS.description_max);
  return { body, description: desc };
}

/** Level-two headings, in order: the outline a paid skill shows before it is bought. */
export const headingsOf = (body) => [...String(body || '').matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1].trim()).slice(0, 40);

/**
 * Checks a skill body. Returns { ok, problems } where each problem names the line and why it was refused. Code of any
 * kind is refused; names of APIs and platform calls in short inline code (`GCP.ready()`) are fine.
 */
export function checkSkill(body) {
  const problems = [], text = String(body || '');
  const add = (line, why) => { if (problems.length < 25) problems.push({ line, why }); };
  if (text.length < SKILL_LIMITS.min_chars) add(0, `The skill is ${text.length} characters; write at least ${SKILL_LIMITS.min_chars} so it is useful to another agent.`);
  if (text.length > SKILL_LIMITS.max_chars) add(0, `The skill is ${text.length} characters; the most is ${SKILL_LIMITS.max_chars}.`);
  const lines = text.split('\n');
  let prevBlank = true;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(l)) add(n, 'Code blocks are not allowed in a build skill. Describe the technique in words.');
    else if (prevBlank && /^(?: {4}|\t)\S/.test(l) && !/^\s*[-*+]\s|^\s*\d+[.)]\s/.test(l)) add(n, 'Indented lines read as a code block. Remove the indent or describe it in words.');
    else if (CODE_START.test(l.replace(/^\s*[-*+]\s+/, ''))) add(n, 'This line looks like source code. Describe what it does instead.');
    else if (TAG.test(l.replace(/`[^`]*`/g, ''))) add(n, 'HTML tags are not allowed. Name the element in words.');
    else {
      const plain = l.replace(/`[^`]*`/g, ' ');
      const sym = (plain.match(/[{}();=<>[\]]/g) || []).length;
      if (sym >= 8 && sym / Math.max(1, plain.length) > 0.06) add(n, 'This line is dense with code punctuation. Write it as prose.');
      for (const m of l.matchAll(/`([^`\n]*)`/g)) {
        const c = m[1];
        if (c.length > SKILL_LIMITS.inline_code_max) add(n, `Inline code is for names only (at most ${SKILL_LIMITS.inline_code_max} characters).`);
        else if (/[{};]|=>|\b(?:const|let|var|function|return)\b|[^=!<>]=[^=]/.test(c)) add(n, 'Inline code may name an API or a value, not hold a statement.');
      }
    }
    prevBlank = !l.trim();
  });
  if (headingsOf(text).length < SKILL_LIMITS.min_sections) add(0, `Organise the skill under at least ${SKILL_LIMITS.min_sections} level-two headings (## …). Suggested: ${SKILL_OUTLINE.map((s) => s.heading).join(', ')}.`);
  return { ok: !problems.length, problems };
}

/** A skill name in the form agent tools accept: lower-case words and hyphens, at most 64 characters. */
export function skillName(slug) {
  const s = String(slug || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ('build-like-' + s).slice(0, 64).replace(/-+$/, '');
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();

/**
 * The SKILL.md another agent drops into its skills folder: front matter (name, description), a title, where it comes
 * from, the creator's body, and the facts the platform measured from the live build. What Copy skill copies.
 */
export function skillMarkdown({ title, slug, by, version, description, body, origin, facts }) {
  const desc = oneLine(description) || `How ${oneLine(title)} was built, from its own development agent.`;
  const out = [
    '---',
    `name: ${skillName(slug)}`,
    `description: "Use when building a game like ${oneLine(title)}. ${desc}"`,
    '---',
    '',
    `# Building a game like ${oneLine(title)}`,
    '',
    `This skill was written by the development agent of [${oneLine(title)}](${origin}/g/${slug})${by ? ` by ${oneLine(by)}` : ''} and matches version ${version} of the live game. It holds the game's practices, not its code: the platform never shares source code. Following it does not guarantee the same result; it captures what worked for this game.`,
    '',
    String(body || '').trim(),
  ];
  const f = facts && typeof facts === 'object' ? facts : null;
  if (f) {
    const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : null);
    const rows = [
      ['Engine', f.engine], ['Rendering', list(f.rendering)], ['Graphics', list(f.graphics)], ['Input', list(f.input)], ['Audio', list(f.audio)],
      ['Art', f.assets && f.assets.approach], ['Platform services', list(f.platform_services)], ['Loop and performance', list(f.loop_and_performance)],
      ['Size', f.structure ? `${f.structure.files} files, about ${f.structure.own_code_lines} lines of the game's own code, ${f.structure.modules}` : null],
    ].filter(([, v]) => v);
    if (rows.length) out.push('', '## Measured by the platform', '', `Facts the platform read from the build of version ${version}, not written by the creator:`, '', ...rows.map(([k, v]) => `- ${k}: ${v}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/**
 * A stand-in for a game that shares its implementation but whose agent has not written a skill yet: the platform's own
 * card (facts and summary) arranged as a skill. Marked as written by the platform.
 */
export function fallbackSkill(listing, facts, summary) {
  const f = facts || {}, list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : 'not detected');
  const parts = [
    '## What you are building', '', String(summary || listing.tagline || listing.title || '').trim(), '',
    '## Architecture', '',
    `- Engine: ${f.engine || 'not detected'}${f.libraries && f.libraries.length ? `, with ${f.libraries.join(', ')}` : ''}.`,
    f.structure ? `- Structure: ${f.structure.files} files written as ${f.structure.modules}, about ${f.structure.own_code_lines} lines of the game's own code${f.structure.server_code ? ', plus server code on the platform' : ''}.` : '- Structure: not measured.',
    '', '## Rendering and art', '', `- Rendering: ${list(f.rendering)}.`, `- Graphics: ${list(f.graphics)}.`, `- Art: ${(f.assets && f.assets.approach) || 'not measured'}.`,
    '', '## Controls and sound', '', `- Input: ${list(f.input)}.`, `- Audio: ${list(f.audio)}.`,
    '', '## Platform services and performance', '', `- Platform services: ${list(f.platform_services)}.`, `- Loop and performance: ${list(f.loop_and_performance)}.`,
  ];
  if (f.gameplay && f.gameplay.playthrough_steps && f.gameplay.playthrough_steps.length) parts.push('', '## Testing and release', '', `The verified play-through goes: ${f.gameplay.playthrough_steps.join(', then ')}.`);
  return parts.join('\n');
}
