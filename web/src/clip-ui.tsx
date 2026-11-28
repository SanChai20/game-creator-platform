// Clips (src/clips.js): short recordings players make while they play (Record clip under the game or in its menu), saved
// here and shared by link. The game page lists a game's newest clips, /clip/<id> plays one, /clips lists your own.
import { useEffect, useMemo, useState } from 'react';
import { ago, api, ApiError, Fail, Link, loginUrl, navigate, num, t, useAct, useApp, useData } from './lib';
import { Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Select } from './ui';
import { SectionHead } from './store';
import type { ClipTake } from './player';
import './follow.css';

export interface Clip {
  id: string; title: string | null; ms: number; type: string; bytes: number; views: number; created_at: number; video: string;
  by: { id: string; name: string }; game: { id: string; slug: string; title: string };
  hidden: boolean; hidden_by: string | null; mine: boolean; can_hide: boolean; can_delete: boolean;
}
const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;
const clipUrl = (id: string) => `${location.origin}/clip/${encodeURIComponent(id)}`;

async function upload(slug: string, take: ClipTake, title: string): Promise<Clip> {
  const q = new URLSearchParams({ ms: String(Math.round(take.ms)) }); if (title.trim()) q.set('title', title.trim());
  const r = await fetch(`/api/games/${encodeURIComponent(slug)}/clips?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': take.type }, body: take.blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error || `${t('Request failed', '请求失败')} (${r.status})`, r.status, j.code, j.hint);
  return j.clip as Clip;
}

/** After Record clip: watch the recording, name it and save it (or throw it away). Saved, it shows the link to share. */
export function ClipSaveDialog({ slug, take, onClose }: { slug: string; take: ClipTake; onClose: () => void }) {
  const { user } = useApp(), { busy, act } = useAct(), [title, setTitle] = useState(''), [saved, setSaved] = useState<Clip | null>(null);
  const src = useMemo(() => URL.createObjectURL(take.blob), [take.blob]);
  useEffect(() => () => URL.revokeObjectURL(src), [src]);
  const save = () => act('save', async () => { setSaved(await upload(slug, take, title)); });
  const guest = !user;
  return (
    <Modal onClose={onClose}>
      <div className="stack m clip-save">
        <b>{saved ? t('Your clip is saved', '片段已保存') : t('Your clip', '你的片段')}</b>
        <video className="clip-video" src={src} controls playsInline muted autoPlay loop />
        {saved ? <ClipShare clip={saved} /> : guest ? (
          <p className="fs-sm">{t('Sign in to save and share clips.', '登录后即可保存和分享片段。')} <Link className="sig" to={loginUrl(location.pathname)}>{t('Sign in', '登录')}</Link></p>
        ) : (
          <>
            <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={t('Name it (optional)', '起个名字（可选）')} aria-label={t('Clip name', '片段名称')} />
            <p className="dim fs-sm">{t('{s} · {mb} MB. Anyone with the link can watch it, and it shows on the game\'s page.', '{s} · {mb} MB。拿到链接的人都能观看，它也会显示在游戏页面上。', { s: secs(take.ms), mb: (take.blob.size / 1048576).toFixed(1) })}</p>
          </>
        )}
        <div className="row right">
          {saved ? <Button variant="primary" onClick={onClose}>{t('Done', '完成')}</Button> : <>
            <Button variant="ghost" onClick={onClose}>{t('Discard', '丢弃')}</Button>
            {!guest && <Button variant="primary" onClick={() => void save()} disabled={busy === 'save'}>{busy === 'save' ? t('Saving…', '保存中…') : t('Save clip', '保存片段')}</Button>}
          </>}
        </div>
      </div>
    </Modal>
  );
}

function ClipShare({ clip }: { clip: Clip }) {
  const { toast } = useApp(), url = clipUrl(clip.id);
  const native = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast(t('Link copied.', '链接已复制。')); } catch { toast(t('Copying is blocked here. Select the text and copy it.', '此处无法复制，请选中文本后手动复制。'), true); } };
  return (
    <div className="row wrap-row">
      {native && <Button size="sm" variant="primary" onClick={() => void navigator.share({ title: clip.title || clip.game.title, url }).catch(() => undefined)}>{t('Share…', '分享…')}</Button>}
      <Button size="sm" onClick={() => void copy()}>{t('Copy link', '复制链接')}</Button>
      <Link className="sig fs-sm" to={`/clip/${encodeURIComponent(clip.id)}`}>{t('Open clip page', '打开片段页面')}</Link>
    </div>
  );
}

function ClipTile({ c, showGame = false }: { c: Clip; showGame?: boolean }) {
  return (
    <Link className="clip-tile" to={`/clip/${encodeURIComponent(c.id)}`}>
      <video src={c.video + '#t=0.5'} preload="metadata" muted playsInline aria-hidden="true" tabIndex={-1} />
      <span className="clip-len mono">{secs(c.ms)}</span>
      <span className="stack clip-cap">
        <b className="clip">{c.title || (showGame ? c.game.title : t('Clip by {name}', '{name} 的片段', { name: c.by.name }))}</b>
        <span className="dim fs-sm clip">{showGame ? `${c.game.title} · ` : `${c.by.name} · `}{ago(c.created_at)}{c.hidden ? ` · ${t('Hidden', '已隐藏')}` : ''}</span>
      </span>
    </Link>
  );
}

/** The game page's clips: the newest ones players saved. The creator can turn clips off for the game. */
export function ClipsSection({ slug, owner, off }: { slug: string; owner: boolean; off: boolean }) {
  const { busy, act } = useAct(), [isOff, setOff] = useState(off);
  const { data } = useData<{ clips: Clip[]; open: boolean }>(`/games/${encodeURIComponent(slug)}/clips`);
  if (!data || (!data.clips.length && !owner)) return null;
  const toggle = () => act('off', async () => { const r = await api<{ clips_off: boolean }>(`/games/${encodeURIComponent(slug)}/clips`, { method: 'PUT', body: { on: isOff } }); setOff(r.clips_off); });
  return (
    <section className="stack l" id="clips">
      <SectionHead title={t('Clips', '精彩片段')} note={owner ? (isOff ? t('Players cannot record this game. Clips already saved stay until you hide them.', '玩家无法录制这款游戏。已保存的片段会保留，直到你隐藏它们。') : t('Players record up to 30 seconds while playing (Record clip under the game) and share the link.', '玩家在游玩时最多可录制 30 秒（游戏下方的“录制片段”），并分享链接。')) : t('Moments players recorded and shared.', '玩家录制并分享的精彩时刻。')} />
      {owner && <div className="row"><Button size="sm" variant="ghost" onClick={() => void toggle()} disabled={busy === 'off'}>{isOff ? t('Let players record clips', '允许玩家录制片段') : t('Turn clips off', '关闭录制片段')}</Button></div>}
      {data.clips.length ? <div className="clip-grid">{data.clips.map((c) => <ClipTile key={c.id} c={c} />)}</div> : <p className="mute fs-sm">{t('No clips yet.', '还没有片段。')}</p>}
    </section>
  );
}

const REASONS: [string, () => string][] = [['spam', () => t('Spam', '垃圾信息')], ['harassment', () => t('Harassment', '骚扰')], ['hate', () => t('Hate', '仇恨言论')], ['sexual', () => t('Sexual content', '色情内容')], ['other', () => t('Something else', '其他')]];

/** /clip/<id>: one clip, with its game, who made it, the link to share, and what its maker, the creator and admins can do. */
export function ClipPage({ id }: { id: string }) {
  const { user } = useApp(), { busy, act } = useAct(), [reason, setReason] = useState<string | null>(null);
  const { data, error, reload } = useData<{ clip: Clip }>(`/clips/${encodeURIComponent(id)}`);
  if (error) return <div className="wrap page"><Fail error={error} /></div>;
  if (!data) return <div className="wrap page" />;
  const c = data.clip;
  const remove = () => act('del', async () => { await api(`/clips/${encodeURIComponent(c.id)}`, { method: 'DELETE' }); navigate(c.mine ? '/clips' : `/g/${encodeURIComponent(c.game.slug)}`); }, t('The clip is deleted.', '片段已删除。'));
  const hide = () => act('hide', async () => { await api(`/clips/${encodeURIComponent(c.id)}/hidden`, { method: 'PUT', body: { hidden: !c.hidden } }); await reload(); });
  const report = () => reason && act('rep', async () => { await api(`/clips/${encodeURIComponent(c.id)}/report`, { body: { reason } }); setReason(null); }, t('Thanks. We will take a look.', '谢谢，我们会查看。'));
  return (
    <div className="wrap page stack l">
      <PageHeader title={c.title || t('Clip of {game}', '{game} 的片段', { game: c.game.title })}
        sub={<>{t('By {name}', '作者：{name}', { name: c.by.name })} · {ago(c.created_at)} · {c.views === 1 ? t('1 view', '1 次观看') : t('{n} views', '{n} 次观看', { n: num(c.views) })}</>} />
      {c.hidden && <Card pad><Badge>{t('Hidden', '已隐藏')}</Badge> <span className="fs-sm">{c.hidden_by === 'reports' ? t('Players reported this clip, so only you and moderators see it for now.', '玩家举报了这个片段，所以目前只有你和管理员能看到。') : t('This clip is hidden from players.', '这个片段对玩家隐藏。')}</span></Card>}
      <video className="clip-video big" src={c.video} controls playsInline autoPlay muted loop />
      <div className="row wrap-row">
        <Button variant="primary" to={`/g/${encodeURIComponent(c.game.slug)}`}>{t('Play {game}', '玩 {game}', { game: c.game.title })}</Button>
        <ClipShare clip={c} />
      </div>
      <div className="row wrap-row fs-sm">
        {c.can_hide && <Button size="sm" variant="ghost" onClick={() => void hide()} disabled={busy === 'hide'}>{c.hidden ? t('Show it again', '重新显示') : t('Hide from the game page', '从游戏页面隐藏')}</Button>}
        {c.can_delete && <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy === 'del'}>{t('Delete clip', '删除片段')}</Button>}
        {user && !c.mine && (reason === null ? <button type="button" className="linkish" onClick={() => setReason('spam')}>{t('Report', '举报')}</button> : (
          <span className="row"><Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t('Reason', '原因')}>{REASONS.map(([k, l]) => <option key={k} value={k}>{l()}</option>)}</Select>
            <Button size="sm" onClick={() => void report()} disabled={busy === 'rep'}>{t('Send report', '提交举报')}</Button><Button size="sm" variant="ghost" onClick={() => setReason(null)}>{t('Cancel', '取消')}</Button></span>
        ))}
      </div>
    </div>
  );
}

/** /clips: the clips you saved. */
export function MyClipsPage() {
  const { user } = useApp(), { data, error } = useData<{ clips: Clip[]; max: number }>(user ? '/me/clips' : null);
  if (!user) { navigate(loginUrl('/clips'), true); return null; }
  return (
    <div className="wrap page stack l">
      <PageHeader title={t('Your clips', '我的片段')} sub={data ? t('{n} of {max} clips. Record one with Record clip while you play.', '已保存 {n}/{max} 个片段。游玩时点“录制片段”即可录制。', { n: data.clips.length, max: data.max }) : undefined} />
      {error && <Fail error={error} />}
      {data && (data.clips.length ? <div className="clip-grid">{data.clips.map((c) => <ClipTile key={c.id} c={c} showGame />)}</div>
        : <EmptyState title={t('No clips yet', '还没有片段')}>{t('While you play a game, press Record clip under it (or in its menu) to save up to 30 seconds and share the link.', '游玩时点游戏下方（或菜单里）的“录制片段”，即可保存最长 30 秒并分享链接。')}</EmptyState>)}
    </div>
  );
}
