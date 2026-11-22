import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { usePlayClock } from '../play-clock';
import { ago, api, blurb, clock, count, date, dateTime, Fail, genreHue, genreName, Link, local, shown, loginUrl, markSeen, matureName, navigate, num, playTime, price, PriceTag, query, RARITY, rarity, rarityHint, rememberPlay, saleEnds, saleOn, SaleTag, Star, t, trialLabel, useAct, useApp, useData, Verdict } from '../lib';
import { Badge, Button, Card, EmptyState, KeyValue, Notice, PlayButton, Select, Stat, StatGrid, Textarea } from '../ui';
import { GameSkeleton } from '../skeletons';
import { Skeleton, SkCard } from '../ui/skeleton';
import { MoreFrom, MoreLike, SectionHead } from '../store';
import { CompatGate, CompatPill, CompatSection, useCompat } from '../compat-ui';
import { Stage, withPlayLang, type StageCtl } from '../player';
import { encodeJoin, onLaunch, setActivity } from '../social';
import { InstallTip } from '../install-tip';
import { AgeBadge, ageLabel, Glance, LangPill, LanguagesSection, playersText, type GameMeta } from '../meta-ui';
import type { Lang } from '../lib';
import { offeredListings } from '../languages';
import { legalTitle } from './Legal';
import { OPERATOR } from '../operator';
import { RefundBox, type RefundState } from '../refund-ui';

/** Under the Buy button: who the seller is, and the terms a purchase falls under. */
const SoldBy = () => <p className="dim fs-xs sold-by">{t('Sold by {op}. Payments by Stripe.', '由 {op} 销售，付款由 Stripe 处理。', { op: OPERATOR.name })} <Link to="/legal/terms">{legalTitle('terms')}</Link> · <Link to="/legal/refunds">{legalTitle('refunds')}</Link></p>;

export { Stage } from '../player';

/** The signed-in player's own progress in this game: what the platform recorded and what the game saved. Never anyone else's. */
function MyProgress({ slug, playing }: { slug: string; playing: boolean }) {
  const { act, busy } = useAct();
  const { data, loading, reload } = useData<any>(`/games/${encodeURIComponent(slug)}/progress`);
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!playing) void reload(); }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Skeleton><SkCard lines={4} /></Skeleton>;
  if (!data || (!data.sessions && !data.saves.keys && !Object.keys(data.stats).length)) return null;
  const stats = Object.entries(data.stats as Record<string, number>).slice(0, 8), best = Object.entries(data.best as Record<string, number>).slice(0, 4);
  const reset = () => act('reset', async () => { await api(`/games/${encodeURIComponent(slug)}/progress`, { method: 'DELETE' }); setSure(false); await reload(); }, t('Your progress in this game was reset.', '你在这款游戏中的进度已重置。'));
  return (
    <Card title={t('Your progress', '你的进度')} aside={<span className="dim fs-sm">{t('Only you see this', '仅你可见')}</span>} pad>
      <KeyValue items={[
        [t('Sessions', '游玩次数'), num(data.sessions)],
        [t('Time played', '游玩时长'), playTime(data.seconds)],
        [t('Last played', '上次游玩'), ago(data.last_played)],
        [t('Saved game', '存档'), data.saves.keys ? `${t('Saved', '已保存')} · ${ago(data.saves.last_saved)}` : '—'],
        ...best.map(([k, v]) => [`${t('Best', '最佳')} · ${k}`, <span className="mono">{num(v)}</span>] as [string, ReactNode]),
        ...stats.map(([k, v]) => [k.replace(/[_-]+/g, ' '), <span className="mono">{num(v)}</span>] as [string, ReactNode]),
      ]} />
      {(data.saves.keys > 0 || stats.length > 0 || best.length > 0) && (sure
        ? <div className="row"><span className="mute fs-sm grow">{t('Delete your saves, stats and scores in this game?', '删除你在这款游戏中的存档、统计和分数？')}</span><Button size="sm" variant="ghost" onClick={() => setSure(false)}>{t('Cancel', '取消')}</Button><Button size="sm" onClick={reset} disabled={busy === 'reset'}>{t('Reset', '重置')}</Button></div>
        : <div><Button size="sm" variant="ghost" onClick={() => setSure(true)}>{t('Reset my progress', '重置我的进度')}</Button></div>)}
    </Card>
  );
}

/**
 * The warning an adults-only game shows before it starts. The player must confirm; the server refuses to start the game
 * without that confirmation (POST /games/:slug/play with confirm_mature).
 */
