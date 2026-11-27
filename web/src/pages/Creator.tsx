// A creator's public profile (/creator/<id>): who they are, how long they have been here, how many follow them, and
// their games. The lead is an ink block with their best-known game cut in along a slant (the store's hero language),
// their monogram, name and HUD figures, and the Follow button as the one hot action. Then their newest release and
// their most played game side by side, and every live game in the store's own cards, sortable and paged.
// Data: GET /api/creators/:id (src/routes/follows.ts) and the store list GET /api/games?by=<id>.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ago, api, blurb, CoverImg, count, date, Fail, GameTile, genreHue, genreName, Link, MatureTag, num, PriceTag, shown, t, useApp, useData, Verdict, artStyle, type GameCard } from '../lib';
import { Button, EmptyState, ListPager, Notice, Segmented } from '../ui';
import { Skeleton, Sk, SkText } from '../ui/skeleton';
import { SectionHead } from '../store';
import { creatorPath, FollowButton, Monogram } from '../follow';
import '../follow.css';

interface Profile {
  creator: { id: string; name: string; joined_at: number; creator_since: number | null; followers: number; games: number; plays: number; playing: number; rating: number | null; rating_count: number; first_release: number | null; latest_release: number | null };
  viewer: { signed_in: boolean; self: boolean; following: boolean };
}
type Sort = 'played' | 'new' | 'top';
const PAGE = 24;
const monthYear = (ms: number | null) => (ms ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' }).format(new Date(ms)) : '—');

export function Creator({ id }: { id: string }) {
  const { data, error, loading, reload } = useData<Profile>(`/creators/${encodeURIComponent(id)}`);
  const [followers, setFollowers] = useState<number | null>(null), [copied, setCopied] = useState(false);
  // the lead's picture and the spotlight: the most played game and the newest one
  const [top, setTop] = useState<GameCard[] | null>(null), [latest, setLatest] = useState<GameCard | null>(null);
  useEffect(() => {
    if (!data || !data.creator.games) { setTop([]); return; }
    api<{ games: GameCard[] }>(`/games?by=${encodeURIComponent(id)}&facets=0&sort=played&limit=1`).then((r) => setTop(r.games), () => setTop([]));
    api<{ games: GameCard[] }>(`/games?by=${encodeURIComponent(id)}&facets=0&sort=new&limit=1`).then((r) => setLatest(r.games[0] || null), () => setLatest(null));
  }, [data, id]);
  useEffect(() => { if (data) document.title = t('{name} · Creator', '{name} · 创作者', { name: data.creator.name }); }, [data]);

  if (error && !data) return <div className="wrap page">{error.status === 404
    ? <EmptyState title={t('This creator is not here', '找不到这位创作者')} action={<Button to="/browse" variant="primary">{t('Browse games', '浏览游戏')}</Button>}>{t('The link may be old, or the account may have closed.', '链接可能已失效，或该账户已关闭。')}</EmptyState>
    : <Fail error={error} retry={reload} />}</div>;
  if (loading && !data) return <CreatorSkeleton />;
  const { creator: c, viewer } = data!, fans = followers ?? c.followers;
  const best = top?.[0] ? shown(top[0]) : null, newest = latest ? shown(latest) : null;
  const share = async () => {
    const url = location.origin + creatorPath(c.id);
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: c.name, url });
      else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    } catch { /* closed the share sheet */ }
  };
  const h = best?.tags[0] ? genreHue(best.tags[0]) : (c.id.length * 47) % 360;
  return (
    <div className="wrap page cp">
      <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}><Link to="/">{t('Store', '商店')}</Link><i>/</i><span className="clip">{c.name}</span></nav>

      <section className={'cp-hero ink' + (best ? ' has-art' : '')} style={{ '--h': h } as CSSProperties} aria-labelledby="cp-name">
        {best && (
          <Link to={`/g/${best.slug}`} className="cp-art" tabIndex={-1} aria-hidden="true">
            <span className="art" style={best.cover ? undefined : artStyle(best.slug)}>{best.cover && <CoverImg g={best} src={best.cover} lazy={false} />}</span>
          </Link>
        )}
        <div className="cp-id">
          <Monogram id={c.id} name={c.name} size="xl" />
          <div className="cp-who">
            <span className="eyebrow sig">{t('Creator', '创作者')}</span>
            <h1 id="cp-name">{c.name}</h1>
            <p className="cp-since">
              <span>{t('Joined {when}', '加入于 {when}', { when: monthYear(c.joined_at) })}</span>
              {c.first_release && <span>{t('First game {when}', '首款游戏发布于 {when}', { when: monthYear(c.first_release) })}</span>}
              {c.latest_release && <span>{t('Last release {when}', '最近发布 {when}', { when: ago(c.latest_release) })}</span>}
            </p>
          </div>
        </div>
        <div className="cp-acts">
          {viewer.self
            ? <Button to="/console" variant="primary">{t('Open your console', '打开控制台')}</Button>
            : <FollowButton id={c.id} name={c.name} state={viewer.signed_in ? viewer.following : false} size="lg" onChange={(_, n) => setFollowers(n)} />}
          <Button onClick={share} variant="secondary" aria-live="polite">{copied ? t('Link copied', '链接已复制') : t('Share', '分享')}</Button>
        </div>
        <dl className="cp-hud">
          <div className={fans ? 'is-hot' : ''}><dt>{fans === 1 ? t('Follower', '关注者') : t('Followers', '关注者')}</dt><dd className="num">{num(fans)}</dd></div>
          <div><dt>{c.games === 1 ? t('Game', '游戏') : t('Games', '游戏')}</dt><dd className="num">{num(c.games)}</dd></div>
          <div><dt>{t('Plays', '游玩次数')}</dt><dd className="num">{num(c.plays)}</dd></div>
          <div><dt>{t('Players say', '玩家评价')}</dt><dd>{c.rating_count ? <Verdict g={{ rating: c.rating, rating_count: c.rating_count }} /> : <span className="dim">—</span>}</dd></div>
        </dl>
        {c.playing > 0 && <span className="live-pill cp-live"><i className="live-dot" aria-hidden="true" />{t('{n} playing now', '{n} 人正在玩', { n: num(c.playing) })}</span>}
      </section>

      {viewer.self && (
        <div className="cp-self"><Notice tone="info" title={t('This is your public profile', '这是你的公开主页')}>
          {t('Players see this page when they tap your name on a game or in the store. Your email is never shown. Followers hear about your next new game the moment it goes live.', '玩家在游戏页或商店中点击你的名字时会看到这个页面。你的邮箱永远不会显示。你发布新游戏时，关注者会第一时间收到通知。')}
        </Notice></div>
      )}

      {!c.games ? (
        <div className="cp-empty">
          <EmptyState title={viewer.self ? t('Your first game will show up here', '你的第一款游戏会显示在这里') : t('No games live yet', '还没有上线的游戏')}
            action={viewer.self ? <Button to="/create" variant="primary">{t('Make a game', '创作游戏')}</Button> : <FollowButton id={c.id} name={c.name} state={viewer.signed_in ? viewer.following : false} onChange={(_, n) => setFollowers(n)} />}>
            {viewer.self ? t('Publish a game with your agent and it appears on this page, with your followers told at once.', '用你的智能体发布一款游戏，它就会出现在这个页面上，同时通知你的关注者。')
              : t('Follow {name} and you will hear the moment their first game goes live.', '关注 {name}，他们的第一款游戏上线时你会第一时间知道。', { name: c.name })}
          </EmptyState>
        </div>
      ) : (
        <>
          {(newest || best) && <Spotlight newest={newest} best={best} />}
          <AllGames id={c.id} total={c.games} />
        </>
      )}
    </div>
  );
}

