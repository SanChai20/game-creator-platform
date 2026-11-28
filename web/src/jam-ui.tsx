// Game jams and festivals (src/jams.js): the jams page (/jams) with the host form, one event's page (/jams/<slug>)
// with its entries, the entry picker, voting and the results, and the store's shelf for the featured event.
import { useEffect, useState } from 'react';
import { api, date, Fail, GameTile, Link, loginUrl, navigate, num, t, useAct, useApp, useData, type GameCard } from './lib';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Segmented, Textarea } from './ui';
import { SectionHead, Shelf } from './store';
import './follow.css';

type Phase = 'upcoming' | 'entries' | 'voting' | 'results' | 'running' | 'ended' | 'cancelled';
interface Jam {
  id: string; slug: string; kind: 'jam' | 'festival'; title: string; description: string | null; theme: string | null; theme_hidden: boolean;
  criteria: string[]; new_only: boolean; starts_at: number; ends_at: number; voting_ends_at: number | null; featured: boolean;
  host: { id: string; name: string }; phase: Phase; is_host: boolean; entries?: number;
}
interface Entry { game: GameCard; entrant: string; voters: number; mine: boolean; my_scores?: Record<string, number> | null; played?: boolean; scores?: Record<string, number>; overall?: number | null; rank?: number | null }

const phaseLabel = (j: Jam) => ({
  upcoming: t('Starts {date}', '{date} 开始', { date: date(j.starts_at) }),
  entries: t('Entries open until {date}', '投稿截止 {date}', { date: date(j.ends_at) }),
  voting: t('Voting until {date}', '投票截止 {date}', { date: date(j.voting_ends_at || j.ends_at) }),
  results: t('Results are in', '结果已出炉'),
  running: t('On now, until {date}', '进行中，至 {date}', { date: date(j.ends_at) }),
  ended: t('Ended', '已结束'),
  cancelled: t('Cancelled', '已取消'),
}[j.phase]);
const tone = (p: Phase) => (p === 'entries' || p === 'voting' || p === 'running' ? 'good' : p === 'upcoming' ? 'accent' : undefined);

function JamRow({ j }: { j: Jam }) {
  return (
    <Link to={`/jams/${j.slug}`} className="jam-row">
      <div className="grow stack s">
        <div className="row wrap-row"><b>{j.title}</b>{j.featured && <Badge tone="accent">{t('HearthCade event', 'HearthCade 官方活动')}</Badge>}<Badge>{j.kind === 'festival' ? t('Festival', '游戏节') : t('Jam', '游戏创作节')}</Badge></div>
        <span className="dim fs-sm">{j.theme ? t('Theme: {theme}', '主题：{theme}', { theme: j.theme }) + ' · ' : ''}{t('Hosted by {name}', '主办：{name}', { name: j.host.name })} · {j.entries === 1 ? t('1 entry', '1 个参赛作品') : t('{n} entries', '{n} 个参赛作品', { n: num(j.entries || 0) })}</span>
      </div>
      <Badge tone={tone(j.phase)}>{phaseLabel(j)}</Badge>
    </Link>
  );
}

const toLocal = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const fromLocal = (s: string) => new Date(s).getTime();

