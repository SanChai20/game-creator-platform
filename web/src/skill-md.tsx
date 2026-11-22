// A small Markdown reader for build skills (the Creator Store): headings, paragraphs, lists, bold, italics, inline code
// and links. It builds React elements, never HTML from the text, so nothing a creator writes can run on the page.
import { Fragment, type ReactNode } from 'react';

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|\*\*([^*]+)\*\*|(?<![\w*])[*_]([^*_\n]+)[*_](?![\w*])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<b key={k}>{m[2]}</b>);
    else if (m[3]) out.push(<i key={k}>{m[3]}</i>);
    else if (m[4]) out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer nofollow">{m[4]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const headingId = (h: string) => 'sk-' + h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

/** Renders a skill body. Front matter is dropped; the level-one title is left to the page. */
export function SkillMarkdown({ text }: { text: string }) {
  const lines = String(text || '').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [], list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join(' '), blocks.length)}</p>); para = []; }
    if (list) { const L = list.ordered ? 'ol' : 'ul', items = list.items; blocks.push(<L key={blocks.length}>{items.map((it, j) => <li key={j}>{inline(it, j)}</li>)}</L>); list = null; }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!l.trim()) { flush(); continue; }
    if ((m = l.match(/^(#{1,4})\s+(.+?)\s*#*$/))) {
      flush();
      const level = m[1].length, h = m[2];
      if (level === 1) continue;
      blocks.push(level === 2 ? <h2 key={blocks.length} id={headingId(h)}>{inline(h)}</h2> : <h3 key={blocks.length}>{inline(h)}</h3>);
      continue;
    }
    if ((m = l.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/))) {
      const ordered = !!m[2];
      if (para.length || (list && list.ordered !== ordered)) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push(m[3]);
      continue;
    }
    if (/^>\s?/.test(l)) { flush(); blocks.push(<blockquote key={blocks.length}>{inline(l.replace(/^>\s?/, ''))}</blockquote>); continue; }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ' ' + l.trim(); continue; }
    if (list) flush();
    para.push(l.trim());
  }
  flush();
  return <div className="skill-md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