/** The newest release and the most played game, side by side (one card when they are the same game). */
function Spotlight({ newest, best }: { newest: GameCard | null; best: GameCard | null }) {
  const cards: [GameCard, string][] = [];
  if (newest) cards.push([newest, newest.published_at && Date.now() - newest.published_at < 30 * 86400000 ? t('New release', '新作') : t('Latest release', '最新作品')]);
  if (best && best.id !== newest?.id) cards.push([best, t('Most played', '最多人玩')]);
  return (
    <section className="cp-spot" aria-label={t('Highlights', '精选')}>
      {cards.map(([g, label]) => (
        <Link key={g.id} to={`/g/${g.slug}`} className="cp-feat" style={{ '--h': g.tags[0] ? genreHue(g.tags[0]) : 350 } as CSSProperties}>
          <span className="art" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover ? <CoverImg g={g} src={g.cover} /> : <span className="mono-title">{g.title}</span>}<MatureTag g={g} /></span>
          <span className="cp-feat-b">
            <span className="stick">{label}</span>
            <b className="cp-feat-t">{g.title}</b>
            {blurb(g) && <span className="cp-feat-l">{blurb(g)}</span>}
            <span className="cp-feat-m">
              <Verdict g={g} />
              {g.tags[0] && <span className="gtag" style={{ '--h': genreHue(g.tags[0]) } as CSSProperties}>{genreName(g.tags[0])}</span>}
              <span className="dim">{count(g.plays, 'play', 'plays', '次游玩')}</span>
              <span className="dim">{date(g.published_at)}</span>
            </span>
            <span className="cp-feat-cta"><span className="btn btn-primary btn-sm">{g.price_cents > 0 ? t('View game', '查看游戏') : <><i className="play-tri" aria-hidden="true" />{t('Play free', '免费游玩')}</>}</span><PriceTag g={g} className="cp-feat-p" /></span>
          </span>
        </Link>
      ))}
    </section>
  );
}