function MatureGate({ cats, onConfirm, onCancel }: { cats: string[]; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="mgate" role="alertdialog" aria-modal="true" aria-labelledby="mgate-h" aria-describedby="mgate-d">
      <AgeBadge age={18} />
      <h3 id="mgate-h">{t('Adults only', '仅限成人')}</h3>
      <ul>{cats.map((c) => <li key={c}>{matureName(c)}</li>)}</ul>
      <p id="mgate-d">{t('Its creator declared that this game contains content for adults only. Continue only if you are 18 or older and want to see it.', '作者声明这款游戏包含仅限成人的内容。仅当你已年满 18 岁并希望观看这些内容时才继续。')}</p>
      <div className="row"><Button size="sm" variant="ghost" onClick={onCancel}>{t('Go back', '返回')}</Button><Button size="sm" variant="primary" onClick={onConfirm}>{t('I am 18 or older, continue', '我已年满 18 岁，继续')}</Button></div>
    </div>
  );
}

/** The play URL with the viewer's platform language, read by the SDK as GCP.lang. */
const withJoin = (u: string, j: string | null) => { if (!j) return u; try { const x = new URL(u, location.href); x.searchParams.set('gcp_join', j); return x.toString(); } catch { return u; } };
const withLang = (u: string, cont = false) => { const l = withPlayLang(u); if (!cont) return l; try { const x = new URL(l, location.href); x.searchParams.set('gcp_continue', '1'); return x.toString(); } catch { return l; } };

/** Where the player left off, from the game's GCP.resume or else from the platform's own record: one line under Continue. */
export function resumeLine(c: { last_played: number; saved_at: number | null; resume: { label: string; detail?: string } | null }) {
  return c.resume ? [c.resume.label, c.resume.detail].filter(Boolean).join(' · ') : t('Saved {time}', '{time}存档', { time: ago(c.saved_at || c.last_played) });
}

