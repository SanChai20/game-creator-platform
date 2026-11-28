// Playtests (src/playtests.js): the tester's page behind an invite link (/playtest/<code>), where they join, play the
// preview and answer the creator's questions, and the console card where the creator opens one and reads the results.
import { useEffect, useState } from 'react';
import { api, date, Fail, Link, loginUrl, num, t, useAct, useApp, useData } from './lib';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Table, Textarea } from './ui';
import { usePlayClock } from './play-clock';
import { Stage, withPlayLang, type Orientation } from './player';
import './follow.css';

interface Invite {
  title: string; note: string | null; questions: string[]; closes_at: number; open: boolean; full: boolean; owner: boolean;
  game: { slug: string; title: string; tagline: string | null; author: string }; joined: boolean; answered: boolean; cover: string | null;
  mine: { fun: number; answers: string[] } | null;
}

function Survey({ code, questions, mine, onDone }: { code: string; questions: string[]; mine: Invite['mine']; onDone: () => void }) {
  const answered = !!mine;
  const { busy, act } = useAct(), [fun, setFun] = useState(mine?.fun || 0), [answers, setAnswers] = useState<string[]>(() => questions.map((_, i) => mine?.answers[i] || ''));
  const send = () => act('answers', async () => { await api(`/playtests/${code}/answers`, { method: 'PUT', body: { fun, answers } }); onDone(); }, t('Thank you. The creator will read it.', '谢谢！创作者会读到你的反馈。'));
  return (
    <Card title={answered ? t('Change your answers', '修改你的回答') : t('Tell the creator what you thought', '告诉创作者你的想法')} pad>
      <div className="stack">
        <div className="stack s">
          <b>{t('How much did you enjoy it?', '你玩得开心吗？')}</b>
          <div className="row pt-fun" role="radiogroup" aria-label={t('How much did you enjoy it?', '你玩得开心吗？')}>
            {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={fun === n} className={fun >= n ? 'on' : ''} onClick={() => setFun(n)} aria-label={t('{n} of 5', '{n}/5', { n })}>★</button>)}
          </div>
        </div>
        {questions.map((q, i) => (
          <label key={i} className="stack s"><b>{q}</b>
            <Textarea rows={3} maxLength={800} value={answers[i]} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} />
          </label>
        ))}
        <div><Button variant="primary" onClick={() => void send()} disabled={!fun || busy === 'answers'}>{t('Send', '发送')}</Button></div>
        <p className="dim fs-sm">{t('The creator sees your display name with your answers, and how long you played.', '创作者会看到你的显示名称、你的回答以及你玩了多久。')}</p>
      </div>
    </Card>
  );
}

/** /playtest/<code>: the invitation, the game (the creator's preview) and the survey. */
export function PlaytestPage({ code }: { code: string }) {
  const { user } = useApp(), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<Invite>(`/playtests/${encodeURIComponent(code)}`);
  const [play, setPlay] = useState<{ url: string; session: string; clock: string | null; orientation: Orientation; controls: unknown } | null>(null);
  usePlayClock(play ? play.session : null, play ? play.clock : null);
  useEffect(() => { if (data) document.title = t('Playtest · {game}', '试玩测试 · {game}', { game: data.game.title }); }, [data]);
  if (error && !data) return <div className="wrap page">{error.status === 404 ? <EmptyState title={t('This playtest link does not work', '这个试玩测试链接无效')}>{t('Ask the creator for a new one.', '请向创作者索取新的链接。')}</EmptyState> : <Fail error={error} retry={reload} />}</div>;
  if (loading || !data) return <div className="wrap page" aria-busy="true" />;
  const d = data;
  const joinIt = () => act('join', async () => { await api(`/playtests/${code}/join`, { method: 'POST' }); await reload(); });
  const start = () => act('play', async () => {
    const r = await api<{ url: string; session: string; clock?: string; orientation?: Orientation; controls?: unknown }>(`/playtests/${code}/play`, { method: 'POST' });
    setPlay({ url: withPlayLang(r.url), session: r.session, clock: r.clock || null, orientation: r.orientation || 'any', controls: r.controls ?? null });
  });
  const state = !d.open ? <Badge>{t('Closed', '已结束')}</Badge> : <Badge tone="good">{t('Open until {date}', '开放至 {date}', { date: date(d.closes_at) })}</Badge>;
  let action;
  if (d.owner) action = <p className="mute">{t('This is your own game. Share this link with your testers; you play the preview in the console.', '这是你自己的游戏。把这个链接分享给测试者；你可以在控制台里玩预览版。')}</p>;
  else if (!user) action = <Button variant="primary" to={loginUrl()}>{t('Sign in to join', '登录后加入')}</Button>;
  else if (!d.joined) action = !d.open ? <p className="mute">{t('This playtest has closed.', '这次试玩测试已结束。')}</p> : d.full ? <p className="mute">{t('This playtest is full.', '这次试玩测试名额已满。')}</p>
    : <Button variant="primary" onClick={() => void joinIt()} disabled={busy === 'join'}>{t('Join the playtest', '加入试玩测试')}</Button>;
  else if (d.open) action = <Button variant="primary" onClick={() => void start()} disabled={busy === 'play' || !!play}>{play ? t('Playing', '游玩中') : t('Play the test version', '玩测试版')}</Button>;
  else action = <p className="mute">{t('This playtest has closed. Thank you for testing.', '这次试玩测试已结束，感谢参与。')}</p>;
  return (
    <div className="wrap page stack l">
      <div className="stack s">
        <PageHeader eyebrow={t('Playtest', '试玩测试')} title={d.game.title} sub={t('By {name} · {title}', '{name} 制作 · {title}', { name: d.game.author, title: d.title })} />
        <div className="row wrap-row">{state}{d.joined && <Badge>{t('You are a tester', '你是测试者')}</Badge>}</div>
      </div>
      {d.note && <Card pad><div className="stack s"><b>{t('What to try', '请试试这些')}</b><p className="pt-note">{d.note}</p></div></Card>}
      {play ? (
        <Stage poster={d.cover} seed={d.game.slug} url={play.url} orientation={play.orientation} controls={play.controls as never} onQuit={() => setPlay(null)} onSessionEnded={() => setPlay(null)} />
      ) : (
        <Card pad><div className="stack">
          {d.cover && <div className="pt-cover" style={{ backgroundImage: `url(${d.cover})` }} />}
          {d.game.tagline && <p className="mute">{d.game.tagline}</p>}
          <div>{action}</div>
          {!d.owner && <p className="dim fs-sm">{t('This is a test version that is not finished. Your play counts only toward this test, and the creator sees how you played it.', '这是尚未完成的测试版本。你的游玩只计入本次测试，创作者能看到你的游玩情况。')}</p>}
        </div></Card>
      )}
      {d.joined && d.open && <Survey code={code} questions={d.questions} mine={d.mine} onDone={() => void reload()} />}
      {d.joined && <p className="dim fs-sm"><Link to="/">{t('Back to the store', '返回商店')}</Link></p>}
    </div>
  );
}

