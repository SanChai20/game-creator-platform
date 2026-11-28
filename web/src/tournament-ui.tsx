// Tournaments (src/tournaments.js): the /tournaments page and each tournament's page for players, the game page's card,
// and the console card where a creator schedules them for a game with server-run matches.
import { useState } from 'react';
import { api, Fail, Link, loginUrl, num, t, useAct, useApp, useData } from './lib';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea } from './ui';
import { SectionHead } from './store';
import './follow.css';

interface Person { id: string; name: string; seed?: number | null }
export interface Tournament {
  id: string; slug: string; title: string; kind: 'cup' | 'bracket'; queue: string; status: 'signup' | 'running' | 'done' | 'cancelled';
  starts_at: number; ends_at: number | null; round: number; round_ends_at: number | null; round_minutes: number; max_players: number; players: number;
  prize: string | null; official: boolean; winner: Person | null; joined?: boolean;
  game?: { id: string; slug: string; title: string; cover: string | null };
}
interface Full extends Tournament {
  description: string | null; can_cancel: boolean;
  me: { joined: boolean; points?: number; wins?: number; played?: number; seed?: number | null; out_round?: number | null; next?: { round: number; opponent: Person | null; ends_at: number } };
  standings?: { rank: number; id: string; name: string; points: number; wins: number; played: number; me: boolean }[];
  rounds?: { slot: number; a: Person | null; b: Person | null; winner: string | null; decided_by: string | null }[][];
  entrants?: Person[];
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function left(ms: number) {
  const m = Math.max(0, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? t('{d}d {h}h', '{d} 天 {h} 小时', { d, h }) : h ? t('{h}h {m}m', '{h} 小时 {m} 分', { h, m: m % 60 }) : t('{m}m', '{m} 分钟', { m: m % 60 });
}
const kindName = (k: string) => (k === 'bracket' ? t('Bracket', '淘汰赛') : t('Cup', '积分杯'));
function statusLine(x: Tournament) {
  const now = Date.now();
  if (x.status === 'cancelled') return t('Cancelled', '已取消');
  if (x.status === 'done') return x.winner ? t('Won by {name}', '冠军：{name}', { name: x.winner.name }) : t('Finished', '已结束');
  if (x.status === 'signup') return t('Starts in {t}', '{t} 后开始', { t: left(x.starts_at - now) });
  if (x.kind === 'cup') return t('Ends in {t}', '{t} 后结束', { t: left((x.ends_at || now) - now) });
  return t('Round {n} · {t} left', '第 {n} 轮 · 剩 {t}', { n: x.round, t: left((x.round_ends_at || now) - now) });
}
const tone = (s: string) => (s === 'running' ? 'good' : s === 'signup' ? 'accent' : undefined) as 'good' | 'accent' | undefined;

function Row({ x }: { x: Tournament }) {
  return (
    <Link className="tm-row" to={`/tournaments/${encodeURIComponent(x.slug)}`}>
      {x.game && (x.game.cover ? <img src={x.game.cover} alt="" loading="lazy" /> : <span className="tm-fill" aria-hidden="true">{x.game.title.slice(0, 1)}</span>)}
      <span className="stack s grow" style={{ minWidth: 0 }}>
        <span className="row wrap-row"><b className="clip">{x.title}</b>{x.official && <Badge tone="accent">{t('Official', '官方')}</Badge>}{x.joined && <Badge tone="good">{t('Signed up', '已报名')}</Badge>}</span>
        <span className="dim fs-sm clip">{x.game ? `${x.game.title} · ` : ''}{kindName(x.kind)} · {x.players === 1 ? t('1 player', '1 位玩家') : t('{n} players', '{n} 位玩家', { n: num(x.players) })}{x.prize ? ` · ${x.prize}` : ''}</span>
      </span>
      <span className="tm-when fs-sm"><Badge tone={tone(x.status)}>{statusLine(x)}</Badge></span>
    </Link>
  );
}

/** /tournaments: what is on now, what is coming, and what just finished, across all games. */
export function TournamentsPage() {
  const { data, error } = useData<{ tournaments: Tournament[] }>('/tournaments');
  const groups: [string, Tournament[]][] = data ? [
    [t('On now', '进行中'), data.tournaments.filter((x) => x.status === 'running')],
    [t('Coming up', '即将开始'), data.tournaments.filter((x) => x.status === 'signup')],
    [t('Recently finished', '最近结束'), data.tournaments.filter((x) => x.status === 'done')],
  ] : [];
  return (
    <div className="wrap page stack l">
      <PageHeader title={t('Tournaments', '锦标赛')} sub={t('Cups and brackets run by game creators and the platform. Sign up, then play the game as usual: your matches count.', '由游戏创作者和平台举办的积分杯和淘汰赛。报名后照常玩游戏，你的对局就会计入。')} />
      {error && <Fail error={error} />}
      {data && !data.tournaments.length && <EmptyState title={t('No tournaments right now', '目前没有锦标赛')}>{t('Creators of multiplayer games schedule them from their console. Check back soon.', '多人游戏的创作者会在控制台里安排锦标赛，请稍后再来看看。')}</EmptyState>}
      {groups.filter(([, l]) => l.length).map(([title, l]) => (
        <section key={title} className="stack m"><SectionHead title={title} /><div className="tm-list">{l.map((x) => <Row key={x.id} x={x} />)}</div></section>
      ))}
    </div>
  );
}

function Bracket({ rounds, me }: { rounds: NonNullable<Full['rounds']>; me: string | null }) {
  const name = (p: Person | null) => (p ? `${p.seed ? `#${p.seed} ` : ''}${p.name}` : t('Bye', '轮空'));
  const label = (i: number) => (i === rounds.length - 1 && rounds[i].length === 1 ? t('Final', '决赛') : t('Round {n}', '第 {n} 轮', { n: i + 1 }));
  return (
    <div className="tm-bracket" role="list">
      {rounds.map((r, i) => (
        <div key={i} className="tm-round" role="listitem"><b className="fs-sm">{label(i)}</b>
          {r.map((m) => (
            <div key={m.slot} className="tm-match">
              {[m.a, m.b].map((p, k) => <span key={k} className={(p && m.winner === p.id ? 'win' : m.winner ? 'lost' : '') + (p && p.id === me ? ' me' : '')}>{name(p)}</span>)}
              {m.decided_by && m.decided_by !== 'match' && m.decided_by !== 'bye' && <small className="dim">{m.decided_by === 'no_show' ? t('opponent did not show', '对手未到场') : t('by seed', '按种子顺位')}</small>}
            </div>))}
        </div>))}
    </div>
  );
}

/** /tournaments/<slug>: details, sign-up, the standings or the bracket, and the player's next match. */
export function TournamentPage({ slug }: { slug: string }) {
  const { user } = useApp(), { busy, act } = useAct();
  const { data, error, reload } = useData<{ tournament: Full }>(`/tournaments/${encodeURIComponent(slug)}`);
  if (error) return <div className="wrap page"><Fail error={error} /></div>;
  if (!data) return <div className="wrap page" />;
  const x = data.tournament, now = Date.now();
  const canJoin = x.kind === 'cup' ? (x.status === 'signup' || x.status === 'running') && now < (x.ends_at || 0) : x.status === 'signup';
  const join = () => act('join', async () => { await api(`/tournaments/${encodeURIComponent(x.slug)}/join`, { method: 'POST' }); await reload(); }, t('You are signed up.', '报名成功。'));
  const leave = () => act('leave', async () => { await api(`/tournaments/${encodeURIComponent(x.slug)}/join`, { method: 'DELETE' }); await reload(); });
  const cancel = () => act('cancel', async () => { await api(`/tournaments/${encodeURIComponent(x.slug)}/cancel`, { method: 'POST' }); await reload(); }, t('The tournament is cancelled.', '锦标赛已取消。'));
  const play = x.game ? `/g/${encodeURIComponent(x.game.slug)}?play=1` : '/';
  return (
    <div className="wrap page stack l">
      <PageHeader back={{ to: '/tournaments', label: t('Tournaments', '锦标赛') }} title={x.title}
        badge={<Badge tone={tone(x.status)}>{statusLine(x)}</Badge>}
        sub={<>{x.game && <Link to={`/g/${encodeURIComponent(x.game.slug)}`} className="sig">{x.game.title}</Link>} · {kindName(x.kind)} · {x.official ? t('Run by the platform', '平台举办') : t('Run by the game\'s creator', '游戏创作者举办')}</>} />
      <div className="tm-top">
        <Card pad><div className="stack s">
          {x.description && <p className="prose">{x.description}</p>}
          <dl className="tm-facts fs-sm">
            <dt>{t('Starts', '开始')}</dt><dd>{when(x.starts_at)}</dd>
            {x.kind === 'cup' ? <><dt>{t('Ends', '结束')}</dt><dd>{x.ends_at ? when(x.ends_at) : '—'}</dd></> : <><dt>{t('Each round', '每轮时长')}</dt><dd>{t('{n} minutes', '{n} 分钟', { n: x.round_minutes })}</dd></>}
            <dt>{t('Players', '玩家')}</dt><dd>{num(x.players)} / {num(x.max_players)}</dd>
            {x.prize && <><dt>{t('Prize', '奖品')}</dt><dd>{x.prize}</dd></>}
          </dl>
          <p className="dim fs-sm">{x.kind === 'cup'
            ? t('Every match you play in this game\'s "{q}" mode while the cup runs counts: 1 point for playing, 3 more for a win.', '积分杯期间，你在这款游戏“{q}”模式中的每场对局都会计入：参赛得 1 分，获胜再得 3 分。', { q: x.queue })
            : t('Single elimination. Each round, find a match in the game\'s "{q}" mode and you meet your opponent. If time runs out, the player who showed up goes through, otherwise the higher seed.', '单败淘汰。每轮在游戏的“{q}”模式中寻找对局，就会遇到你的对手。时间到时，到场的一方晋级，否则种子顺位高者晋级。', { q: x.queue })}</p>
        </div></Card>
        <Card pad><div className="stack s">
          {!user ? <p className="fs-sm"><Link to={loginUrl(`/tournaments/${x.slug}`)} className="sig">{t('Sign in', '登录')}</Link> {t('to take part.', '后即可参赛。')}</p>
            : x.me.joined ? <>
              <b>{t('You are in', '你已报名')}</b>
              {x.kind === 'cup' && x.status !== 'signup' && <span className="fs-sm">{t('{p} points · {w} wins · {n} played', '{p} 分 · {w} 胜 · {n} 场', { p: x.me.points || 0, w: x.me.wins || 0, n: x.me.played || 0 })}</span>}
              {x.me.next && <span className="fs-sm">{t('Round {n}: you play {name}. Find a match before the round ends ({t} left).', '第 {n} 轮：你的对手是 {name}。请在本轮结束前寻找对局（剩 {t}）。', { n: x.me.next.round, name: x.me.next.opponent?.name || '', t: left(x.me.next.ends_at - now) })}</span>}
              {x.me.out_round && <span className="fs-sm dim">{t('Out in round {n}.', '在第 {n} 轮出局。', { n: x.me.out_round })}</span>}
              {x.status === 'running' && !x.me.out_round && <Button variant="primary" to={play}>{t('Play {game}', '玩 {game}', { game: x.game?.title || '' })}</Button>}
              {x.status === 'signup' && <Button size="sm" variant="ghost" onClick={() => void leave()} disabled={busy === 'leave'}>{t('Leave', '退出')}</Button>}
            </> : canJoin ? <Button variant="primary" onClick={() => void join()} disabled={busy === 'join' || x.players >= x.max_players}>{x.players >= x.max_players ? t('Full', '已满') : t('Sign up', '报名')}</Button>
            : <span className="dim fs-sm">{t('Sign-up is closed.', '报名已截止。')}</span>}
          {x.can_cancel && (x.status === 'signup' || x.status === 'running') && <Button size="sm" variant="danger" onClick={() => void cancel()} disabled={busy === 'cancel'}>{t('Cancel tournament', '取消锦标赛')}</Button>}
        </div></Card>
      </div>
      {x.standings && x.status !== 'signup' && (
        <section className="stack m"><SectionHead title={t('Standings', '积分榜')} />
          {x.standings.length ? <ol className="chal-board tm-standings">{x.standings.map((r) => <li key={r.id} className={r.me ? 'me' : ''}><span className="chal-rank">{r.rank}</span><span className="grow clip">{r.name}</span><span className="dim fs-sm">{t('{w}W {n}P', '{w}胜 {n}场', { w: r.wins, n: r.played })}</span><b className="mono">{r.points}</b></li>)}</ol>
            : <p className="mute fs-sm">{t('No matches yet.', '还没有对局。')}</p>}
        </section>)}
      {x.rounds && x.rounds.length > 0 && <section className="stack m"><SectionHead title={t('Bracket', '对阵表')} /><Bracket rounds={x.rounds} me={user?.id || null} /></section>}
      {x.status === 'signup' && (x.entrants?.length || (x.standings?.length ?? 0) > 0) ? (
        <section className="stack m"><SectionHead title={t('Signed up', '已报名')} />
          <p className="fs-sm">{(x.entrants || x.standings || []).map((p) => p.name).join(', ')}</p></section>) : null}
    </div>
  );
}

/** The game page: its tournaments that are on or coming up. */
export function GameTournaments({ slug }: { slug: string }) {
  const { data } = useData<{ tournaments: Tournament[] }>(`/games/${encodeURIComponent(slug)}/tournaments`);
  const list = (data?.tournaments || []).filter((x) => x.status === 'signup' || x.status === 'running');
  if (!list.length) return null;
  return (
    <Card title={t('Tournaments', '锦标赛')} pad>
      <div className="stack s">{list.map((x) => (
        <Link key={x.id} to={`/tournaments/${encodeURIComponent(x.slug)}`} className="tm-mini">
          <b className="clip">{x.title}</b><span className="dim fs-sm">{kindName(x.kind)} · {statusLine(x)}</span>
        </Link>))}</div>
    </Card>
  );
}

const toLocal = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

/** The console: schedule and cancel tournaments for a live game with server-run matches. */
export function TournamentsCard({ id }: { id: string }) {
  const { busy, act } = useAct();
  const { data, reload } = useData<{ tournaments: Tournament[]; live: boolean; matches: boolean; admin: boolean }>(`/console/projects/${id}/tournaments`);
  const [form, setForm] = useState<{ title: string; kind: 'cup' | 'bracket'; queue: string; start: string; end: string; round: string; max: string; prize: string; description: string; official: boolean } | null>(null);
  if (!data || !data.live || !data.matches) return null;
  const blank = () => { const s = Date.now() + 86400000; setForm({ title: '', kind: 'cup', queue: 'default', start: toLocal(s), end: toLocal(s + 2 * 86400000), round: '60', max: '', prize: '', description: '', official: false }); };
  const save = () => form && act('tm', async () => {
    await api(`/console/projects/${id}/tournaments`, { body: { title: form.title, kind: form.kind, queue: form.queue, starts_at: new Date(form.start).getTime(), ends_at: form.kind === 'cup' ? new Date(form.end).getTime() : undefined,
      round_minutes: form.kind === 'bracket' ? Number(form.round) : undefined, max_players: form.max ? Number(form.max) : undefined, prize: form.prize, description: form.description, official: form.official } });
    setForm(null); await reload();
  }, t('The tournament is scheduled.', '锦标赛已安排。'));
  const cancel = (slug: string) => act('c' + slug, async () => { await api(`/tournaments/${encodeURIComponent(slug)}/cancel`, { method: 'POST' }); await reload(); });
  return (
    <Card title={t('Tournaments', '锦标赛')} pad>
      <div className="stack">
        <p className="mute fs-sm">{t('Run a cup (points for every match in a mode during a window) or a bracket (single elimination, a round at a time). Players sign up on /tournaments; your game needs no change.', '举办积分杯（在一段时间内某个模式中的每场对局都计分）或淘汰赛（单败淘汰，逐轮进行）。玩家在 /tournaments 报名，你的游戏无需任何修改。')}</p>
        {!form && <div><Button size="sm" variant="primary" onClick={blank}>{t('New tournament', '新建锦标赛')}</Button></div>}
        {form && (
          <div className="stack s">
            <Field label={t('Title', '标题')}><Input value={form.title} maxLength={80} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></Field>
            <div className="row wrap-row">
              <Field label={t('Format', '赛制')}><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'cup' | 'bracket' })}><option value="cup">{t('Cup', '积分杯')}</option><option value="bracket">{t('Bracket', '淘汰赛')}</option></Select></Field>
              <Field label={t('Mode (queue)', '模式（队列）')} hint={t('The queue your game passes to GCP.match.find.', '你的游戏传给 GCP.match.find 的队列。')}><Input mono value={form.queue} maxLength={32} onChange={(e) => setForm({ ...form, queue: e.target.value.toLowerCase() })} /></Field>
            </div>
            <div className="row wrap-row">
              <Field label={t('Starts', '开始')}><Input type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
              {form.kind === 'cup' ? <Field label={t('Ends', '结束')}><Input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
                : <Field label={t('Minutes per round', '每轮分钟数')}><Input inputMode="numeric" value={form.round} onChange={(e) => setForm({ ...form, round: e.target.value.replace(/\D/g, '') })} /></Field>}
              <Field label={t('Most players', '人数上限')}><Input inputMode="numeric" value={form.max} placeholder={form.kind === 'bracket' ? '32' : '1000'} onChange={(e) => setForm({ ...form, max: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
            <Field label={t('Prize (optional)', '奖品（可选）')} hint={t('In words. The platform pays nothing out.', '用文字描述。平台不发放任何奖品。')}><Input value={form.prize} maxLength={200} onChange={(e) => setForm({ ...form, prize: e.target.value })} /></Field>
            <Field label={t('Description (optional)', '说明（可选）')}><Textarea rows={3} maxLength={1000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            {data.admin && <label className="row fs-sm"><input type="checkbox" checked={form.official} onChange={(e) => setForm({ ...form, official: e.target.checked })} /> {t('Official (run by the platform)', '官方（平台举办）')}</label>}
            <div className="row"><Button size="sm" variant="primary" onClick={() => void save()} disabled={busy === 'tm' || form.title.trim().length < 3}>{t('Schedule', '安排')}</Button><Button size="sm" variant="ghost" onClick={() => setForm(null)}>{t('Cancel', '取消')}</Button></div>
          </div>
        )}
        {data.tournaments.length > 0 && <div className="stack s">{data.tournaments.map((x) => (
          <div key={x.id} className="row wrap-row tm-console">
            <Link to={`/tournaments/${encodeURIComponent(x.slug)}`} className="grow clip"><b>{x.title}</b></Link>
            <span className="dim fs-sm">{kindName(x.kind)} · {x.players} · {statusLine(x)}</span>
            {(x.status === 'signup' || x.status === 'running') && !(x.official && !data.admin) && <Button size="sm" variant="ghost" onClick={() => void cancel(x.slug)} disabled={busy === 'c' + x.slug}>{t('Cancel', '取消')}</Button>}
          </div>))}</div>}
      </div>
    </Card>
  );
}
