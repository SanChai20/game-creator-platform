// The outline of each page while it loads, built from the skeleton pieces in ui/skeleton.tsx and the same layout
// classes the real page uses, so the content lands where its outline was.
import { Sk, SkBars, SkCard, Skeleton, SkHeader, SkRows, SkStats, SkTable, SkText } from './ui/skeleton';

const times = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A game card. */
export const SkGame = () => (
  <div className="game sk-game" aria-hidden="true">
    <Sk kind="art" />
    <div className="game-b"><Sk kind="title" w="62%" h={17} /><Sk kind="tag" w={58} /><div className="meta"><Sk w={64} /><Sk w={52} /><Sk w={44} style={{ marginLeft: 'auto' }} /></div></div>
  </div>
);
/** A grid of game cards (catalogue, search results). */
export const SkGrid = ({ n = 12, className = 'grid browse-grid' }: { n?: number; className?: string }) => <Skeleton className={className}>{times(n).map((i) => <SkGame key={i} />)}</Skeleton>;
/** A section head and a row of game cards. */
export const SkShelf = ({ n = 5, bare }: { n?: number; bare?: boolean }) => {
  const body = <><div className="sh"><div className="grow"><Sk kind="big" w="min(320px, 60%)" h={34} /></div><Sk kind="slab" w={104} h={36} /></div><div className="shelf-row sk-shelf">{times(n).map((i) => <div key={i} className="shelf-cell"><SkGame /></div>)}</div></>;
  return bare ? body : <Skeleton>{body}</Skeleton>;
};
/** Category tiles. */
export const SkTiles = ({ n = 10, big }: { n?: number; big?: boolean }) => <Skeleton className={'cart-grid' + (big ? ' big' : '')}>{times(n).map((i) => <Sk key={i} kind="box" className="sk-cart" />)}</Skeleton>;
/** Instant search results. */
export const SkHits = ({ n = 3 }: { n?: number }) => <Skeleton>{times(n).map((i) => <div key={i} className="sbox-row"><Sk kind="art" className="thumb" /><span className="grow"><Sk kind="title" w={`${48 + i * 14}%`} h={14} /><Sk w="38%" style={{ marginTop: 7 }} /></span><Sk kind="tag" w={46} /></div>)}</Skeleton>;

export const HomeSkeleton = () => (
  <Skeleton className="wrap store">
    <div className="store-top">
      <div className="store-intro sk-stack"><Sk kind="big" w="min(620px, 92%)" /><Sk kind="big" w="min(440px, 70%)" /><Sk w="min(480px, 86%)" style={{ marginTop: 16 }} /></div>
      <div className="kpis">{times(4).map((i) => <div key={i} className="kpi"><Sk kind="title" w={56} h={36} /><Sk kind="tag" w={84} /></div>)}</div>
    </div>
    <div className="sk-hero ink">
      <div className="sk-stack"><Sk kind="tag" w={96} h={22} /><Sk kind="big" w="88%" h={64} /><Sk w="70%" /><div className="row"><Sk kind="tag" w={88} /><Sk kind="tag" w={72} /><Sk kind="tag" w={60} /></div><div className="row" style={{ marginTop: 14 }}><Sk kind="slab" w={170} h={54} /><Sk kind="title" w={80} h={28} /></div></div>
    </div>
    <div className="sh"><div className="grow"><Sk kind="big" w="min(340px, 60%)" h={34} /></div><Sk kind="slab" w={150} h={36} /></div>
    <div className="cart-grid">{times(10).map((i) => <Sk key={i} kind="box" className="sk-cart" />)}</div>
    <SkShelf bare /><SkShelf bare />
  </Skeleton>
);