function HostForm({ onDone }: { onDone: (slug: string) => void }) {
  const { busy, act } = useAct(), day = 86400000, start = Math.ceil(Date.now() / 3600000) * 3600000 + day;
  const [f, setF] = useState({ kind: 'jam' as 'jam' | 'festival', title: '', theme: '', description: '', criteria: 'Fun\nOriginality\nPresentation\nTheme', starts: toLocal(start), ends: toLocal(start + 2 * day), voting: toLocal(start + 9 * day), new_only: true });
  const go = () => act('host', async () => {
    const r = await api<{ slug: string }>('/jams', { body: { kind: f.kind, title: f.title, theme: f.theme, description: f.description, criteria: f.criteria.split('\n').map((x) => x.trim()).filter(Boolean), starts_at: fromLocal(f.starts), ends_at: fromLocal(f.ends), voting_ends_at: f.kind === 'jam' ? fromLocal(f.voting) : undefined, new_only: f.new_only } });
    onDone(r.slug);
  }, t('Your event is up.', '活动已发布。'));
  return (
    <Card title={t('Host an event', '主办活动')} pad>
      <div className="stack s">
        <Segmented value={f.kind} onChange={(k) => setF({ ...f, kind: k })} options={[['jam', t('Jam', '游戏创作节')], ['festival', t('Festival', '游戏节')]]} />
        <p className="mute fs-sm">{f.kind === 'jam' ? t('A jam has a theme, kept secret until it starts. Creators make a game for it, then players who played the entries score them on your criteria.', '游戏创作节有一个主题，开始前保密。创作者为它制作游戏，然后玩过参赛作品的玩家按你的评分项打分。') : t('A festival shows live and coming soon games together for a few days, with no voting.', '游戏节会在几天内集中展示已上线和即将推出的游戏，不设投票。')}</p>
        <Input value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={t('Title', '标题')} aria-label={t('Title', '标题')} />
        {f.kind === 'jam' && <Input value={f.theme} maxLength={80} onChange={(e) => setF({ ...f, theme: e.target.value })} placeholder={t('Theme (hidden until it starts)', '主题（开始前隐藏）')} aria-label={t('Theme', '主题')} />}
        <Textarea rows={3} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={t('Rules, prizes, anything entrants should know', '规则、奖品以及参与者需要知道的事')} aria-label={t('Description', '说明')} />
        <div className="row wrap-row">
          <label className="stack s fs-sm">{t('Starts', '开始')}<Input type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></label>
          <label className="stack s fs-sm">{f.kind === 'jam' ? t('Entries close', '投稿截止') : t('Ends', '结束')}<Input type="datetime-local" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></label>
          {f.kind === 'jam' && <label className="stack s fs-sm">{t('Voting closes', '投票截止')}<Input type="datetime-local" value={f.voting} onChange={(e) => setF({ ...f, voting: e.target.value })} /></label>}
        </div>
        {f.kind === 'jam' && <>
          <label className="stack s fs-sm">{t('Criteria, one per line (up to 5)', '评分项，每行一个（最多 5 个）')}<Textarea rows={4} value={f.criteria} onChange={(e) => setF({ ...f, criteria: e.target.value })} /></label>
          <label className="row fs-sm"><input type="checkbox" checked={f.new_only} onChange={(e) => setF({ ...f, new_only: e.target.checked })} />{t('Only games made for the jam', '只接受为本次活动制作的游戏')}</label>
        </>}
        <div><Button variant="primary" onClick={() => void go()} disabled={busy === 'host' || !f.title.trim() || (f.kind === 'jam' && !f.theme.trim())}>{t('Publish event', '发布活动')}</Button></div>
      </div>
    </Card>
  );
}

/** /jams: what is on and coming, the latest results, and the host form for licensed creators. */
export function JamsPage() {
  const { user } = useApp();
  const { data, error, reload } = useData<{ current: Jam[]; past: Jam[] }>('/jams');
  const [host, setHost] = useState(false);
  useEffect(() => { document.title = t('Jams and festivals', '游戏创作节与游戏节'); }, []);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  const canHost = !!user && (user.creator || user.role === 'admin');
  return (
    <div className="wrap page stack l">
      <PageHeader eyebrow={t('Events', '活动')} title={t('Jams and festivals', '游戏创作节与游戏节')} sub={t('Make a game on a theme in a few days, or find new games together for a festival.', '在几天内围绕主题制作游戏，或在游戏节一起发现新游戏。')} />
      {canHost && !host && <div><Button onClick={() => setHost(true)}>{t('Host an event', '主办活动')}</Button></div>}
      {host && <HostForm onDone={(slug) => navigate(`/jams/${slug}`)} />}
      {!data ? <div aria-busy="true" /> : <>
        <section className="stack">
          <SectionHead title={t('On now and coming up', '进行中与即将开始')} />
          {data.current.length ? <div className="stack s">{data.current.map((j) => <JamRow key={j.id} j={j} />)}</div> : <EmptyState title={t('Nothing on right now', '目前没有活动')}>{t('Check back soon, or host one.', '稍后再来看看，或者自己主办一个。')}</EmptyState>}
        </section>
        {!!data.past.length && <section className="stack">
          <SectionHead title={t('Recently ended', '最近结束')} />
          <div className="stack s">{data.past.map((j) => <JamRow key={j.id} j={j} />)}</div>
        </section>}
      </>}
    </div>
  );
}

