// The component kit. Pages compose these instead of writing their own markup and inline styles, so a change
// to how a button, card, stat or table looks is made once, here and in ui.css.
import { useEffect, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link, t } from '../lib';

const cx = (...c: (string | false | null | undefined | 0)[]) => c.filter(Boolean).join(' ');

// ---- actions ----------------------------------------------------------------------------------
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';
type ButtonOwn = { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; icon?: ReactNode; className?: string; children?: ReactNode };
const btnClass = ({ variant = 'secondary', size = 'md', block, className }: ButtonOwn) => cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', className);

/** A button. Pass `to` for an in-app link or `href` for a plain link that looks like a button. */
export function Button({ variant, size, block, icon, className, children, to, href, target, ...rest }: ButtonOwn & ButtonHTMLAttributes<HTMLButtonElement> & { to?: string; href?: string; target?: string }) {
  const cls = btnClass({ variant, size, block, className }), inner = <>{icon}{children}</>;
  if (to) return <Link to={to} className={cls} onClick={rest.onClick as (() => void) | undefined}>{inner}</Link>;
  if (href) return <a href={href} className={cls} target={target} rel={target ? 'noreferrer' : undefined}>{inner}</a>;
  return <button className={cls} {...rest}>{inner}</button>;
}

/** The big round call to action that sits on a game's poster. */
export function PlayButton({ buy, children, ...rest }: { buy?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cx('play-btn', buy && 'buy')} {...rest}>{!buy && <span className="play-ico" aria-hidden="true" />}{children}</button>;
}

// ---- text -------------------------------------------------------------------------------------
export const Eyebrow = ({ children, tone, className }: { children: ReactNode; tone?: 'accent'; className?: string }) => <span className={cx('eyebrow', tone === 'accent' && 'sig', className)}>{children}</span>;

export type Tone = 'neutral' | 'good' | 'bad' | 'accent' | 'info';
const toneClass = (tone?: Tone) => (tone === 'accent' ? 'sig' : tone && tone !== 'neutral' ? tone : '');

/** A small status label. `dot` adds the coloured dot in front. */
export const Badge = ({ tone, dot = true, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) =>
  <span className={cx('badge', toneClass(tone), !dot && 'plain', className)}>{children}</span>;

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [Tone, string]> = {
    live: ['good', t('Live', '已上线')], draft: ['neutral', t('Draft', '草稿')], offline: ['accent', t('Offline', '已下线')], removed: ['bad', t('Removed', '已移除')],
    verified: ['good', t('Verified', '已验证')], failed: ['bad', t('Failed', '未通过')], queued: ['info', t('Queued', '排队中')], deploying: ['info', t('Deploying', '部署中')], verifying: ['info', t('Verifying', '验证中')],
    paid: ['good', t('Paid', '已支付')], pending: ['accent', t('Pending', '处理中')], rejected: ['bad', t('Rejected', '已拒绝')], refunded: ['neutral', t('Refunded', '已退款')],
    active: ['good', t('Active', '正常')], suspended: ['bad', t('Suspended', '已停用')],
  };
  const [tone, label] = map[status] || ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
}

// ---- layout -----------------------------------------------------------------------------------
/** The trail above a page title. The last item is the current page and is not a link. */
export function Crumbs({ items }: { items: ({ to: string; label: ReactNode } | ReactNode)[] }) {
  return (
    <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}>
      {items.map((it, i) => <span key={i} className="row s">{i > 0 && <i aria-hidden="true">/</i>}{it && typeof it === 'object' && 'to' in (it as object) ? <Link to={(it as { to: string }).to}>{(it as { label: ReactNode }).label}</Link> : <span>{it as ReactNode}</span>}</span>)}
    </nav>
  );
}

/** The top of a page: a breadcrumb (or eyebrow), the title, an optional line under it, actions on the right. */
export function PageHeader({ eyebrow, back, title, sub, actions, badge }: { eyebrow?: ReactNode; back?: { to: string; label: string }; title: ReactNode; sub?: ReactNode; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <header className="page-h">
      <div className="stack s grow">
        {back ? <Crumbs items={[{ to: back.to, label: back.label }, ...(eyebrow ? [eyebrow] : [])]} /> : eyebrow && <Eyebrow tone="accent">{eyebrow}</Eyebrow>}
        <div className="row wrapx"><h1>{title}</h1>{badge}</div>
        {sub && <p className="mute page-sub">{sub}</p>}
      </div>
      {actions && <div className="row wrapx page-actions">{actions}</div>}
    </header>
  );
}

