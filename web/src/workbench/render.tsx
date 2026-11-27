// Rendering what an agent writes: a small Markdown subset (built as React nodes, never as HTML, so nothing an agent
// writes can run on the page) and file diffs.
import { Fragment, type ReactNode } from 'react';
import { t } from '../lib';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function inline(s: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  // code first, then links, bold, italics
  const re = /(`+)([\s\S]*?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\n]+)\*(?!\w)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const k = key + '.' + n++;
    if (m[1]) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3]) out.push(SAFE_URL.test(m[4]) ? <a key={k} href={m[4]} target="_blank" rel="noreferrer noopener">{m[3]}</a> : <Fragment key={k}>{m[3]}</Fragment>);
    else if (m[5] || m[6]) out.push(<b key={k}>{inline(m[5] || m[6], k)}</b>);
    else if (m[7]) out.push(<em key={k}>{inline(m[7], k)}</em>);
    else if (m[8]) out.push(<a key={k} href={m[8]} target="_blank" rel="noreferrer noopener">{m[8]}</a>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** Markdown as agents write it: paragraphs, headings, lists, quotes, fenced code, tables kept as text. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const close = fence[1], body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="wb-pre" data-lang={fence[2] || undefined}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const L = Math.min(6, h[1].length + 2); const H = `h${L}` as 'h3'; blocks.push(<H key={k++} className="wb-h">{inline(h[2])}</H>); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { blocks.push(<hr key={k++} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={k++}><Markdown text={body.join('\n')} /></blockquote>);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (li.test(line)) {
      const ordered = /\d/.test(line.match(li)![2]);
      const items: string[][] = [];
      while (i < lines.length && (li.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(li);
        if (m && m[1].length < 2) items.push([m[3]]); else items[items.length - 1].push(lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, '• '));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={k++}>{items.map((it, j) => {
        const box = it[0].match(/^\[([ xX])\]\s+(.*)$/);
        return <li key={j} className={box ? 'task' : undefined}>{box ? <><span className={box[1] === ' ' ? 'box' : 'box on'} aria-hidden="true" />{inline(box[2])}</> : inline(it[0])}{it.slice(1).map((x, n) => <div key={n}>{inline(x)}</div>)}</li>;
      })}</L>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().slice(1, -1).split('|').map((c) => c.trim()));
      blocks.push(<div key={k++} className="wb-table"><table><tbody>{cells.map((r, j) => <tr key={j}>{r.map((c, n) => j === 0 ? <th key={n}>{inline(c)}</th> : <td key={n}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    blocks.push(<p key={k++}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, String(j))}</Fragment>)}</p>);
  }
  return <div className="wb-md">{blocks}</div>;
}

/** Lines that changed between two versions of a file (longest common subsequence; big files fall back to a block). */
export function diffLines(oldText: string | null, newText: string): { t: ' ' | '+' | '-'; s: string }[] {
  const a = oldText == null ? [] : oldText.split('\n'), b = newText.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  // trim the common start and end first: most edits touch a few lines of a long file
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length, eb = b.length; while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(start, ea), B = b.slice(start, eb), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const mid: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { mid.push({ t: ' ', s: A[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ t: '-', s: A[i++] }); else mid.push({ t: '+', s: B[j++] }); }
  while (i < n) mid.push({ t: '-', s: A[i++] });
  while (j < m) mid.push({ t: '+', s: B[j++] });
  return [...a.slice(0, start).map((s) => ({ t: ' ' as const, s })), ...mid, ...a.slice(ea).map((s) => ({ t: ' ' as const, s }))];
}

/** A diff with three lines of context around each change, the rest folded. */
export function Diff({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) {
  const lines = diffLines(oldText, newText);
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => { if (l.t !== ' ') for (let d = -3; d <= 3; d++) if (lines[i + d]) keep[i + d] = 1; });
  const add = lines.filter((l) => l.t === '+').length, del = lines.filter((l) => l.t === '-').length;
  const rows: ReactNode[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) { skipped++; return; }
    if (skipped) { rows.push(<div key={'s' + i} className="dl fold">⋯ {skipped}</div>); skipped = 0; }
    rows.push(<div key={i} className={`dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}`}><i aria-hidden="true">{l.t}</i>{l.s || ' '}</div>);
  });
  if (skipped) rows.push(<div key="end" className="dl fold">⋯ {skipped}</div>);
  return (
    <div className="wb-diff">
      <div className="wb-diff-h"><span className="mono clip">{path}</span>{oldText == null && <span className="badge good plain">{t('New file', '新文件')}</span>}<span className="good">+{add}</span><span className="bad">−{del}</span></div>
      <div className="wb-diff-b">{rows.length ? rows : <div className="dl fold">{t('No changes', '没有改动')}</div>}</div>
    </div>
  );
}