function VoteBox({ slug, e, criteria, onDone }: { slug: string; e: Entry; criteria: string[]; onDone: () => void }) {
  const { busy, act } = useAct(), [s, setS] = useState<Record<string, number>>(e.my_scores || {});
  const done = criteria.every((c) => s[c]);
  const send = () => act('vote:' + e.game.id, async () => { await api(`/jams/${slug}/votes/${e.game.id}`, { method: 'PUT', body: { scores: s } }); onDone(); }, t('Vote saved.', '投票已保存。'));
  return (
    <div className="stack s jam-vote">
      {criteria.map((c) => (
        <div key={c} className="row"><span className="fs-sm grow">{c}</span>
          <span className="row pt-fun" role="radiogroup" aria-label={c}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={s[c] === n} className={(s[c] || 0) >= n ? 'on' : ''} onClick={() => setS({ ...s, [c]: n })} aria-label={t('{n} of 5', '{n}/5', { n })}>★</button>)}</span>
        </div>
      ))}
      <div><Button size="sm" variant="primary" onClick={() => void send()} disabled={!done || busy === 'vote:' + e.game.id}>{e.my_scores ? t('Update vote', '更新投票') : t('Vote', '投票')}</Button></div>
    </div>
  );
}

/** /jams/<slug>: one event. */
export function JamPage({ slug }: { slug: string }) {
  const { user } = useApp(), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<{ jam: Jam; entries: Entry[]; eligible?: { id: string; title: string }[]; limits: { min_votes: number } }>(`/jams/${encodeURIComponent(slug)}`);
  const [pick, setPick] = useState('');
  useEffect(() => { if (data) document.title = data.jam.title; }, [data]);
  if (error && !data) return <div className="wrap page">{error.status === 404 ? <EmptyState title={t('No such event', '找不到该活动')} action={<Button to="/jams">{t('All jams and festivals', '全部活动')}</Button>} /> : <Fail error={error} retry={reload} />}</div>;
  if (loading || !data) return <div className="wrap page" aria-busy="true" />;
  const j = data.jam, open = j.kind === 'festival' ? j.phase === 'upcoming' || j.phase === 'running' : j.phase === 'entries';
  const enter = () => act('enter', async () => { await api(`/jams/${slug}/entries`, { body: { project: pick } }); setPick(''); await reload(); }, t('Your game is in.', '你的游戏已参加。'));
  const leave = (pid: string) => act('leave', async () => { await api(`/jams/${slug}/entries/${pid}`, { method: 'DELETE' }); await reload(); }, t('Entry withdrawn.', '已撤回参赛。'));
  const cancel = () => act('cancel', async () => { await api(`/jams/${slug}`, { method: 'DELETE' }); await reload(); }, t('The event is cancelled.', '活动已取消。'));
  return (
    <div className="wrap page stack l">
      <div className="stack s">
        <PageHeader eyebrow={j.kind === 'festival' ? t('Festival', '游戏节') : t('Game jam', '游戏创作节')} title={j.title} sub={t('Hosted by {name}', '主办：{name}', { name: j.host.name })} />
        <div className="row wrap-row"><Badge tone={tone(j.phase)}>{phaseLabel(j)}</Badge>{j.featured && <Badge tone="accent">{t('HearthCade event', 'HearthCade 官方活动')}</Badge>}</div>
      </div>
      {j.kind === 'jam' && <Card pad><div className="stack s">
        <span className="dim fs-sm">{t('Theme', '主题')}</span>
        <b className="jam-theme">{j.theme ?? t('Revealed when the jam starts', '活动开始时公布')}</b>
        {j.is_host && j.phase === 'upcoming' && <span className="dim fs-sm">{t('Only you can see the theme until the jam starts.', '活动开始前只有你能看到主题。')}</span>}
      </div></Card>}
      <Card pad><div className="stack s">
        {j.description && <p className="pt-note">{j.description}</p>}
        <ul className="mute fs-sm jam-dates">
          <li>{t('Starts {date}', '{date} 开始', { date: date(j.starts_at) })}</li>
          <li>{j.kind === 'jam' ? t('Entries close {date}', '{date} 投稿截止', { date: date(j.ends_at) }) : t('Ends {date}', '{date} 结束', { date: date(j.ends_at) })}</li>
          {j.voting_ends_at && <li>{t('Voting closes {date}', '{date} 投票截止', { date: date(j.voting_ends_at) })}</li>}
          {j.kind === 'jam' && <li>{t('Scored on: {list}', '评分项：{list}', { list: j.criteria.join(', ') })}</li>}
          {j.kind === 'jam' && j.new_only && <li>{t('Only games created after the jam starts can enter.', '只有活动开始后创建的游戏才能参加。')}</li>}
          {j.kind === 'jam' && <li>{t('Only players who played a game can vote on it. An entry needs {n} voters to be ranked.', '只有玩过游戏的玩家才能为它投票。参赛作品需要 {n} 位投票者才会进入排名。', { n: data.limits.min_votes })}</li>}
        </ul>
        {j.is_host && j.phase !== 'results' && j.phase !== 'ended' && j.phase !== 'cancelled' && <div><Button size="sm" variant="ghost" onClick={() => void cancel()} disabled={busy === 'cancel'}>{t('Cancel event', '取消活动')}</Button></div>}
      </div></Card>
      {open && (user ? (data.eligible?.length ? (
        <Card title={t('Enter a game', '参加活动')} pad><div className="row wrap-row">
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t('Your game', '你的游戏')}><option value="">{t('Choose one of your games', '选择你的一款游戏')}</option>{data.eligible.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
          <Button variant="primary" onClick={() => void enter()} disabled={!pick || busy === 'enter'}>{t('Enter', '参加')}</Button>
        </div></Card>
      ) : null) : <div><Button to={loginUrl()}>{t('Sign in to enter or vote', '登录以参加或投票')}</Button></div>)}
      <section className="stack">
        <SectionHead title={j.phase === 'results' ? t('Results', '结果') : t('Entries', '参赛作品')} note={data.entries.length === 1 ? t('1 entry', '1 个参赛作品') : t('{n} entries', '{n} 个参赛作品', { n: num(data.entries.length) })} />
        {!data.entries.length ? <p className="mute">{t('No entries yet.', '还没有参赛作品。')}</p> : (
          <div className="grid browse-grid">{data.entries.map((e) => (
            <div key={e.game.id} className="stack s">
              {e.rank != null && <b className="jam-rank">#{e.rank}</b>}
              <GameTile g={e.game} />
              {j.phase === 'results' && <span className="dim fs-sm">{e.overall != null ? `${e.overall.toFixed(2)} · ` : ''}{t('{n} voters', '{n} 位投票者', { n: num(e.voters) })}{e.scores && Object.keys(e.scores).length ? ` · ${j.criteria.map((c) => `${c} ${e.scores![c]?.toFixed(1) ?? '–'}`).join(' · ')}` : ''}</span>}
              {j.phase === 'voting' && !e.mine && user && (e.played ? <VoteBox slug={slug} e={e} criteria={j.criteria} onDone={() => void reload()} /> : <span className="dim fs-sm">{t('Play it to vote.', '玩过后即可投票。')}</span>)}
              {j.phase === 'voting' && e.mine && <span className="dim fs-sm">{t('{n} voters so far', '目前 {n} 位投票者', { n: num(e.voters) })}</span>}
              {open && e.mine && <button type="button" className="linkish fs-sm" onClick={() => void leave(e.game.id)} disabled={busy === 'leave'}>{t('Withdraw', '撤回')}</button>}
            </div>
          ))}</div>
        )}
      </section>
    </div>
  );
}

/** The store's shelf for the featured event that is on now. Hidden when there is none or it has no games yet. */
export function JamShelf() {
  const { data } = useData<{ jam: Jam | null; games: GameCard[] }>('/jams/featured');
  if (!data?.jam || !data.games.length) return null;
  const j = data.jam;
  return <Shelf title={j.title} note={j.kind === 'jam' ? (j.theme ? t('Game jam · theme: {theme}', '游戏创作节 · 主题：{theme}', { theme: j.theme }) : t('Game jam', '游戏创作节')) : t('Festival · until {date}', '游戏节 · 至 {date}', { date: date(j.ends_at) })} to={`/jams/${j.slug}`} games={data.games} />;
}
