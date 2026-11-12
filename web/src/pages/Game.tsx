import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ago, api, artStyle, date, Fail, Link, loginUrl, navigate, num, playTime, price, query, Spinner, Star, Stars, t, useAct, useApp, useData, count } from '../lib';

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
      <div className="stage" ref={box}>
        {url ? <iframe ref={frame} src={url} title="Game" allow="fullscreen; gamepad; autoplay; clipboard-write; accelerometer; gyroscope" allowFullScreen /> : (
          <><div className="poster" style={poster ? { backgroundImage: `url(${poster})` } : artStyle(seed)} /><div className="over">{children}</div></>
        )}
      </div>
      {url && <div className="row" style={{ marginTop: 12 }}><span className="mute" style={{ fontSize: 13 }}>{t('Click the game to give it keyboard focus.', '点击游戏画面以获取键盘焦点。')}</span><button className="btn sm right" onClick={toggle}>{t('Fullscreen', '全屏')}</button></div>}
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
  useEffect(() => { if (data?.my_review) { setRating(data.my_review.rating); setBody(data.my_review.body || ''); } }, [data?.my_review]);

  if (error && !data) return <div className="wrap page">{error.status === 404 ? <div className="empty"><h3>{t('This game is not available', '该游戏暂不可用')}</h3><p>{t('It may have been taken offline by its creator.', '它可能已被创作者下线。')}</p><p style={{ marginTop: 16 }}><Link to="/" className="btn">{t('Browse games', '浏览游戏')}</Link></p></div> : <Fail error={error} retry={reload} />}</div>;
  if (loading && !data) return <Spinner />;
  const g = data.game, live = g.status === 'live', paid = g.price_cents > 0, locked = paid && !data.owned;

  const play = () => {
    if (!user) return navigate(loginUrl());
    void act('play', async () => { const r = await api<{ url: string }>(`/games/${slug}/play`, { method: 'POST' }); setUrl(r.url); });
  };
  const buy = () => {
    if (!user) return navigate(loginUrl());
    void act('buy', async () => { const r = await api<{ url: string }>(`/games/${slug}/buy`, { method: 'POST' }); location.href = r.url; });
  };
  const review = () => act('review', async () => { await api(`/games/${slug}/reviews`, { body: { rating, body } }); await reload(); }, t('Thanks. Your review is saved.', '感谢，评价已保存。'));
  const total = data.rating_dist.reduce((a: number, b: number) => a + b, 0);
  const canReview = !!user && !data.is_owner && (data.played || !config.settings.review_requires_play);

  return (
    <div className="wrap" style={{ paddingTop: 26 }}>
      <Stage poster={g.cover || g.screenshot} seed={g.slug} url={url}>
        <div className="stack l" style={{ justifyItems: 'center' }}>
          {!live ? <><span className="badge sig">{t('Offline', '已下线')}</span><p className="mute">{t('This game is not live right now.', '该游戏目前未上线。')}</p></>
            : locked ? <><button className="play-btn buy" onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Buy', '购买')} · {price(g.price_cents)}</button><span className="mute" style={{ fontSize: 14 }}>{config.payments ? t('One payment. Play as much as you like.', '一次购买，畅玩无限。') : t('Purchases are not open yet on this platform.', '平台暂未开放购买。')}</span></>
            : <><button className="play-btn" onClick={play} disabled={busy === 'play'}>{busy === 'play' ? t('Starting…', '启动中…') : t('Play', '开始游戏')}</button>{!user && <span className="mute" style={{ fontSize: 14 }}>{t('Sign in to play. It takes a few seconds.', '登录后即可游玩，只需几秒。')}</span>}</>}
        </div>
      </Stage>

      <div className="gp">
        <div className="stack xl">
          <div className="stack l">
            <div className="stack">
              <h1>{g.title}</h1>
              {g.tagline && <p className="mute" style={{ fontSize: 18 }}>{g.tagline}</p>}
              <div className="row wrapx mute"><span>{t('by', '作者')} <b style={{ color: 'var(--bone)' }}>{g.author}</b></span><Stars rating={g.rating} count={g.rating_count} />{g.tags.map((x: string) => <Link key={x} to={`/?tag=${encodeURIComponent(x)}`} className="chip">{x}</Link>)}</div>
            </div>
            {data.is_owner && <div className="notice row wrapx"><span className="grow">{t('This is your game. Players see this page.', '这是你的游戏，玩家看到的就是这个页面。')}</span><Link to={`/console/p/${g.id}`} className="btn sm">{t('Open in console', '在控制台打开')}</Link></div>}
            {g.description && <div className="prose">{g.description}</div>}
            {g.controls && <div className="stack"><span className="eyebrow">{t('Controls', '操作方式')}</span><div className="prose">{g.controls}</div></div>}
          </div>

          <section className="stack l">
            <div className="section-h" style={{ margin: 0 }}><h2>{t('Ratings and reviews', '评分与评价')}</h2></div>
            {canReview ? (
              <div className="card pad stack">
                <b>{data.my_review ? t('Your review', '你的评价') : t('Rate this game', '为这款游戏评分')}</b>
                <div className="rate" role="radiogroup" aria-label={t('Rating', '评分')}>{[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n}`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}><Star /></button>)}</div>
                <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder={t('What did you like? What would make it better? (optional)', '喜欢哪些地方？哪里还可以更好？（选填）')} />
                <div><button className="btn pri" disabled={!rating || busy === 'review'} onClick={review}>{data.my_review ? t('Update review', '更新评价') : t('Post review', '发布评价')}</button></div>
              </div>
            ) : !data.is_owner && <p className="mute">{!user ? <><Link to={loginUrl()} className="sig">{t('Sign in', '登录')}</Link> {t('and play to leave a review.', '并游玩后即可评价。')}</> : t(`Play for at least ${config.settings.play_min_seconds} seconds to leave a review.`, `游玩至少 ${config.settings.play_min_seconds} 秒后即可评价。`)}</p>}
            {data.reviews.length ? <div>{data.reviews.map((r: any, i: number) => (
              <div className="review" key={i}>
                <div className="row"><b>{r.name}</b>{r.mine && <span className="badge plain">{t('You', '你')}</span>}<span className="stars">{Array.from({ length: r.rating }, (_, k) => <Star key={k} />)}</span><span className="dim right" style={{ fontSize: 13 }}>{ago(r.at)}</span></div>
                {r.body && <p className="prose" style={{ fontSize: 15 }}>{r.body}</p>}
              </div>))}</div> : <p className="dim">{t('No reviews yet. Be the first to say something.', '还没有评价，来做第一个吧。')}</p>}
          </section>
        </div>

        <aside className="stack l">
          <div className="card pad stack l">
            <div className="row"><b style={{ fontSize: 30, letterSpacing: '-.03em' }}>{price(g.price_cents)}</b>{paid && data.owned && !data.is_owner && <span className="badge good">{t('Owned', '已拥有')}</span>}</div>
            {live && (locked ? <button className="btn pri big" onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Buy to play', '购买后游玩')}</button> : <button className="btn pri big" onClick={() => { play(); window.scrollTo({ top: 0 }); }} disabled={busy === 'play' || !!url}>{url ? t('Playing', '游玩中') : t('Play', '开始游戏')}</button>)}
            <dl className="kv">
              <dt>{t('Plays', '游玩次数')}</dt><dd>{num(g.plays)}</dd>
              <dt>{t('Time played', '累计时长')}</dt><dd>{playTime(g.minutes * 60)}</dd>
              <dt>{t('Version', '版本')}</dt><dd>v{g.version ?? '—'}</dd>
              <dt>{t('Updated', '更新于')}</dt><dd>{date(g.updated_at)}</dd>
              <dt>{t('Released', '发布于')}</dt><dd>{date(g.published_at)}</dd>
            </dl>
          </div>
          <div className="card pad stack">
            <div className="row"><b style={{ fontSize: 34, letterSpacing: '-.03em' }}>{g.rating != null ? g.rating.toFixed(1) : '—'}</b><span className="mute">{count(g.rating_count, 'rating', 'ratings', '个评分')}</span></div>
            <div className="dist">{[5, 4, 3, 2, 1].map((n) => <div key={n}><span>{n}</span><i><b style={{ width: `${total ? (data.rating_dist[n - 1] / total) * 100 : 0}%` }} /></i><span className="num">{data.rating_dist[n - 1]}</span></div>)}</div>
          </div>
          <p className="dim" style={{ fontSize: 13 }}>{t('Every game here was run in a real browser and checked for playability before it went live.', '这里的每款游戏在上线前都在真实浏览器中运行并通过了可玩性验证。')}</p>
        </aside>
      </div>
    </div>
  );
}
