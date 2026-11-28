// Devlogs and patch notes (src/devlogs.js): the News section on a game page, and the card in the console where the
// creator posts. A post on a live game is announced under the bell to the players who follow, keep, bought or played it.
import { useEffect, useState } from 'react';
import { api, date, num, t, useAct, useData } from './lib';
import { Badge, Button, Card, Input, Textarea } from './ui';
import { SectionHead } from './store';

export interface Devlog { id: string; kind: 'post' | 'patch'; version: number | null; title: string; body: string; author: string; notified: number; created_at: number; edited_at?: number }
type Page = { devlogs: Devlog[]; more: number | null };

function Post({ d, children }: { d: Devlog; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false), long = d.body.length > 420;
  return (
    <article className="devlog">
      <header className="row">
        <b className="grow">{d.title}</b>
        {d.kind === 'patch' && <Badge dot={false}>{d.version != null ? t('Version {n}', '版本 {n}', { n: d.version }) : t('Patch notes', '更新说明')}</Badge>}
        <span className="dim fs-sm">{date(d.created_at)}</span>
      </header>
      <p className={`devlog-body${long && !open ? ' clamp' : ''}`}>{d.body}</p>
      {long && <button type="button" className="linkish fs-sm" onClick={() => setOpen(!open)}>{open ? t('Show less', '收起') : t('Read more', '阅读全文')}</button>}
      {children}
    </article>
  );
}

/** A game page's News section: the newest posts, then older ones on request. Hidden when there are none. */
export function DevlogSection({ slug }: { slug: string }) {
  const { data } = useData<Page>(`/games/${encodeURIComponent(slug)}/devlogs?limit=3`);
  const [older, setOlder] = useState<Devlog[]>([]), [more, setMore] = useState<number | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { setOlder([]); setMore(data?.more ?? null); }, [data]);
  useEffect(() => { if (data?.devlogs.length && location.hash === '#news') document.getElementById('news')?.scrollIntoView({ block: 'start' }); }, [data]);
  if (!data?.devlogs.length) return null;
  const loadMore = async () => {
    if (!more) return; setBusy(true);
    try { const r = await api<Page>(`/games/${encodeURIComponent(slug)}/devlogs?limit=10&before=${more}`); setOlder((o) => [...o, ...r.devlogs]); setMore(r.more); } finally { setBusy(false); }
  };
  return (
    <section className="stack l" id="news">
      <SectionHead title={t('News and updates', '新闻与更新')} note={t('From the creator', '来自创作者')} />
      <div className="stack">
        {[...data.devlogs, ...older].map((d) => <Post key={d.id} d={d} />)}
      </div>
      {more && <div><Button size="sm" variant="ghost" onClick={() => void loadMore()} disabled={busy}>{t('Older posts', '更早的动态')}</Button></div>}
    </section>
  );
}

/** The console card: write a post to the game's players, and manage what is there. */
export function DevlogCard({ id, slug, live }: { id: string; live: boolean; slug: string }) {
  const { data, reload } = useData<Page>(live ? `/games/${encodeURIComponent(slug)}/devlogs?limit=5` : null);
  const { busy, act } = useAct(), [title, setTitle] = useState(''), [body, setBody] = useState(''), [writing, setWriting] = useState(false);
  const post = () => act('devlog', async () => {
    const r = await api<{ notified: number }>(`/console/projects/${id}/devlogs`, { body: { title, body } });
    setTitle(''); setBody(''); setWriting(false); await reload();
    return r;
  }, t('Posted. Your players will see it on the game page and under the bell.', '已发布。玩家会在游戏页面和通知中看到它。'));
  const remove = (d: Devlog) => { if (confirm(t('Delete "{title}"? Players will no longer see it.', '删除“{title}”？玩家将不再看到它。', { title: d.title }))) void act('del:' + d.id, async () => { await api(`/console/projects/${id}/devlogs/${d.id}`, { method: 'DELETE' }); await reload(); }); };
  return (
    <Card title={t('News for players', '给玩家的动态')} pad>
      {!live ? <p className="mute fs-sm">{t('Once the game is live, or its coming soon page is up, post news and updates here. Players who follow you, wishlisted, keep, bought or lately played the game are told under the bell. Your agent adds patch notes when it publishes an update.', '游戏上线或即将推出页面上线后，可在这里发布新闻和更新。关注你、加入愿望单、收藏、购买或最近玩过这款游戏的玩家会在通知中收到。智能体在发布更新时会附上更新说明。')}</p> : <>
        {writing ? (
          <div className="stack s">
            <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={t('Headline', '标题')} aria-label={t('Headline', '标题')} autoFocus />
            <Textarea value={body} maxLength={5000} rows={5} onChange={(e) => setBody(e.target.value)} placeholder={t('What is new, what is coming, what you would like players to try…', '有什么新内容、接下来的计划、想请玩家试试什么……')} aria-label={t('Post', '正文')} />
            <div className="row"><span className="dim fs-sm grow">{t('Up to 3 posts a day.', '每天最多 3 条。')}</span><Button variant="ghost" onClick={() => setWriting(false)}>{t('Cancel', '取消')}</Button><Button variant="primary" onClick={() => void post()} disabled={busy === 'devlog' || !title.trim() || !body.trim()}>{t('Post to players', '发布给玩家')}</Button></div>
          </div>
        ) : <div className="row"><span className="mute fs-sm grow">{t('Tell players what changed or what is coming.', '告诉玩家有哪些变化或接下来的计划。')}</span><Button size="sm" onClick={() => setWriting(true)}>{t('Write a post', '撰写动态')}</Button></div>}
        {data?.devlogs.map((d) => (
          <Post key={d.id} d={d}>
            <div className="row"><span className="dim fs-sm grow">{d.notified === 1 ? t('1 player told', '已通知 1 位玩家') : d.notified ? t('{n} players told', '已通知 {n} 位玩家', { n: num(d.notified) }) : t('Shown on the game page', '显示在游戏页面')}</span><button type="button" className="linkish fs-sm" onClick={() => remove(d)} disabled={busy === 'del:' + d.id}>{t('Delete', '删除')}</button></div>
          </Post>
        ))}
      </>}
    </Card>
  );
}
