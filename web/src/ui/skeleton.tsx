// Skeletons: the shape of a screen while its content is on the way. Every piece is a flat block with a slanted sheen
// passing over it (ui.css, .sk); with reduced motion the sheen stands still. Pages compose these into their own
// outline (../skeletons.tsx) so nothing jumps when the content arrives.
import type { CSSProperties, ReactNode } from 'react';
import { t } from '../lib';

type Size = number | string;
const px = (v?: Size) => (typeof v === 'number' ? v + 'px' : v);

/** One block. `kind` picks a ready shape; `w`/`h` override its size. */
export function Sk({ kind = 'line', w, h, className = '', style }: { kind?: 'line' | 'title' | 'big' | 'box' | 'art' | 'slab' | 'tag' | 'dot'; w?: Size; h?: Size; className?: string; style?: CSSProperties }) {
  return <span className={`sk sk-${kind} ${className}`} style={{ width: px(w), height: px(h), ...style }} aria-hidden="true" />;
}
/** A paragraph: lines of uneven length. */
export function SkText({ lines = 3, w = '100%' }: { lines?: number; w?: Size }) {
  return <span className="sk-text" style={{ width: px(w) }} aria-hidden="true">{Array.from({ length: lines }, (_, i) => <Sk key={i} w={i === lines - 1 ? '62%' : i % 2 ? '92%' : '100%'} />)}</span>;
}
/** The frame every skeleton sits in: announces "Loading" once and hides its blocks from screen readers. */
export function Skeleton({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={'skel ' + className} role="status" aria-busy="true" aria-label={t('Loading', '加载中')}>{children}</div>;
}

/** A page header: eyebrow, title, optional line under it. */
export function SkHeader({ sub, tabs }: { sub?: boolean; tabs?: number }) {
  return (
    <>
      <div className="page-h"><div className="stack s grow"><Sk kind="tag" w={90} /><Sk kind="big" w="min(420px, 70%)" />{sub && <Sk w="min(520px, 90%)" />}</div></div>
      {!!tabs && <div className="tabs sk-tabs">{Array.from({ length: tabs }, (_, i) => <Sk key={i} kind="slab" w={104} h={36} />)}</div>}
    </>
  );
}
/** A strip of figures, like StatGrid. */
export function SkStats({ n = 4 }: { n?: number }) {
  return <div className="stats">{Array.from({ length: n }, (_, i) => <div key={i} className="stat sk-stat"><Sk kind="tag" w={78} /><Sk kind="title" w={96} h={34} /><Sk w="70%" /></div>)}</div>;
}
/** A panel with a title bar, like Card. */
export function SkCard({ children, lines = 4, h }: { children?: ReactNode; lines?: number; h?: Size }) {
  return <section className="card"><header><Sk kind="title" w={150} h={16} /></header><div className="pad">{children || (h ? <Sk kind="box" h={h} /> : <SkText lines={lines} />)}</div></section>;
}
/** Rows with a thumbnail, a title and a tail, like ListRow. */
export function SkRows({ n = 5, thumb = true }: { n?: number; thumb?: boolean }) {
  return <>{Array.from({ length: n }, (_, i) => <div key={i} className="list-row">{thumb && <Sk kind="art" className="thumb" />}<div className="list-main"><Sk kind="title" w={`${34 + (i * 13) % 30}%`} h={15} /><Sk w={`${44 + (i * 7) % 24}%`} /></div><Sk w={64} /></div>)}</>;
}
/** A table: a head and rows of cells. */
export function SkTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="tbl-wrap"><table className="tbl"><tbody>
      {Array.from({ length: rows + 1 }, (_, r) => <tr key={r}>{Array.from({ length: cols }, (_, c) => <td key={c}><Sk kind={r ? 'line' : 'tag'} w={c ? `${46 + ((r + c) * 17) % 40}%` : `${60 + (r * 11) % 30}%`} /></td>)}</tr>)}
    </tbody></table></div>
  );
}
/** A chart: bars of uneven height. */
export function SkBars({ n = 30 }: { n?: number }) {
  return <div className="bars sk-bars" aria-hidden="true">{Array.from({ length: n }, (_, i) => <div key={i} className="sk" style={{ height: `${28 + ((i * 37) % 60)}%` }} />)}</div>;
}