export function Game({ slug }: { slug: string }) {
  const { user, toast, config, refresh } = useApp(), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<any>(`/games/${encodeURIComponent(slug)}`);
  const [url, setUrl] = useState<string | null>(null), stage = useRef<StageCtl>(null), session = useRef<string | null>(null), ticket = useRef<string | null>(null);
  // While the game is open, this page checks in with the platform every 30 seconds: the platform's own play clock, which
  // every play number comes from (plays, play time, players online, trial and refund time), not the game's heartbeats.
  usePlayClock(url ? session.current : null, url ? ticket.current : null);
  const [rating, setRating] = useState(0), [body, setBody] = useState('');
  // Compatibility: this browser checked against the live version's requirements; a failing device is asked before launch.
  const cv = useCompat(data?.compat), [gate, setGate] = useState(false);
  // An adults-only game: its picture stays blurred and it starts only after the player confirms the warning (asked on every visit).
  const [adultOk, setAdultOk] = useState(false), [adultGate, setAdultGate] = useState(false);
  // A free-trial session: when it ends (by the clock here or by the game's word from the server), the game is closed.
  const [trialEnd, setTrialEnd] = useState<number | null>(null), [tick, setTick] = useState(0), [trialDone, setTrialDone] = useState(false);
  const quitGame = useCallback(() => { setUrl(null); setTrialEnd(null); void reload(); }, [reload]);
  // Who the running session plays as. It is bound to that identity: when the browser's account changes (here, in another
  // tab, or the server says the session ended), the game is closed so it never plays on as the wrong player.
  const [playingAs, setPlayingAs] = useState<{ id: string; name: string; guest: boolean } | null>(null);
  const [ended, setEnded] = useState<string | null>(null), restarted = useRef(0), startRef = useRef<() => void>(() => {});
  const closeFor = useCallback((reason: string) => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setUrl(null); setTrialEnd(null); setPlayingAs(null); setEnded(reason); void reload();
  }, [reload]);
  const onSessionEnded = useCallback((reason: string) => {
    // The token simply ran out (a reload late in a session): start a fresh one for the same player, once a minute at most.
    if (reason === 'expired' && Date.now() - restarted.current > 60000) { restarted.current = Date.now(); setUrl(null); setTimeout(() => startRef.current(), 50); return; }
    void refresh().catch(() => {}); closeFor(reason);
  }, [closeFor, refresh]);
  useEffect(() => {
    if (url && playingAs && (playingAs.guest ? !!user : user?.id !== playingAs.id)) closeFor(playingAs.guest ? 'signed_in' : 'signed_out');
  }, [user?.id, url, playingAs, closeFor]); // eslint-disable-line react-hooks/exhaustive-deps
  const endTrial = useCallback(() => { if (document.fullscreenElement) void document.exitFullscreen(); setUrl(null); setTrialEnd(null); setTrialDone(true); void reload(); }, [reload]);
  useEffect(() => {
    if (trialEnd === null) return;
    const i = setInterval(() => { setTick((n) => n + 1); if (Date.now() >= trialEnd + 4000) endTrial(); }, 1000);
    return () => clearInterval(i);
  }, [trialEnd, endTrial]);

  // Back from checkout: confirm the session so access does not wait for the webhook.
  useEffect(() => {
    const paid = query().get('paid'); if (!paid) return;
    navigate(`/g/${slug}`, true);
    if (!user) return;
    api('/billing/confirm', { body: { session_id: paid } }).then(() => { toast(t('Purchase complete. Enjoy the game.', '购买成功，祝你玩得开心。')); void reload(); }, (e) => toast((e as Error).message, true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { markSeen(slug); }, [slug]);
  // Opened from a game's own address (?play=1): start at once for whoever is signed in here (a visitor signs in first, unless guests may play). Only where
  // nothing has to be asked first (an adults-only warning, buying); otherwise the page shows what is needed.
  const auto = useRef(query().get('play') === '1');
  // A friend's invite or a join from the friends panel (?join=…, or handed over while this page is open): the game is
  // started with it in gcp_join, where the SDK reads it (GCP.launch.join) to seat the player in the friend's match.
  const joinRef = useRef<string | null>(query().get('join'));
  useEffect(() => onLaunch((s, j) => {
    if (s !== slug || !data) return false;
    joinRef.current = encodeJoin(j);
    if (url) { setUrl(null); setTimeout(() => startRef.current(), 50); } else startRef.current();
    return true;
  }), [slug, data, url]);
  // Friends see this game, and for how long, while it runs for a signed-in player.
  const playTitle = data?.game ? local(data.game, 'title') : undefined;
  useEffect(() => { setActivity(url && user && playingAs && !playingAs.guest && playTitle ? { slug, title: playTitle } : null); }, [url, user?.id, playingAs, slug, playTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setActivity(null), []);
  // Continue (the default once the player has progress here) opens the game with GCP.launch.continue, so it can load the
  // saved run; "Start from the title screen" opens it without. Kept in a ref so the adult and compatibility gates keep it.
  const wantCont = useRef(query().get('continue') !== '0');
  useEffect(() => {
    if (!auto.current || !data) return; auto.current = false;
    navigate(`/g/${slug}`, true);
    const g = data.game, free = g.price_cents === 0 || data.owned, guest = !user && config.settings.require_login_to_play === false && g.price_cents === 0;
    if (g.status !== 'live' || !free) return;
    // Signed out where sign-in is required: straight to sign-in, which brings the player back here to start the game.
    if (!user && !guest) { navigate(loginUrl(`/g/${slug}?play=1`), true); return; }
    if (!(data.mature?.length || g.mature?.length)) startRef.current();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data?.my_review) { setRating(data.my_review.rating); setBody(data.my_review.body || ''); } }, [data?.my_review]);

  if (error && !data) return <div className="wrap page">{error.status === 404 ? <EmptyState title={t('This game is not available', '该游戏暂不可用')} action={<Button to="/">{t('Browse games', '浏览游戏')}</Button>}>{t('It may have been taken offline by its creator.', '它可能已被创作者下线。')}</EmptyState> : <Fail error={error} retry={reload} />}</div>;
  if (loading && !data) return <GameSkeleton />;
  const g = data.game, live = g.status === 'live', paid = g.price_cents > 0, locked = paid && !data.owned;
  const trial = locked ? data.trial as { minutes: number; used_seconds: number; remaining_seconds: number; over: boolean } | null : null;
  const canTry = !!trial && !trial.over, leftMin = trial ? Math.max(1, Math.ceil(trial.remaining_seconds / 60)) : 0, fresh = !!trial && trial.used_seconds === 0;
  const left = trialEnd !== null ? Math.max(0, (trialEnd - Date.now()) / 1000) : 0; void tick;

  // Every game needs an account unless the admin switches "Require login to play" off, which opens free games to guests (the server enforces it).
  const guestOk = !user && config.settings.require_login_to_play === false && g.price_cents === 0;
  const mature: string[] = data.mature?.length ? data.mature : g.mature || [], adult = mature.length > 0;
  const play = (confirmed = adultOk) => {
    if (!user && !guestOk) return navigate(loginUrl(`/g/${slug}?play=1`));
    if (adult && !confirmed) { setAdultGate(true); return; }
    if (user && cv?.verdict === 'no') { setGate(true); return; }
    start(confirmed);
  };
  startRef.current = () => play();
  const confirmAdult = () => { setAdultOk(true); setAdultGate(false); play(true); };
  const start = (confirmed = adultOk) => {
    setGate(false);
    if (!user && !guestOk) return navigate(loginUrl(`/g/${slug}?play=1`));
    stage.current?.enterOnPhone();   // phones and tablets start in fullscreen; in the click itself, or the browser refuses
    void act('play', async () => { const r = await api<{ url: string; session: string; clock?: string; trial?: { remaining_seconds: number }; player?: { id: string; name: string; guest: boolean } }>(`/games/${slug}/play`, { method: 'POST', ...(adult ? { body: { confirm_mature: confirmed } } : {}) }); session.current = r.session; ticket.current = r.clock || null; setTrialDone(false); setEnded(null); setPlayingAs(r.player || null); setTrialEnd(r.trial ? Date.now() + r.trial.remaining_seconds * 1000 : null); const j = joinRef.current; joinRef.current = null; setUrl(withJoin(withLang(r.url, wantCont.current && !!data.continue && !j), j)); rememberPlay({ slug: g.slug, title: g.title, cover: adult ? null : g.cover || g.screenshot || null, lang: g.lang, i18n: adult ? undefined : g.i18n }); }).then((ok) => { if (!ok) stage.current?.exit(); });
  };
  const buy = () => {
    if (!user) return navigate(loginUrl());
    void act('buy', async () => { const r = await api<{ url: string }>(`/games/${slug}/buy`, { method: 'POST' }); location.href = r.url; });
  };
  // The library: a free game is added (or removed) here; a paid one is in it from the moment it is bought.
  const inLibrary = data.library as 'bought' | 'added' | null;
  const toggleLibrary = () => act('lib', async () => { await api(`/me/library/${slug}`, { method: inLibrary ? 'DELETE' : 'POST' }); await reload(); },
    inLibrary ? t('Removed from your library. Your progress is kept.', '已从游戏库移除，进度会保留。') : t('Added to your library.', '已加入游戏库。'));
  const review = () => act('review', async () => { await api(`/games/${slug}/reviews`, { body: { rating, body } }); await reload(); }, t('Thanks. Your review is saved.', '感谢，评价已保存。'));
  const total = data.rating_dist.reduce((a: number, b: number) => a + b, 0);
  const canReview = !!user && !data.is_owner && (data.played || !config.settings.review_requires_play);

  const meta = data.meta as GameMeta | null | undefined, listings = offeredListings(g.lang || 'en', Object.keys(g.listing_i18n || {}), null) as Lang[];
  const title = local(g, 'title'), tagline = blurb({ title, tagline: local(g, 'tagline') }), description = local(g, 'description'), controls = local(g, 'controls');
  const genre = g.tags?.[0] as string | undefined, R = RARITY[rarity(g)], h = genre ? genreHue(genre) : 350;
  const tryLabel = fresh || !user ? t('Try free · {minutes} min', '免费试玩 · {minutes} 分钟', { minutes: trial?.minutes ?? 0 }) : t('Continue trial · {left} min left', '继续试玩 · 剩 {left} 分钟', { left: leftMin });
  const cont = !locked && live && user ? data.continue as { last_played: number; saved_at: number | null; resume: { label: string; detail?: string; progress?: number } | null } | null : null;
  const toStage = (c = true) => { wantCont.current = c; play(); document.querySelector('.stage')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  const cta = !live ? null : locked
    ? <><Button variant="primary" size="lg" block onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Buy', '购买')} · {price(g.price_cents)}</Button>{canTry && !url && <Button size="lg" block onClick={() => toStage()} disabled={busy === 'play'}>{tryLabel}</Button>}{config.payments && <SoldBy />}</>
    : <><Button variant="primary" size="lg" block onClick={() => toStage()} disabled={busy === 'play' || !!url}>{url ? t('Playing', '游玩中') : <><i className="play-tri" aria-hidden="true" />{cont ? t('Continue', '继续游戏') : t('Play now', '立即游玩')}</>}</Button>
      {cont && !url && <p className="gp-resume"><span className="clip">{resumeLine(cont)}</span>{cont.resume?.progress != null && <span className="cont-bar" aria-hidden="true"><b style={{ width: `${Math.round(cont.resume.progress * 100)}%` }} /></span>}<button type="button" className="linkish" onClick={() => toStage(false)}>{t('Start from the title screen', '从标题画面开始')}</button></p>}</>;

  return (
    <div className="gpage" style={{ '--h': h, '--rc': R.color } as CSSProperties}>
      <div className="wrap page">
        <nav className="crumbs" aria-label={t('Breadcrumb', '导航路径')}>
          <Link to="/">{t('Store', '商店')}</Link><i>/</i>
          {genre && <><Link to={`/c/${encodeURIComponent(genre)}`}>{genreName(genre)}</Link><i>/</i></>}
          <span className="clip">{title}</span>
        </nav>
        <header className="gp-head">
          <div className="grow"><h1>{title}</h1>{tagline && <p className="lede">{tagline}</p>}</div>
          <div className="gp-head-r">{meta?.rating && <a href="#at-a-glance" className="age-link"><AgeBadge age={meta.rating.age} /></a>}{rarity(g) !== 'common' && <span className="rar-pill" title={rarityHint()}>{R.name()}</span>}{!!g.playing && <span className="live-pill big"><i className="live-dot" aria-hidden="true" />{num(g.playing)} {t('playing now', '人正在玩')}</span>}</div>
        </header>

        {adult && (
          <div className="mature-note" role="note">
            <AgeBadge age={18} />
            <div className="stack s"><b>{t('Adults only', '仅限成人')} · {mature.map(matureName).join(' · ')}</b><span className="mute fs-sm">{t('Its creator declared this content, and the platform checked it when the game was reviewed. You will be asked to confirm that you are 18 or older before it starts.', '作者已声明这些内容，平台在审核时也做了检查。开始游戏前，你需要确认自己已年满 18 岁。')}</span></div>
          </div>
        )}
        {ended && !url && (
          <div className="gp-ended"><Notice tone="info" title={t('The game was closed', '游戏已关闭')} actions={<Button size="sm" variant="primary" onClick={() => { setEnded(null); play(); }}>{t('Play again', '重新开始')}</Button>}>
            {ended === 'signed_in' ? t('You signed in, so the guest session ended. Play again to continue on your account.', '你已登录，访客会话已结束。重新开始即可在你的账号上继续。')
              : ended === 'signed_out' ? t('This browser signed out or switched accounts, so the game was closed. Its progress stays with the account it was played on.', '此浏览器已退出登录或切换了账号，游戏已关闭。进度保留在游玩时使用的账号中。')
              : t('The play session ended. Play again to start a new one.', '游玩会话已结束。重新开始即可开启新会话。')}
          </Notice></div>
        )}
        {url && trialEnd !== null && trial && (
          <div className="trial-bar ink" role="status">
            <span>{t('Free trial', '免费试玩')}</span>
            <b className={'tb-left' + (left < 60 ? ' low' : '')}>{clock(left)}</b>
            <span className="trial-meter" aria-hidden="true"><b style={{ width: `${Math.min(100, (left / (trial.minutes * 60)) * 100)}%` }} /></span>
            <span className="mute">{t('left', '剩余')}</span>
            <Button size="sm" variant="primary" onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Buy', '购买')} · {price(g.price_cents)}</Button>
          </div>
        )}
        <div className="gp-top">
          <Stage social={!!user} ctl={stage} poster={shown(g).cover || g.screenshot} blur={adult && !adultOk} seed={g.slug} url={url} starting={busy === 'play'} onTrialOver={endTrial} onSessionEnded={onSessionEnded} onQuit={quitGame} orientation={data.compat?.requirements?.orientation} controls={data.controls} badge={url && trialEnd !== null ? clock(left) : undefined}>
            <div className="stack l" style={{ justifyItems: 'center' }}>
              {adultGate ? <MatureGate cats={mature} onConfirm={confirmAdult} onCancel={() => setAdultGate(false)} /> : gate && cv ? <CompatGate v={cv} onPlay={() => start()} onCancel={() => setGate(false)} /> : !live ? <><Badge tone="accent">{t('Offline', '已下线')}</Badge><p className="mute">{t('This game is not live right now.', '该游戏目前未上线。')}</p></>
                : locked && canTry ? <>
                  <PlayButton onClick={() => play()} disabled={busy === 'play'}>{busy === 'play' ? t('Starting…', '启动中…') : fresh || !user ? t('Try it free', '免费试玩') : t('Continue trial', '继续试玩')}</PlayButton>
                  <span className="mute fs-sm">{!user ? t('Sign in to start a {minutes}-minute free trial.', '登录即可开始 {minutes} 分钟免费试玩。', { minutes: trial!.minutes }) : fresh ? (trial!.minutes === 1 ? t('1 minute free, then {price} to keep playing.', '免费 1 分钟，之后 {price} 即可继续游玩。', { price: price(g.price_cents) }) : t('{minutes} minutes free, then {price} to keep playing.', '免费 {minutes} 分钟，之后 {price} 即可继续游玩。', { minutes: trial!.minutes, price: price(g.price_cents) })) : trial!.minutes === 1 ? t('Under a minute of your free minute left.', '1 分钟免费试玩即将用完。') : t('{left} of {minutes} free minutes left.', '免费 {minutes} 分钟还剩 {left} 分钟。', { left: leftMin, minutes: trial!.minutes })}</span>
                  <Button size="sm" variant="ghost" onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Or buy now', '或直接购买')} · {price(g.price_cents)}</Button>
                </>
                : locked ? <>{trial?.over && <b>{trialDone ? t('Your free trial has ended', '免费试玩已结束') : t('You have used your {minutes}-minute free trial', '你已用完 {minutes} 分钟免费试玩', { minutes: trial.minutes })}</b>}<PlayButton buy onClick={buy} disabled={busy === 'buy' || !config.payments}>{t('Buy', '购买')} · {price(g.price_cents)}</PlayButton><span className="mute fs-sm">{config.payments ? trial?.over ? t('Buy it to keep playing. Your saves are kept.', '购买后即可继续游玩，存档会保留。') : t('One payment. Play as much as you like.', '一次购买，畅玩无限。') : t('Purchases are not open yet on this platform.', '平台暂未开放购买。')}</span></>
                : <><PlayButton onClick={() => { wantCont.current = true; play(); }} disabled={busy === 'play'}>{busy === 'play' ? t('Starting…', '启动中…') : cont ? t('Continue', '继续游戏') : t('Play', '开始游戏')}</PlayButton>{cont && <span className="mute fs-sm stage-resume">{resumeLine(cont)}</span>}{!user && <span className="mute fs-sm">{guestOk ? t('Playing as a guest. Sign in to keep your progress on every device.', '正在以访客身份游玩。登录后进度可在所有设备上保留。') : t('Sign in to play. It takes a few seconds.', '登录后即可游玩，只需几秒。')}</span>}</>}
            </div>
          </Stage>
          <InstallTip hidden={!!url || busy === 'play'} />
          <aside className="gp-cap">
            {live ? (
              <div className="gp-buy">
                <span className="gp-buy-h">{locked ? t('Buy {title}', '购买 {title}', { title }) : t('Play {title}', '游玩 {title}', { title })}</span>
                <div className="gp-price-row"><PriceTag g={g} className="gp-price" /><SaleTag g={g} />{trial && <span className="trial-tag">{trial.over ? t('Free trial used', '已用完免费试玩') : trialLabel(trial.minutes)}</span>}{paid && data.owned && !data.is_owner && <Badge tone="good">{t('Owned', '已拥有')}</Badge>}</div>
                {locked && saleOn(g) && <p className="gp-sale-ends">{saleEnds(saleOn(g)!.ends_at)} · {t('then {price}', '之后恢复 {price}', { price: price(saleOn(g)!.regular_cents) })}</p>}
                <div className="gp-buy-act">{cta}</div>
                {user && (inLibrary === 'bought' ? <p className="gp-buy-note gp-lib"><Link to="/library">{t('In your library', '已在你的游戏库中')} →</Link></p>
                  : !paid ? <div className="gp-lib"><Button size="sm" variant="ghost" block onClick={toggleLibrary} disabled={busy === 'lib'} aria-pressed={!!inLibrary}>{inLibrary ? <>✓ {t('In your library', '已在游戏库中')}</> : <>+ {t('Add to library', '加入游戏库')}</>}</Button>{inLibrary && <Link to="/library" className="fs-sm">{t('Open library', '打开游戏库')}</Link>}</div> : null)}
                <p className="gp-buy-note">{url && playingAs ? (playingAs.guest ? t('Playing as a guest on this browser.', '正在以访客身份在此浏览器游玩。') : t('Playing as {name}. Progress saves to this account.', '正在以 {name} 的身份游玩，进度保存到该账号。', { name: playingAs.name })) : t('Runs in your browser. Nothing to install.', '在浏览器中运行，无需安装。')}</p>
                {data.refund && !data.is_owner && <RefundBox st={data.refund as RefundState} title={title} onDone={reload} />}
                {data.compat && <a href="#compatibility" className="cpill-link"><CompatPill v={cv} /></a>}
                {meta && <a href="#languages" className="cpill-link"><LangPill l={meta.languages} /></a>}
              </div>
            ) : <div className="gp-buy"><Badge tone="accent">{t('Offline', '已下线')}</Badge><p className="gp-buy-note">{t('This game is not live right now.', '该游戏目前未上线。')}</p></div>}
            <dl className="gp-facts">
              <div><dt>{t('Players say', '玩家评价')}</dt><dd><Verdict g={g} full /></dd></div>
              {meta?.rating && <div><dt>{t('Age rating', '年龄分级')}</dt><dd>{ageLabel(meta.rating.age)}</dd></div>}
              {meta?.players && <div><dt>{t('Players', '玩家')}</dt><dd>{playersText(meta.players)}</dd></div>}
              <div><dt>{t('Released', '发布')}</dt><dd>{date(g.published_at)}</dd></div>
              <div><dt>{t('Creator', '创作者')}</dt><dd><Link to={`/browse?by=${encodeURIComponent(g.owner_id)}&who=${encodeURIComponent(g.author)}`} className="sig">{g.author}</Link></dd></div>
            </dl>
            {g.tags.length > 0 && <div className="gp-tags">{g.tags.map((x: string) => <Link key={x} to={`/c/${encodeURIComponent(x)}`} className="gtag" style={{ '--h': genreHue(x) } as CSSProperties}>{genreName(x)}</Link>)}</div>}
            <div className="seal"><i aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.3 5 8.6l4.5-5" /></svg></i><b>{t('Verified playable', '已验证可玩')}</b><span>{t('Every game here was run in a real browser and checked for playability before it went live.', '这里的每款游戏在上线前都在真实浏览器中运行并通过了可玩性验证。')}</span></div>
          </aside>
        </div>

        {data.is_owner && <div className="gp-own"><Notice actions={<Button size="sm" to={`/console/p/${g.id}`}>{t('Open in console', '在控制台打开')}</Button>}>{t('This is your game. Players see this page.', '这是你的游戏，玩家看到的就是这个页面。')}</Notice></div>}

        <div className="gp">
          <div className="stack xl">
            {(description || controls) && (
              <section className="stack l">
                <SectionHead title={t('About this game', '关于这款游戏')} />
                {description && <div className="prose">{description}</div>}
                {controls && <div className="gp-controls"><span className="eyebrow">{t('Controls', '操作方式')}</span><div className="prose">{controls}</div></div>}
              </section>
            )}

            {meta && <Glance meta={meta} tags={g.tags} />}
            {data.compat && <CompatSection c={data.compat} v={cv} />}
            {meta && <LanguagesSection l={meta.languages} declared={meta.languages_declared} listings={listings} />}

            <section className="stack l">
              <SectionHead title={t('Ratings and reviews', '评分与评价')} note={g.rating_count ? <Verdict g={g} full /> : undefined} />
              {canReview ? (
                <Card pad>
                  <b>{data.my_review ? t('Your review', '你的评价') : t('Rate this game', '为这款游戏评分')}</b>
                  <div className="rate" role="radiogroup" aria-label={t('Rating', '评分')}>{[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n}`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}><Star /></button>)}</div>
                  <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder={t('What did you like? What would make it better? (optional)', '喜欢哪些地方？哪里还可以更好？（选填）')} />
                  <div><Button variant="primary" disabled={!rating || busy === 'review'} onClick={review}>{data.my_review ? t('Update review', '更新评价') : t('Post review', '发布评价')}</Button></div>
                </Card>
              ) : !data.is_owner && <p className="mute">{!user ? <><Link to={loginUrl()} className="sig">{t('Sign in', '登录')}</Link> {t('and play to leave a review.', '并游玩后即可评价。')}</> : t('Play for at least {n} seconds to leave a review.', '游玩至少 {n} 秒后即可评价。', { n: config.settings.play_min_seconds })}</p>}
              {data.reviews.length ? <div className="reviews">{data.reviews.map((r: any, i: number) => (
                <div className="review" key={i}>
                  <div className="row"><span className="rv-avatar">{String(r.name || '?').slice(0, 1).toUpperCase()}</span><b>{r.name}</b>{r.mine && <Badge dot={false}>{t('You', '你')}</Badge>}<span className={'rv-score' + (r.rating >= 4 ? ' up' : r.rating <= 2 ? ' down' : '')}>{r.rating >= 4 ? '▲' : r.rating <= 2 ? '▼' : '◆'} {r.rating}/5</span><span className="dim right fs-sm">{ago(r.at)}</span></div>
                  {r.body && <p className="prose">{r.body}</p>}
                </div>))}</div> : <EmptyState compact title={t('No reviews yet', '还没有评价')}>{t('Be the first to say something.', '来做第一个吧。')}</EmptyState>}
            </section>
            {user && live && !data.is_owner && <ReportGame slug={slug} />}
          </div>

          <aside className="stack l gp-side">
            <StatGrid>
              <Stat label={t('Plays', '游玩次数')} value={num(g.plays)} />
              <Stat label={t('Playing now', '正在玩')} value={num(g.playing || 0)} tone={g.playing ? 'accent' : undefined} />
              <Stat label={t('Time played', '累计时长')} value={playTime(g.minutes * 60)} />
              <Stat label={t('Rating', '评分')} value={g.rating != null ? `★ ${g.rating.toFixed(1)}` : '—'} />
            </StatGrid>
            {user && live && <MyProgress slug={slug} playing={!!url} />}
            <Card title={t('What players think', '玩家怎么看')} aside={count(g.rating_count, 'rating', 'ratings', '个评分')} pad>
              <div className="dist">{[5, 4, 3, 2, 1].map((n) => <div key={n}><span>{n}★</span><i><b style={{ width: `${total ? (data.rating_dist[n - 1] / total) * 100 : 0}%` }} /></i><span className="num">{data.rating_dist[n - 1]}</span></div>)}</div>
            </Card>
            <Card title={t('Details', '详细信息')} pad>
              <KeyValue items={[
                [t('Rarity', '稀有度'), <span className="rar-pill sm" title={rarityHint()}>{R.name()}</span>],
                [t('Version', '版本'), <span className="mono">v{g.version ?? '—'}</span>],
                [t('Updated', '更新于'), date(g.updated_at)],
                [t('Released', '发布于'), date(g.published_at)],
                ...(meta ? [[t('Languages', '语言'), <a href="#languages" className="sig">{meta.languages.supported.length === 1 ? t('1 language', '1 种语言') : t('{n} languages', '{n} 种语言', { n: meta.languages.supported.length })}</a>] as [string, ReactNode]] : []),
                [t('Runs on', '运行平台'), data.compat ? <a href="#compatibility" className="sig">{t('See compatibility', '查看兼容性')}</a> : t('Any modern browser', '任意现代浏览器')],
              ]} />
            </Card>
            {g.open_implementation && <p className="dim fs-sm">{t('Open implementation: its creator shares how it is built as a build skill, never its code.', '开放实现：作者以构建技能的形式分享它的制作方式，但不包括代码。')} <Link to={`/creator-store/${g.slug}`} className="sig">{g.skill_price_cents > 0 ? t('Get the build skill', '获取构建技能') : t('Copy the build skill', '复制构建技能')} →</Link></p>}
          </aside>
        </div>
        <MoreFrom owner={g.owner_id} author={g.author} slug={g.slug} />
        <MoreLike tag={genre} slug={g.slug} />
      </div>
    </div>
  );
}

/** "Report this game": something players should not be shown (a fake sign-in, a request for payment details, someone
    else's work). Goes to the platform's admins with the game's other flags. */
function ReportGame({ slug }: { slug: string }) {
  const { act, busy } = useAct();
  const [open, setOpen] = useState(false), [reason, setReason] = useState(''), [detail, setDetail] = useState(''), [sent, setSent] = useState(false);
  if (sent) return <p className="mute fs-sm">{t('Thanks. The platform team will look at your report.', '感谢，平台团队会查看你的举报。')}</p>;
  if (!open) return <p className="fs-sm"><button type="button" className="sig" onClick={() => setOpen(true)}>{t('Report this game', '举报这款游戏')}</button></p>;
  const send = () => act('report', async () => { await api(`/games/${slug}/report`, { body: { reason, detail } }); setSent(true); });
  return (
    <Card pad>
      <b>{t('Report this game', '举报这款游戏')}</b>
      <Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t('What is wrong?', '有什么问题？')}>
        <option value="">{t('What is wrong?', '有什么问题？')}</option>
        <option value="phishing">{t('It asks for my password or payment details', '它索要我的密码或付款信息')}</option>
        <option value="malicious">{t('It does something harmful or sends me somewhere else', '它有害，或把我带到别的地方')}</option>
        <option value="stolen">{t('It copies someone else\'s work', '它抄袭了别人的作品')}</option>
        <option value="offensive">{t('Its content is offensive or not as rated', '内容冒犯，或与年龄分级不符')}</option>
        <option value="broken">{t('It does not work', '无法正常运行')}</option>
        <option value="other">{t('Something else', '其他问题')}</option>
      </Select>
      <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} placeholder={t('What happened? (optional)', '发生了什么？（选填）')} />
      <div className="row"><Button variant="primary" disabled={!reason || busy === 'report'} onClick={send}>{t('Send report', '提交举报')}</Button><Button onClick={() => setOpen(false)}>{t('Cancel', '取消')}</Button></div>
    </Card>
  );
}
