// Creator replies to reviews and each game's community board (src/community.js), on the game page.
import { useState } from 'react';
import { ago, api, Link, loginUrl, num, t, useAct, useApp, useData } from './lib';
import { Badge, Button, Card, Input, ListPager, Select, Textarea } from './ui';
import { SectionHead } from './store';
import './follow.css';

export interface ReviewReplyData { body: string; name: string; created_at: number; updated_at: number }

/** Under a review: the creator's reply, and for the creator a box to write or change it. */
export function ReviewReply({ slug, rid, reply, owner, onDone }: { slug: string; rid?: string; reply: ReviewReplyData | null; owner: boolean; onDone: () => void }) {
  const { busy, act } = useAct(), [text, setText] = useState<string | null>(null);
  const base = `/games/${encodeURIComponent(slug)}/reviews/${encodeURIComponent(rid || '')}/reply`;
  const save = () => text !== null && act('rr', async () => { await api(base, { method: 'PUT', body: { body: text } }); setText(null); onDone(); }, t('Your reply is posted.', '回复已发布。'));
  const remove = () => act('rrd', async () => { await api(base, { method: 'DELETE' }); onDone(); });
  if (text !== null) return (
    <div className="stack s rv-reply">
      <Textarea rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Reply as the creator. Everyone can read it.', '以创作者身份回复，所有人都能看到。')} aria-label={t('Your reply', '你的回复')} autoFocus />
      <div className="row"><Button size="sm" variant="primary" onClick={() => void save()} disabled={busy === 'rr' || !text.trim()}>{t('Post reply', '发布回复')}</Button><Button size="sm" variant="ghost" onClick={() => setText(null)}>{t('Cancel', '取消')}</Button></div>
    </div>
  );
  return (
    <>
      {reply && <div className="rv-reply"><div className="row fs-sm"><b>{reply.name}</b><Badge tone="good">{t('Creator', '创作者')}</Badge><span className="dim">{ago(reply.updated_at)}</span></div><p className="prose">{reply.body}</p></div>}
      {owner && rid && <div className="row fs-sm"><button type="button" className="linkish" onClick={() => setText(reply?.body || '')}>{reply ? t('Edit reply', '编辑回复') : t('Reply', '回复')}</button>{reply && <button type="button" className="linkish" onClick={() => void remove()} disabled={busy === 'rrd'}>{t('Remove reply', '删除回复')}</button>}</div>}
    </>
  );
}

interface Post { id: string; title?: string; body: string; excerpt?: string; author: { id: string; name: string; creator: boolean }; pinned: boolean; locked: boolean; replies: number; created_at: number; updated_at: number; last_at: number; hidden: string | null; reports?: number; mine: boolean }
interface Threads { off: boolean; moderator: boolean; total: number; threads: Post[] }
interface ThreadView { moderator: boolean; off: boolean; thread: Post; posts: Post[] }
const REASONS: [string, () => string][] = [['spam', () => t('Spam', '垃圾信息')], ['harassment', () => t('Harassment', '骚扰')], ['hate', () => t('Hate', '仇恨言论')], ['spoilers', () => t('Spoilers', '剧透')], ['off_topic', () => t('Off topic', '离题')], ['other', () => t('Something else', '其他')]];
const PER = 20;