/** A titled block of a page. */
export function Section({ title, sub, actions, children, id, className }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section className={cx('stack l', className)} id={id}>
      <div className="section-h"><div className="grow"><h2>{title}</h2>{sub && <p>{sub}</p>}</div>{actions && <div className="right row">{actions}</div>}</div>
      {children}
    </section>
  );
}

/** A surface. With `title` it gets a header row; `pad` pads the body (leave it off for lists and tables that run edge to edge). */
export function Card({ title, aside, actions, pad, children, className, style, tone }: { title?: ReactNode; aside?: ReactNode; actions?: ReactNode; pad?: boolean; children?: ReactNode; className?: string; style?: CSSProperties; tone?: 'accent' }) {
  return (
    <div className={cx('card', tone === 'accent' && 'card-accent', className)} style={style}>
      {(title || actions || aside) && <header>{title && <h3>{title}</h3>}{aside && <span className="card-aside">{aside}</span>}{actions && <div className="row right">{actions}</div>}</header>}
      {pad ? <div className="pad stack">{children}</div> : children}
    </div>
  );
}

/** A row in a card list: thumbnail or icon, title and meta, and a tail on the right. A link when `to` is given. */
export function ListRow({ to, media, title, meta, tail, className }: { to?: string; media?: ReactNode; title: ReactNode; meta?: ReactNode; tail?: ReactNode; className?: string }) {
  const body = <>{media}<div className="list-main"><div className="row list-title">{title}</div>{meta && <div className="list-meta">{meta}</div>}</div>{tail && <div className="list-tail">{tail}</div>}</>;
  const cls = cx('list-row', !media && 'no-media', className);
  return to ? <Link to={to} className={cls + ' is-link'}>{body}</Link> : <div className={cls}>{body}</div>;
}

// ---- data -------------------------------------------------------------------------------------
/** One figure with a label and a line of context. Put several in a StatGrid. */
export function Stat({ label, value, sub, tone, to }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'accent'; to?: string }) {
  const body = <><b className="stat-v">{value}</b><span className="stat-l">{label}</span>{sub && <small>{sub}</small>}</>;
  return to ? <Link to={to} className={cx('stat', 'is-link', tone && 'stat-accent')}>{body}</Link> : <div className={cx('stat', tone && 'stat-accent')}>{body}</div>;
}
export const StatGrid = ({ children }: { children: ReactNode }) => <div className="stats">{children}</div>;

/** Label and value pairs. */
export const KeyValue = ({ items }: { items: ([ReactNode, ReactNode] | [ReactNode, ReactNode, string] | false | null | undefined)[] }) => (
  <dl className="kv">{items.filter(Boolean).map((it, i) => { const [k, v, cls] = it as [ReactNode, ReactNode, string?]; return <div key={i}><dt>{k}</dt><dd className={cls}>{v}</dd></div>; })}</dl>
);

/** A table that scrolls sideways on narrow screens. Use className="n" on numeric cells. */
export const Table = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cx('tbl-wrap', className)}><table className="tbl">{children}</table></div>;

/** A bar per value, newest on the right, with the value on hover. Used for daily series. */
export function Bars({ data, tip, height }: { data: { label: string; value: number }[]; tip: (d: { label: string; value: number }) => string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="bars" style={height ? { height } : undefined} role="img" aria-label={data.length ? `${tip(data[0])} … ${tip(data[data.length - 1])}` : ''}>
      {data.map((d) => <div key={d.label} data-tip={tip(d)} className={d.value ? '' : 'zero'} style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }} />)}
    </div>
  );
}