export const GameSkeleton = () => (
  <Skeleton className="wrap page gpage">
    <Sk w={220} />
    <div className="gp-head"><div className="grow sk-stack"><Sk kind="big" w="min(560px, 80%)" h={72} /><Sk w="min(440px, 90%)" h={16} /></div></div>
    <div className="gp-top">
      <Sk kind="box" className="stage" />
      <aside className="gp-cap sk-stack"><Sk kind="tag" w={130} /><Sk kind="big" w={130} h={44} /><Sk kind="slab" w="100%" h={54} /><Sk w="76%" /><div className="gp-facts">{times(3).map((i) => <div key={i}><Sk kind="tag" w={86} /><Sk w={96} /></div>)}</div><div className="row"><Sk kind="tag" w={80} /><Sk kind="tag" w={70} /><Sk kind="tag" w={56} /></div></aside>
    </div>
    <div className="gp">
      <div className="stack l"><div className="sh"><Sk kind="big" w={260} h={28} /></div><SkText lines={5} w="min(720px, 100%)" /><Sk kind="box" h={84} /><div className="sh"><Sk kind="big" w={220} h={28} /></div><div className="compat-grid">{times(3).map((i) => <Sk key={i} kind="box" h={66} />)}</div></div>
      <div className="stack"><SkStats n={4} /><SkCard lines={5} /><SkCard lines={4} /></div>
    </div>
  </Skeleton>
);

/** Shelves under a category's head. */
export const CategorySkeleton = () => <Skeleton><SkShelf bare /><SkShelf bare /></Skeleton>;

export const QueueSkeleton = () => (
  <Skeleton>
    <div className="q-progress">{times(12).map((i) => <i key={i} />)}</div>
    <div className="q-card"><div className="q-art"><Sk kind="box" className="art" /></div><div className="q-info"><div className="row"><Sk kind="tag" w={96} /><Sk kind="tag" w={76} /></div><Sk kind="big" w="86%" h={52} /><Sk w="92%" /><div className="row"><Sk w={90} /><Sk w={90} /><Sk w={70} /></div><Sk kind="slab" w={210} h={54} /><Sk kind="slab" w={170} h={54} /></div></div>
  </Skeleton>
);

export const ConsoleSkeleton = () => (
  <Skeleton className="wrap page">
    <SkHeader tabs={2} />
    <div className="stack l">
      <SkStats n={4} />
      <div className="cols"><section className="card"><header><Sk kind="title" w={150} h={16} /></header><div className="list-tools"><Sk kind="box" h={44} /></div><SkRows n={7} /></section><div className="stack l"><SkCard><div className="sk-stack"><Sk kind="box" h={72} /><SkText lines={3} /></div></SkCard><SkCard lines={2} /></div></div>
    </div>
  </Skeleton>
);

export const ProjectSkeleton = () => (
  <Skeleton className="wrap page">
    <SkHeader sub tabs={2} />
    <div className="stack l">
      <SkStats n={5} />
      <div className="cols"><div className="stack l"><section className="card"><header><Sk kind="title" w={130} h={16} /></header><SkRows n={4} thumb={false} /></section><SkCard><div className="sk-stack"><SkBars /><SkBars /></div></SkCard></div><div className="stack l"><SkCard lines={3} /><SkCard lines={3} /><SkCard lines={5} /></div></div>
    </div>
  </Skeleton>
);

export const AnalyticsSkeleton = () => (
  <Skeleton className="wrap page">
    <SkHeader tabs={2} />
    <div className="stack l">
      <SkCard><SkStats n={3} /></SkCard>
      <SkStats n={4} />
      <div className="cols"><div className="stack l"><SkCard><div className="sk-stack"><SkBars /><SkBars /><SkBars /></div></SkCard><SkCard><SkBars n={24} /></SkCard></div><div className="stack l"><SkCard lines={3} /><SkCard lines={6} /><SkCard lines={3} /></div></div>
    </div>
  </Skeleton>
);