/** The game page's community board. Opens a thread from ?thread= (the bell links there). */
export function CommunityBoard({ slug, off }: { slug: string; off: boolean }) {
  const { user } = useApp(), { busy, act } = useAct();
  const [page, setPage] = useState(1), [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.search).get('thread'));
  const [form, setForm] = useState<{ title: string; body: string } | null>(null);
  const base = `/games/${encodeURIComponent(slug)}/board`;
  const { data, reload } = useData<Threads>(`${base}?page=${page}&per_page=${PER}`);
  if (!data) return null;
  if (data.off && !data.moderator) return null;
  const start = () => form && act('th', async () => { const r = await api<{ id: string }>(base, { body: form }); setForm(null); await reload(); setOpen(r.id); }, t('Your thread is up.', '帖子已发布。'));
  const toggle = () => act('off', async () => { await api(base, { method: 'PUT', body: { on: data.off } }); await reload(); });
  return (
    <section className="stack l" id="community">
      <SectionHead title={t('Community', '社区')} note={data.off ? t('The board is switched off. Players cannot see it.', '讨论区已关闭，玩家看不到。') : t('Ask questions, share tips and talk with the creator.', '提问、分享技巧，并与创作者交流。')} />
      <div className="row wrap-row">
        {!data.off && (user ? !form && <Button size="sm" variant="primary" onClick={() => setForm({ title: '', body: '' })}>{t('New thread', '发新帖')}</Button> : <span className="mute fs-sm"><Link to={loginUrl(location.pathname + '#community')} className="sig">{t('Sign in', '登录')}</Link> {t('to post.', '后即可发帖。')}</span>)}
        {data.moderator && <Button size="sm" variant="ghost" onClick={() => void toggle()} disabled={busy === 'off'}>{data.off ? t('Switch the board on', '开启讨论区') : t('Switch the board off', '关闭讨论区')}</Button>}
      </div>
      {form && (
        <Card pad><div className="stack s">
          <Input value={form.title} maxLength={100} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('Title', '标题')} aria-label={t('Title', '标题')} autoFocus />
          <Textarea rows={4} maxLength={2000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={t('What would you like to say?', '想说些什么？')} aria-label={t('Post', '内容')} />
          <div className="row"><Button size="sm" variant="primary" onClick={() => void start()} disabled={busy === 'th' || form.title.trim().length < 3 || !form.body.trim()}>{t('Post', '发布')}</Button><Button size="sm" variant="ghost" onClick={() => setForm(null)}>{t('Cancel', '取消')}</Button></div>
        </div></Card>
      )}
      {data.threads.length ? (
        <div className="board">
          {data.threads.map((th) => (
            <div key={th.id} className={'board-row' + (th.hidden ? ' off' : '')}>
              <button type="button" className="board-head" onClick={() => setOpen(open === th.id ? null : th.id)} aria-expanded={open === th.id}>
                <span className="grow stack s">
                  <span className="row wrap-row">{th.pinned && <Badge tone="good">{t('Pinned', '置顶')}</Badge>}{th.locked && <Badge>{t('Locked', '已锁定')}</Badge>}{th.hidden && <Badge>{t('Hidden', '已隐藏')}</Badge>}<b>{th.title}</b></span>
                  <span className="dim fs-sm">{th.author.name}{th.author.creator ? ` · ${t('Creator', '创作者')}` : ''} · {th.replies === 1 ? t('1 reply', '1 条回复') : t('{n} replies', '{n} 条回复', { n: num(th.replies) })} · {ago(th.last_at)}{th.reports ? ` · ${t('{n} reports', '{n} 次举报', { n: th.reports })}` : ''}</span>
                </span>
              </button>
              {open === th.id && <ThreadPanel base={base} id={th.id} onChange={reload} />}
            </div>
          ))}
        </div>
      ) : !data.off && <p className="mute fs-sm">{t('No threads yet. Start the first one.', '还没有帖子，来发第一帖吧。')}</p>}
      <ListPager page={page} total={data.total} perPage={PER} onPage={setPage} />
    </section>
  );
}