/** Every live game of theirs, in the store's cards: most played, newest or best rated, 24 at a time. */
function AllGames({ id, total }: { id: string; total: number }) {
  const [sort, setSort] = useState<Sort>('played'), [page, setPage] = useState(1);
  const [games, setGames] = useState<GameCard[] | null>(null), [totalCount, setTotalCount] = useState(total), [busy, setBusy] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { setPage(1); }, [id, sort]);
  useEffect(() => {
    let live = true; setBusy(true);
    api<{ games: GameCard[]; total?: number }>(`/games?by=${encodeURIComponent(id)}&facets=0&sort=${sort}&limit=${PAGE}&offset=${(page - 1) * PAGE}`)
      .then((r) => { if (live) { setGames(r.games); if (typeof r.total === 'number') setTotalCount(r.total); } }, () => { if (live) setGames([]); })
      .finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [id, sort, page]);
  const go = (p: number) => { setPage(p); ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return (
    <section className="cp-games" ref={ref}>
      <SectionHead title={total === 1 ? t('Their game', 'TA 的游戏') : t('All {n} games', '全部 {n} 款游戏', { n: num(total) })}>
        {total > 1 && <Segmented label={t('Sort', '排序')} value={sort} onChange={setSort} options={[['played', t('Most played', '最多人玩')], ['new', t('Newest', '最新')], ['top', t('Top rated', '评分最高')]]} />}
      </SectionHead>
      {games === null ? <Skeleton><div className="grid browse-grid">{Array.from({ length: Math.min(total, 8) }, (_, i) => <div key={i} className="stack s"><Sk h={150} /><SkText lines={2} /></div>)}</div></Skeleton>
        : <div className="grid browse-grid" aria-busy={busy}>{games.map((g) => <GameTile key={g.id} g={g} />)}</div>}
      <ListPager page={page} total={totalCount} perPage={PAGE} onPage={go} />
    </section>
  );
}

function CreatorSkeleton() {
  return (
    <div className="wrap page cp">
      <Skeleton>
        <div className="cp-hero ink sk-cp">
          <div className="cp-id"><Sk w={112} h={112} /><div className="stack s grow"><Sk w={90} h={12} /><Sk w="60%" h={56} /><Sk w="40%" h={14} /></div></div>
          <div className="cp-acts"><Sk w={150} h={48} /><Sk w={96} h={48} /></div>
          <div className="cp-hud">{[0, 1, 2, 3].map((i) => <div key={i}><Sk w={70} h={10} /><Sk w={56} h={32} /></div>)}</div>
        </div>
        <div className="grid browse-grid" style={{ marginTop: 40 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="stack s"><Sk h={150} /><SkText lines={2} /></div>)}</div>
      </Skeleton>
    </div>
  );
}
