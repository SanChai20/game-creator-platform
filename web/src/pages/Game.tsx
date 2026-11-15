import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ago, api, artStyle, blurb, count, date, Fail, genreHue, genreName, Link, loginUrl, markSeen, navigate, num, playTime, price, query, RARITY, rarity, rarityHint, rememberPlay, Star, t, useAct, useApp, useData, Verdict } from '../lib';
import { Badge, Button, Card, EmptyState, KeyValue, Notice, PlayButton, Spinner, Stat, StatGrid, Textarea } from '../ui';
import { MoreFrom, MoreLike, SectionHead } from '../store';

/** The play surface: a poster until the player starts, then the game in a frame on its own origin. */
export function Stage({ poster, seed, url, children }: { poster: string | null; seed: string; url: string | null; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null);
  const toggle = useCallback(() => { const el = box.current; if (!el) return; if (document.fullscreenElement) void document.exitFullscreen(); else void el.requestFullscreen?.().catch(() => {}); }, []);
  useEffect(() => {
    const f = (e: MessageEvent) => { if (e.source === frame.current?.contentWindow && e.data && e.data.gcp === 'fullscreen') toggle(); };
    addEventListener('message', f); return () => removeEventListener('message', f);
  }, [toggle]);
  useEffect(() => { if (url) frame.current?.focus(); }, [url]);
  return (
    <div>
      <div className="stage" ref={box} data-gl-host="">
        {url ? <iframe ref={frame} src={url} title="Game" allow="fullscreen; gamepad; autoplay; clipboard-write; accelerometer; gyroscope" allowFullScreen /> : (
          <><div className="poster" style={poster ? { backgroundImage: `url(${poster})` } : artStyle(seed)} data-gl={poster ? 'poster' : undefined} data-gl-src={poster || undefined} /><div className="over">{children}</div></>
        )}
      </div>
      {url && <div className="row stage-bar"><span className="mute fs-sm">{t('Click the game to give it keyboard focus.', '点击游戏画面以获取键盘焦点。')}</span><Button size="sm" className="right" onClick={toggle}>⤢ {t('Fullscreen', '全屏')}</Button></div>}
    </div>
  );
}