function ThreadPanel({ base, id, onChange }: { base: string; id: string; onChange: () => void }) {
  const { user } = useApp(), { busy, act } = useAct(), { data, reload } = useData<ThreadView>(`${base}/${id}`);
  const [text, setText] = useState(''), [edit, setEdit] = useState<{ id: string; title?: string; body: string } | null>(null), [report, setReport] = useState<string | null>(null);
  if (!data) return <div className="board-body dim fs-sm">…</div>;
  const both = async () => { await reload(); onChange(); };
  const send = () => act('rp', async () => { await api(`${base}/${id}`, { body: { body: text } }); setText(''); await both(); });
  const mod = (pid: string, body: Record<string, boolean>) => act('mod', async () => { await api(`${base}/posts/${pid}/moderate`, { method: 'PUT', body }); await both(); });
  const remove = (pid: string) => act('rm', async () => { await api(`${base}/posts/${pid}`, { method: 'DELETE' }); await both(); });
  const saveEdit = () => edit && act('ed', async () => { await api(`${base}/posts/${edit.id}`, { method: 'PATCH', body: { title: edit.title, body: edit.body } }); setEdit(null); await both(); });
  const sendReport = (pid: string, reason: string) => act('rep', async () => { await api(`${base}/posts/${pid}/report`, { body: { reason } }); setReport(null); }, t('Thanks. The creator will take a look.', '感谢举报，创作者会查看。'));
  const th = data.thread, canReply = !!user && !data.off && (!th.locked || data.moderator) && !th.hidden;
  const one = (p: Post, isThread: boolean) => (
    <div key={p.id} className={'board-post' + (p.hidden ? ' off' : '')}>
      <div className="row wrap-row fs-sm"><b>{p.author.name}</b>{p.author.creator && <Badge tone="good">{t('Creator', '创作者')}</Badge>}<span className="dim">{ago(p.created_at)}{p.updated_at > p.created_at + 60000 ? ` · ${t('edited', '已编辑')}` : ''}</span>{p.reports ? <span className="bad">{t('{n} reports', '{n} 次举报', { n: p.reports })}</span> : null}</div>
      {edit?.id === p.id ? (
        <div className="stack s">
          {isThread && <Input value={edit.title || ''} maxLength={100} onChange={(e) => setEdit({ ...edit, title: e.target.value })} aria-label={t('Title', '标题')} />}
          <Textarea rows={3} maxLength={2000} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} aria-label={t('Post', '内容')} />
          <div className="row"><Button size="sm" variant="primary" onClick={() => void saveEdit()} disabled={busy === 'ed'}>{t('Save', '保存')}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>{t('Cancel', '取消')}</Button></div>
        </div>
      ) : p.hidden && !p.body ? <p className="dim fs-sm">{p.hidden === 'author' ? t('Removed by its author.', '已被作者删除。') : t('Hidden by the moderators.', '已被管理者隐藏。')}</p> : <p className="prose">{p.body}</p>}
      {p.hidden && p.body && <p className="dim fs-sm">{p.hidden === 'reports' ? t('Hidden after reports. Players cannot see it.', '因举报已隐藏，玩家看不到。') : p.hidden === 'author' ? t('Removed by its author.', '已被作者删除。') : t('Hidden. Players cannot see it.', '已隐藏，玩家看不到。')}</p>}
      {edit?.id !== p.id && (
        <div className="row wrap-row fs-sm board-tools">
          {p.mine && !p.hidden && <><button type="button" className="linkish" onClick={() => setEdit({ id: p.id, title: isThread ? p.title : undefined, body: p.body })}>{t('Edit', '编辑')}</button><button type="button" className="linkish" onClick={() => void remove(p.id)}>{t('Delete', '删除')}</button></>}
          {data.moderator && isThread && <><button type="button" className="linkish" onClick={() => void mod(p.id, { pinned: !p.pinned })}>{p.pinned ? t('Unpin', '取消置顶') : t('Pin', '置顶')}</button><button type="button" className="linkish" onClick={() => void mod(p.id, { locked: !p.locked })}>{p.locked ? t('Unlock', '解锁') : t('Lock', '锁定')}</button></>}
          {data.moderator && !p.mine && <button type="button" className="linkish" onClick={() => void mod(p.id, { hidden: !p.hidden })}>{p.hidden ? t('Restore', '恢复') : t('Hide', '隐藏')}</button>}
          {user && !p.mine && !p.hidden && !data.moderator && (report === p.id
            ? <Select value="" onChange={(e) => e.target.value && void sendReport(p.id, e.target.value)} aria-label={t('Why report it?', '举报原因')}><option value="">{t('Why report it?', '举报原因')}</option>{REASONS.map(([k, label]) => <option key={k} value={k}>{label()}</option>)}</Select>
            : <button type="button" className="linkish dim" onClick={() => setReport(p.id)}>{t('Report', '举报')}</button>)}
        </div>
      )}
    </div>
  );
  return (
    <div className="board-body stack">
      {one(th, true)}
      {data.posts.map((p) => one(p, false))}
      {canReply ? (
        <div className="stack s">
          <Textarea rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Write a reply', '写下回复')} aria-label={t('Reply', '回复')} />
          <div><Button size="sm" variant="primary" onClick={() => void send()} disabled={busy === 'rp' || !text.trim()}>{t('Reply', '回复')}</Button></div>
        </div>
      ) : th.locked ? <p className="dim fs-sm">{t('This thread is locked.', '此帖已锁定。')}</p> : null}
    </div>
  );
}