interface PtRow { id: string; code: string; title: string; version: number; seats: number; status: string; created_at: number; closes_at: number; closed_at: number | null; testers: number; answered: number; link: string }
interface PtList { preview_version: number | null; preview_ready: boolean; playtests: PtRow[] }
interface Results {
  playtest: { id: string; title: string; questions: string[]; status: string };
  totals: { testers: number; played: number; answered: number; fun_average: number | null; median_minutes: number };
  events: { name: string; testers: number }[];
  testers: { name: string; joined_at: number; fun: number | null; answers: string[] | null; sessions: number; minutes: number; last_played: number | null; events: { name: string }[] }[];
  link: string;
}

function ResultsView({ pid, pt }: { pid: string; pt: string }) {
  const { data } = useData<Results>(`/console/projects/${pid}/playtests/${pt}`);
  if (!data) return <p className="dim fs-sm">{t('Loading…', '加载中……')}</p>;
  const r = data, qs = r.playtest.questions;
  if (!r.testers.length) return <p className="mute fs-sm">{t('No testers yet. Share the link.', '还没有测试者，分享链接吧。')}</p>;
  return (
    <div className="stack">
      <p className="fs-sm">{t('{n} testers · {played} played · {answered} answered', '{n} 位测试者 · {played} 位玩过 · {answered} 位已回答', { n: num(r.totals.testers), played: num(r.totals.played), answered: num(r.totals.answered) })}{r.totals.fun_average != null ? ` · ${t('enjoyment {n} of 5', '开心度 {n}/5', { n: r.totals.fun_average })}` : ''}{r.totals.played ? ` · ${t('median {n} min', '中位数 {n} 分钟', { n: r.totals.median_minutes })}` : ''}</p>
      {!!r.events.length && <p className="dim fs-sm">{t('Testers who reached each event:', '到达各事件的测试者：')} {r.events.map((e) => `${e.name} ${e.testers}`).join(' · ')}</p>}
      <Table dense><thead><tr><th>{t('Tester', '测试者')}</th><th className="n">{t('Sessions', '次数')}</th><th className="n">{t('Minutes', '分钟')}</th><th className="n">{t('Enjoyment', '开心度')}</th></tr></thead>
        <tbody>{r.testers.map((x, i) => <tr key={i}><td>{x.name}</td><td className="n">{num(x.sessions)}</td><td className="n">{x.minutes}</td><td className="n">{x.fun ? '★'.repeat(x.fun) : '–'}</td></tr>)}</tbody></Table>
      {qs.map((q, i) => {
        const said = r.testers.filter((x) => x.answers?.[i]);
        return <div key={i} className="stack s"><b className="fs-sm">{q}</b>{said.length ? <ul className="pt-answers">{said.map((x, j) => <li key={j}><span className="dim fs-sm">{x.name}</span> {x.answers![i]}</li>)}</ul> : <p className="dim fs-sm">{t('No answers yet.', '还没有回答。')}</p>}</div>;
      })}
    </div>
  );
}