/** Horizontal bars for parts of a whole (devices, browsers, session lengths): name, bar and value on one line. */
export function Share({ items }: { items: { name: ReactNode; value: number; note?: ReactNode }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return <div className="share">{items.map((i, k) => <div className="share-row" key={k}><span className="clip">{i.name}</span><div className="share-bar"><i style={{ width: `${Math.max(i.value ? 2 : 0, (i.value / max) * 100)}%` }} /></div><span className="num">{i.note ?? i.value}</span></div>)}</div>;
}

/** A chart with its title and the headline number. */
export function ChartBlock({ label, value, children }: { label: ReactNode; value?: ReactNode; children: ReactNode }) {
  return <div className="chart-block"><div className="row"><Eyebrow>{label}</Eyebrow>{value != null && <b className="right num chart-v">{value}</b>}</div>{children}</div>;
}

/** Pass/fail line used by verification reports and system health. */
export function CheckRow({ ok, title, detail, hint }: { ok: boolean; title: ReactNode; detail?: ReactNode; hint?: ReactNode }) {
  return <div className="check"><i className={ok ? 'ok' : 'no'} aria-label={ok ? 'ok' : 'failed'}>{ok ? '✓' : '×'}</i><div><b>{title}</b>{detail && <div className="mute fs-sm">{detail}</div>}{hint && <div className="sig fs-sm" style={{ marginTop: 4 }}>{hint}</div>}</div></div>;
}

// ---- feedback ---------------------------------------------------------------------------------
export function Notice({ tone = 'accent', title, children, actions, role }: { tone?: 'accent' | 'bad' | 'good' | 'info'; title?: ReactNode; children?: ReactNode; actions?: ReactNode; role?: string }) {
  return (
    <div className={cx('notice', tone !== 'accent' && tone)} role={role}>
      <div className="grow">{title && <b className="notice-t">{title}</b>}{children && <div className={title ? 'mute' : ''}>{children}</div>}</div>
      {actions && <div className="row wrapx notice-a">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action, compact }: { title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return <div className={cx('empty', compact && 'compact')}><div className="empty-ico" aria-hidden="true" /><h3>{title}</h3>{children && <p>{children}</p>}{action && <div className="empty-a">{action}</div>}</div>;
}

export const Spinner = () => <div className="spinner" role="status" aria-label={t('Loading', '加载中')} />;

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" className={wide ? 'wide' : ''}>{children}</div></div>;
}

export function Code({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }); };
  return <div className="code">{text}<button className={cx('btn btn-secondary btn-sm copy', done && 'done')} onClick={copy}>{done ? t('Copied', '已复制') : t('Copy', '复制')}</button></div>;
}

// ---- forms ------------------------------------------------------------------------------------
export const Field = ({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) =>
  <label className="field"><span>{label}</span>{children}{hint && <small className="field-hint">{hint}</small>}</label>;
export const Input = ({ className, mono, ...p }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) => <input className={cx('input', mono && 'mono', className)} {...p} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cx('input', className)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cx('input', className)} {...p} />;
export const Switch = (p: InputHTMLAttributes<HTMLInputElement>) => <input type="checkbox" className="switch" {...p} />;
/** A search box with its icon. */
export const SearchInput = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <label className={cx('search', className)}><input className="input" type="search" {...p} /></label>;

/** A row of mutually exclusive options. */
export function Segmented<T extends string>({ options, value, onChange, wrap, label }: { options: [T, ReactNode][]; value: T; onChange: (v: T) => void; wrap?: boolean; label?: string }) {
  return <div className={cx('seg', wrap && 'wrapx')} role="tablist" aria-label={label}>{options.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

/** Page-level navigation between sibling views (console tabs, admin tabs). */
export function Tabs({ items, active }: { items: { key: string; to: string; label: ReactNode }[]; active: string }) {
  return <nav className="tabs">{items.map((i) => <Link key={i.key} to={i.to} className={active === i.key ? 'on' : ''}>{i.label}</Link>)}</nav>;
}

export function Chip({ active, onClick, to, children }: { active?: boolean; onClick?: () => void; to?: string; children: ReactNode }) {
  return to ? <Link to={to} className={cx('chip', active && 'on')}>{children}</Link> : <button type="button" className={cx('chip', active && 'on')} onClick={onClick}>{children}</button>;
}

/** A numbered list of steps. */
export const Steps = ({ items }: { items: ReactNode[] }) => <ol className="steps">{items.map((s, i) => <li key={i}><span>{s}</span></li>)}</ol>;
/** A list with accent dots. */
export const Ticks = ({ items }: { items: ReactNode[] }) => <ul className="ticks">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>;