export function Game({ slug }: { slug: string }) {
  const { user, toast, config } = useApp(), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<any>(`/games/${encodeURIComponent(slug)}`);
  const [url, setUrl] = useState<string | null>(null);
  const [rating, setRating] = useState(0), [body, setBody] = useState('');

  // Back from checkout: confirm the session so access does not wait for the webhook.
  useEffect(() => {
    const paid = query().get('paid'); if (!paid) return;
    navigate(`/g/${slug}`, true);
    if (!user) return;
    api('/billing/confirm', { body: { session_id: paid } }).then(() => { toast(t('Purchase complete. Enjoy the game.', '购买成功，祝你玩得开心。')); void reload(); }, (e) => toast((e as Error).message, true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { markSeen(slug); }, [slug]);
  useEffect(() => { if (data?.my_review) { setRating(data.my_review.rating); setBody(data.my_review.body || ''); } }, [data?.my_review]);

  if (error && !data) return <div className="wrap page">{error.status === 404 ? <EmptyState title={t('This game is not available', '该游戏暂不可用')} action={<Button to="/">{t('Browse games', '浏览游戏')}</Button>}>{t('It may have been taken offline by its creator.', '它可能已被创作者下线。')}</EmptyState> : <Fail error={error} retry={reload} />}</div>;
  if (loading && !data) return <Spinner />;
  const g = data.game, live = g.status === 'live', paid = g.price_cents > 0, locked = paid && !data.owned;

  const play = () => {
    if (!user) return navigate(loginUrl());
    void act('play', async () => { const r = await api<{ url: string }>(`/games/${slug}/play`, { method: 'POST' }); setUrl(r.url); rememberPlay({ slug: g.slug, title: g.title, cover: g.cover || g.screenshot || null }); });
  };
  const buy = () => {
    if (!user) return navigate(loginUrl());
    void act('buy', async () => { const r = await api<{ url: string }>(`/games/${slug}/buy`, { method: 'POST' }); location.href = r.url; });
  };
  const review = () => act('review', async () => { await api(`/games/${slug}/reviews`, { body: { rating, body } }); await reload(); }, t('Thanks. Your review is saved.', '感谢，评价已保存。'));
  const total = data.rating_dist.reduce((a: number, b: number) => a + b, 0);
  const canReview = !!user && !data.is_owner && (data.played || !config.settings.review_requires_play);

  const genre = g.tags?.[0] as string | undefined, R = RARITY[rarity(g)], h = genre ? genreHue(genre) : 270;
  const cta = !live ? null : locked
    ? <Button variant="primary" size="lg" onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Buy', '购买')} · {price(g.price_cents)}</Button>
    : <Button variant="primary" size="lg" onClick={() => { play(); window.scrollTo({ top: 0, behavior: 'smooth' }); }} disabled={busy === 'play' || !!url}>{url ? t('Playing', '游玩中') : `▶ ${t('Play now', '立即游玩')}`}</Button>;

  return (
    <div className="gpage" style={{ '--h': h, '--rc': R.color } as CSSProperties}>
      <div className="wrap page">
        <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}>
          <Link to="/">{t('Store', '商店')}</Link><i>/</i>
          {genre && <><Link to={`/c/${encodeURIComponent(genre)}`}>{genreName(genre)}</Link><i>/</i></>}
          <span className="clip">{g.title}</span>
        </nav>
        <header className="gp-head">
          <div className="grow"><h1>{g.title}</h1>{blurb(g) && <p className="lede">{blurb(g)}</p>}</div>
          <div className="gp-head-r"><span className="rar-pill" title={rarityHint()}>{R.name()}</span>{!!g.playing && <span className="live-pill big"><i className="live-dot" aria-hidden="true" />{num(g.playing)} {t('playing now', '人正在玩')}</span>}</div>
        </header>

        <div className="gp-top">
          <Stage poster={g.cover || g.screenshot} seed={g.slug} url={url}>
            <div className="stack l" style={{ justifyItems: 'center' }}>
              {!live ? <><Badge tone="accent">{t('Offline', '已下线')}</Badge><p className="mute">{t('This game is not live right now.', '该游戏目前未上线。')}</p></>
                : locked ? <><PlayButton buy onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Buy', '购买')} · {price(g.price_cents)}</PlayButton><span className="mute fs-sm">{config.payments ? t('One payment. Play as much as you like.', '一次购买，畅玩无限。') : t('Purchases are not open yet on this platform.', '平台暂未开放购买。')}</span></>
                : <><PlayButton onClick={play} disabled={busy === 'play'}>{busy === 'play' ? t('Starting…', '启动中…') : t('Play', '开始游戏')}</PlayButton>{!user && <span className="mute fs-sm">{t('Sign in to play. It takes a few seconds.', '登录后即可游玩，只需几秒。')}</span>}</>}
            </div>
          </Stage>
          <aside className="gp-cap">
            <div className="gp-cover" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" />}</div>
            {g.description && <p className="gp-blurb">{String(g.description).slice(0, 220)}{String(g.description).length > 220 ? '…' : ''}</p>}
            <dl className="gp-facts">
              <div><dt>{t('Players say', '玩家评价')}</dt><dd><Verdict g={g} full /></dd></div>
              <div><dt>{t('Released', '发布')}</dt><dd>{date(g.published_at)}</dd></div>
              <div><dt>{t('Creator', '创作者')}</dt><dd><Link to={`/browse?by=${encodeURIComponent(g.owner_id)}&who=${encodeURIComponent(g.author)}`} className="sig">{g.author}</Link></dd></div>
            </dl>
            <div className="gp-tags">{g.tags.map((x: string) => <Link key={x} to={`/c/${encodeURIComponent(x)}`} className="gtag" style={{ '--h': genreHue(x) } as CSSProperties}>{genreName(x)}</Link>)}</div>
          </aside>
        </div>

        {data.is_owner && <div className="gp-own"><Notice actions={<Button size="sm" to={`/console/p/${g.id}`}>{t('Open in console', '在控制台打开')}</Button>}>{t('This is your game. Players see this page.', '这是你的游戏，玩家看到的就是这个页面。')}</Notice></div>}

        {live && (
          <div className="gp-buy">
            <div className="grow"><h2>{locked ? t(`Buy ${g.title}`, `购买 ${g.title}`) : t(`Play ${g.title}`, `游玩 ${g.title}`)}</h2><p>{t('Runs in your browser. Nothing to install.', '在浏览器中运行，无需安装。')} {paid && data.owned && !data.is_owner && <Badge tone="good">{t('Owned', '已拥有')}</Badge>}</p></div>
            <div className="gp-buy-act"><span className="gp-price">{price(g.price_cents)}</span>{cta}</div>
          </div>
        )}

        <div className="gp">
          <div className="stack xl">
            {(g.description || g.controls) && (
              <section className="stack l">
                <SectionHead title={t('About this game', '关于这款游戏')} />
                {g.description && <div className="prose">{g.description}</div>}
                {g.controls && <div className="gp-controls"><span className="eyebrow">{t('Controls', '操作方式')}</span><div className="prose">{g.controls}</div></div>}
              </section>
            )}

            <section className="stack l">
              <SectionHead title={t('Ratings and reviews', '评分与评价')} note={g.rating_count ? <Verdict g={g} full /> : undefined} />
              {canReview ? (
                <Card pad>
                  <b>{data.my_review ? t('Your review', '你的评价') : t('Rate this game', '为这款游戏评分')}</b>
                  <div className="rate" role="radiogroup" aria-label={t('Rating', '评分')}>{[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n}`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}><Star /></button>)}</div>
                  <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder={t('What did you like? What would make it better? (optional)', '喜欢哪些地方？哪里还可以更好？（选填）')} />
                  <div><Button variant="primary" disabled={!rating || busy === 'review'} onClick={review}>{data.my_review ? t('Update review', '更新评价') : t('Post review', '发布评价')}</Button></div>
                </Card>
              ) : !data.is_owner && <p className="mute">{!user ? <><Link to={loginUrl()} className="sig">{t('Sign in', '登录')}</Link> {t('and play to leave a review.', '并游玩后即可评价。')}</> : t(`Play for at least ${config.settings.play_min_seconds} seconds to leave a review.`, `游玩至少 ${config.settings.play_min_seconds} 秒后即可评价。`)}</p>}
              {data.reviews.length ? <div className="reviews">{data.reviews.map((r: any, i: number) => (
                <div className="review" key={i}>
                  <div className="row"><span className="rv-avatar">{String(r.name || '?').slice(0, 1).toUpperCase()}</span><b>{r.name}</b>{r.mine && <Badge dot={false}>{t('You', '你')}</Badge>}<span className={'rv-score' + (r.rating >= 4 ? ' up' : r.rating <= 2 ? ' down' : '')}>{r.rating >= 4 ? '▲' : r.rating <= 2 ? '▼' : '◆'} {r.rating}/5</span><span className="dim right fs-sm">{ago(r.at)}</span></div>
                  {r.body && <p className="prose">{r.body}</p>}
                </div>))}</div> : <EmptyState compact title={t('No reviews yet', '还没有评价')}>{t('Be the first to say something.', '来做第一个吧。')}</EmptyState>}
            </section>
          </div>

          <aside className="stack l gp-side">
            <StatGrid>
              <Stat label={t('Plays', '游玩次数')} value={num(g.plays)} />
              <Stat label={t('Playing now', '正在玩')} value={num(g.playing || 0)} tone={g.playing ? 'accent' : undefined} />
              <Stat label={t('Time played', '累计时长')} value={playTime(g.minutes * 60)} />
              <Stat label={t('Rating', '评分')} value={g.rating != null ? `★ ${g.rating.toFixed(1)}` : '—'} />
            </StatGrid>
            <Card title={t('What players think', '玩家怎么看')} aside={count(g.rating_count, 'rating', 'ratings', '个评分')} pad>
              <div className="dist">{[5, 4, 3, 2, 1].map((n) => <div key={n}><span>{n}★</span><i><b style={{ width: `${total ? (data.rating_dist[n - 1] / total) * 100 : 0}%` }} /></i><span className="num">{data.rating_dist[n - 1]}</span></div>)}</div>
            </Card>
            <Card title={t('Details', '详细信息')} pad>
              <KeyValue items={[
                [t('Rarity', '稀有度'), <span className="rar-pill sm" title={rarityHint()}>{R.name()}</span>],
                [t('Version', '版本'), <span className="mono">v{g.version ?? '—'}</span>],
                [t('Updated', '更新于'), date(g.updated_at)],
                [t('Released', '发布于'), date(g.published_at)],
                [t('Runs on', '运行平台'), t('Any modern browser', '任意现代浏览器')],
              ]} />
            </Card>
            <div className="seal"><b>✓ {t('Verified playable', '已验证可玩')}</b><span>{t('Every game here was run in a real browser and checked for playability before it went live.', '这里的每款游戏在上线前都在真实浏览器中运行并通过了可玩性验证。')}</span></div>
            {g.open_implementation && <p className="dim fs-sm">{t('Open implementation: its creator lets other developers\' agents learn how it is built, never its code.', '开放实现：作者允许其他开发者的智能体了解它的实现方式，但不包括代码。')}</p>}
          </aside>
        </div>
        <MoreFrom n="01" owner={g.owner_id} author={g.author} slug={g.slug} />
        <MoreLike n="02" tag={genre} slug={g.slug} />
      </div>
    </div>
  );
}