/** The console card: open a playtest on the preview, share its link, and read how testers played and what they said. */
export function PlaytestCard({ id }: { id: string }) {
  const { toast } = useApp(), { busy, act } = useAct();
  const { data, reload } = useData<PtList>(`/console/projects/${id}/playtests`);
  const [form, setForm] = useState<{ title: string; note: string; questions: string; seats: string; days: string } | null>(null), [show, setShow] = useState<string | null>(null);
  if (!data) return null;
  const openOne = data.playtests.find((x) => x.status === 'open');
  const create = () => form && act('pt', async () => {
    await api(`/console/projects/${id}/playtests`, { body: { title: form.title, note: form.note, questions: form.questions.split('\n').map((q) => q.trim()).filter(Boolean), seats: Number(form.seats) || 50, days: Number(form.days) || 7 } });
    setForm(null); await reload();
  }, t('The playtest is open. Share its link with your testers.', '试玩测试已开放，把链接分享给测试者吧。'));
  const close = (pt: string) => act('ptc', async () => { await api(`/console/projects/${id}/playtests/${pt}/close`, { method: 'POST' }); await reload(); }, t('The playtest is closed.', '试玩测试已结束。'));
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); toast(t('Link copied.', '链接已复制。')); } catch { toast(t('Copying is blocked here. Select the text and copy it.', '此处无法复制，请选中文本后手动复制。'), true); } };
  return (
    <Card title={t('Playtests', '试玩测试')} aside={openOne ? <Badge tone="good">{t('Open', '进行中')}</Badge> : undefined} pad>
      <div className="stack">
        <p className="mute fs-sm">{t('Invite real players to your preview with a link, ask them a few questions, and see how each of them played. Their play never counts toward the live game.', '用链接邀请真实玩家试玩你的预览版，问他们几个问题，并查看每个人的游玩情况。他们的游玩不会计入线上游戏。')}</p>
        {!openOne && !form && (data.preview_ready
          ? <div><Button size="sm" variant="primary" onClick={() => setForm({ title: '', note: '', questions: '', seats: '50', days: '7' })}>{t('Open a playtest', '开放试玩测试')}</Button></div>
          : <p className="dim fs-sm">{data.preview_version ? t('The preview has to pass verification first.', '预览版需要先通过验证。') : t('Deploy a preview first: testers play the preview version.', '请先部署预览版：测试者玩的是预览版本。')}</p>)}
        {form && (
          <div className="stack s">
            <Input value={form.title} maxLength={80} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('Title, such as Level 2 balance', '标题，例如：第 2 关平衡性')} aria-label={t('Title', '标题')} autoFocus />
            <Textarea rows={3} maxLength={600} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('What should testers try?', '想请测试者试试什么？')} aria-label={t('What to try', '请试试这些')} />
            <Textarea rows={3} value={form.questions} onChange={(e) => setForm({ ...form, questions: e.target.value })} placeholder={t('Questions for afterwards, one per line (up to 5)', '结束后要问的问题，每行一个（最多 5 个）')} aria-label={t('Questions', '问题')} />
            <div className="row">
              <label className="row fs-sm">{t('Testers', '测试者')} <Input mono inputMode="numeric" value={form.seats} onChange={(e) => setForm({ ...form, seats: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: '5em' }} /></label>
              <label className="row fs-sm">{t('Days', '天数')} <Input mono inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: '4em' }} /></label>
            </div>
            <div className="row"><Button size="sm" variant="primary" onClick={() => void create()} disabled={busy === 'pt' || !form.title.trim()}>{t('Open', '开放')}</Button><Button size="sm" variant="ghost" onClick={() => setForm(null)}>{t('Cancel', '取消')}</Button></div>
          </div>
        )}
        {data.playtests.map((x) => (
          <div key={x.id} className="stack s pt-row">
            <div className="row wrap-row">
              <b className="grow">{x.title}</b>
              <span className="dim fs-sm">{t('Preview v{n}', '预览版 v{n}', { n: x.version })} · {t('{n} of {seats} testers', '{n}/{seats} 位测试者', { n: num(x.testers), seats: num(x.seats) })} · {x.status === 'open' ? t('until {date}', '至 {date}', { date: date(x.closes_at) }) : t('closed {date}', '{date} 结束', { date: date(x.closed_at || x.closes_at) })}</span>
            </div>
            {x.status === 'open' && <div className="row"><Input mono readOnly value={x.link} onFocus={(e) => e.target.select()} aria-label={t('Invite link', '邀请链接')} /><Button size="sm" onClick={() => void copy(x.link)}>{t('Copy', '复制')}</Button><Button size="sm" variant="ghost" onClick={() => void close(x.id)} disabled={busy === 'ptc'}>{t('Close', '结束')}</Button></div>}
            <div><button type="button" className="linkish fs-sm" onClick={() => setShow(show === x.id ? null : x.id)}>{show === x.id ? t('Hide results', '隐藏结果') : t('Results', '结果')}</button></div>
            {show === x.id && <ResultsView pid={id} pt={x.id} />}
          </div>
        ))}
      </div>
    </Card>
  );
}