export const EarningsSkeleton = () => (
  <Skeleton className="wrap page">
    <SkHeader tabs={2} />
    <div className="stack l">
      <SkStats n={3} />
      <div className="cols"><div className="stack l"><SkCard><div className="sk-stack"><Sk kind="box" h={56} /><SkText lines={2} /></div></SkCard><section className="card"><header><Sk kind="title" w={110} h={16} /></header><SkTable rows={4} cols={4} /></section></div><div className="stack l"><SkCard lines={3} /><SkCard lines={3} /></div></div>
    </div>
  </Skeleton>
);

/** The body of an admin tab; the page header and tabs are already on screen. */
export const AdminSkeleton = ({ tab }: { tab: 'overview' | 'settings' | 'table' | 'money' }) => (
  <Skeleton className="stack l">
    {tab === 'overview' && <><SkStats n={6} /><div className="cols"><SkCard><div className="sk-stack"><SkBars /><SkBars /><SkBars /></div></SkCard><SkCard><SkText lines={8} /></SkCard></div></>}
    {tab === 'settings' && times(3).map((i) => <section key={i} className="card" style={{ maxWidth: 900 }}><header><Sk kind="title" w={120} h={16} /></header>{times(3).map((k) => <div key={k} className="set-row"><span className="sk-stack"><Sk kind="title" w={`${40 + k * 12}%`} h={15} /><Sk w={110} /></span><Sk kind="box" h={44} /></div>)}</section>)}
    {tab === 'table' && <section className="card"><SkTable rows={8} cols={7} /></section>}
    {tab === 'money' && <><SkStats n={4} /><section className="card"><header><Sk kind="title" w={150} h={16} /></header><SkTable rows={5} cols={5} /></section><section className="card"><header><Sk kind="title" w={130} h={16} /></header><SkTable rows={5} cols={5} /></section></>}
  </Skeleton>
);

/** A page whose shape is not known yet (a sign-in redirect, an unknown path). */
export const PageSkeleton = () => <Skeleton className="wrap page"><SkHeader sub /><div className="stack l"><SkStats n={4} /><SkCard lines={6} /></div></Skeleton>;

/** The outline for a path, used while the app itself starts and while a signed-in page waits for the session. */
export function RouteSkeleton({ path }: { path: string }) {
  if (path === '/') return <HomeSkeleton />;
  if (path.startsWith('/g/')) return <GameSkeleton />;
  if (path === '/browse' || path.startsWith('/c/')) return <div className="wrap page"><div className="browse-h"><Sk w={160} /><Sk kind="big" w="min(380px, 70%)" h={56} /></div><SkGrid /></div>;
  if (path === '/categories') return <div className="wrap page"><div className="browse-h"><Sk w={160} /><Sk kind="big" w="min(380px, 70%)" h={56} /></div><SkTiles n={12} big /></div>;
  if (path === '/queue') return <div className="wrap page queue"><div className="browse-h"><Sk w={160} /><Sk kind="big" w="min(460px, 80%)" h={56} /></div><QueueSkeleton /></div>;
  if (path === '/console') return <ConsoleSkeleton />;
  if (path === '/console/earnings') return <EarningsSkeleton />;
  if (path.endsWith('/analytics')) return <AnalyticsSkeleton />;
  if (path.startsWith('/console/')) return <ProjectSkeleton />;
  if (path.startsWith('/admin')) return <div className="wrap page"><SkHeader tabs={5} /><AdminSkeleton tab="overview" /></div>;
  return <PageSkeleton />;
}

/** The whole window before the app has its session and settings: the top bar's outline and the page's. */
export const AppSkeleton = ({ path }: { path: string }) => (
  <>
    <header className="nav"><div className="wrap nav-in"><span className="brand"><i className="logo" aria-hidden="true" /></span><span className="nav-links"><Sk kind="slab" w={74} h={38} /><Sk kind="slab" w={120} h={38} /><Sk kind="slab" w={70} h={38} /></span><span className="nav-search"><Sk kind="box" h={42} /></span><span className="nav-tools"><Sk kind="slab" w={86} h={38} /></span></div></header>
    <main><RouteSkeleton path={path} /></main>
  </>
);
