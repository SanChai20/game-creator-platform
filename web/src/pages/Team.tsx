// Working together on a game (src/collab.ts, docs/collaboration.md): the invitations sent to you and the games shared
// with you (/team), and one game's people, branches and change requests (/team/:id, and the owner's Team tab at
// /console/p/:id/team). Agents do the same through the collaborators, branches and change_requests MCP tools.
import { useState } from 'react';
import { ago, api, dateTime, Fail, navigate, t, useAct, useApp, useData } from '../lib';
import { Badge, Button, Card, CheckRow, EmptyState, Field, Input, ListRow, Modal, Notice, PageHeader, Segmented, Select, Steps, Switch, Table, Textarea, type Tone } from '../ui';
import { projectTabs } from './Analytics';

type Role = 'read' | 'write' | 'maintain' | 'admin' | 'owner';
const ROLES: Role[] = ['read', 'write', 'maintain', 'admin'];
const RANK: Record<Role, number> = { read: 1, write: 2, maintain: 3, admin: 4, owner: 5 };
const atLeast = (r: Role, n: Role) => RANK[r] >= RANK[n];

export const roleName = (r: Role) => ({ read: t('Read', '只读'), write: t('Write', '写入'), maintain: t('Maintain', '维护'), admin: t('Admin', '管理员'), owner: t('Owner', '所有者') }[r] || r);
const roleText = (r: Role) => ({
  read: t('Sees the game, its versions, branches and change requests, and comments.', '可查看游戏、版本、分支和变更请求，并发表评论。'),
  write: t('Also works on branches, deploys previews, opens and reviews change requests.', '还可在分支上工作、部署预览、发起和审查变更请求。'),
  maintain: t('Also merges change requests into main, manages branches and edits the store listing.', '还可将变更请求合并到 main、管理分支并编辑商店信息。'),
  admin: t('Also invites people, sets main\'s protection, publishes and rolls back.', '还可邀请成员、设置 main 的保护规则、发布和回滚。'),
  owner: t('Everything, including prices, earnings and deleting the game.', '全部权限，包括定价、收益和删除游戏。'),
}[r]);
const RoleBadge = ({ role }: { role: Role }) => <Badge tone={role === 'owner' || role === 'admin' ? 'accent' : role === 'read' ? 'neutral' : 'info'} dot={false}>{roleName(role)}</Badge>;
const changeTone = (s: string): Tone => (s === 'merged' ? 'good' : s === 'closed' ? 'neutral' : 'info');
const changeLabel = (s: string) => ({ open: t('Open', '进行中'), merging: t('Merging', '合并中'), merged: t('Merged', '已合并'), closed: t('Closed', '已关闭') }[s] || s);

/** How working together goes, in four steps, for the empty states. */
function HowItWorks() {
  return (
    <Steps items={[
      <><b>{t('Invite', '邀请')}</b> · {t('The owner invites people by email, each with a role.', '所有者通过邮箱邀请成员，并为每人分配角色。')}</>,
      <><b>{t('Branch', '分支')}</b> · {t('Each person or agent works on a branch of its own, so nobody overwrites anyone.', '每个人或智能体都在自己的分支上工作，互不覆盖。')}</>,
      <><b>{t('Change request', '变更请求')}</b> · {t('A verified branch version is proposed for main and reviewed.', '把通过验证的分支版本提交到 main，并接受审查。')}</>,
      <><b>{t('Merge', '合并')}</b> · {t('A maintainer merges it: a three-way merge, verified as a new main version.', '维护者执行合并：三方合并后生成新的 main 版本并重新验证。')}</>,
    ]} />
  );
}

// ---- /team: invitations and games shared with you ------------------------------------------------------------------
export function Team() {
  const { busy, act } = useAct();
  const { data, error, reload } = useData<any>('/collab/mine');
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (!data) return <div className="wrap page"><div className="spinner" /></div>;
  const answer = (id: string, a: 'accept' | 'decline') => act(id + a, async () => {
    const r = await api(`/collab/invites/${id}/${a}`, { method: 'POST', body: {} });
    if (a === 'accept' && r.project) navigate(`/team/${r.project}`); else await reload();
  }, a === 'accept' ? t('You joined the team', '你已加入团队') : t('Invitation declined', '已拒绝邀请'));
  return (
    <div className="wrap page stack l">
      <PageHeader eyebrow={t('Team', '团队')} title={t('Working together', '协作开发')} sub={t('Games other creators shared with you, and invitations waiting for an answer.', '其他创作者与你共享的游戏，以及待回复的邀请。')} />
      {data.invitations.length > 0 && (
        <Card title={t('Invitations', '邀请')} pad>
          <div className="stack s">
            {data.invitations.map((i: any) => (
              <ListRow key={i.id} media={i.project.cover ? <img src={i.project.cover} alt="" className="thumb" /> : undefined}
                title={<>{i.project.title} <RoleBadge role={i.role} /></>}
                meta={<>{t('From {name}', '来自 {name}', { name: i.invited_by })} · {t('expires {when}', '{when}过期', { when: dateTime(i.expires_at) })} · {roleText(i.role)}</>}
                tail={<div className="row">
                  <Button size="sm" variant="primary" disabled={!!busy} onClick={() => answer(i.id, 'accept')}>{t('Accept', '接受')}</Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => answer(i.id, 'decline')}>{t('Decline', '拒绝')}</Button>
                </div>} />
            ))}
          </div>
        </Card>
      )}
      <Card title={t('Shared with you', '与你共享')} pad>
        {data.shared.length ? (
          <div className="stack s">
            {data.shared.map((p: any) => (
              <ListRow key={p.id} to={`/team/${p.id}`} media={p.cover ? <img src={p.cover} alt="" className="thumb" /> : undefined}
                title={<>{p.title} <RoleBadge role={p.role} /></>}
                meta={<>{t('Owned by {name}', '所有者：{name}', { name: p.owner })} · {p.open_changes ? t('{n} open change requests', '{n} 个进行中的变更请求', { n: p.open_changes }) : t('No open change requests', '没有进行中的变更请求')} · {ago(p.updated_at)}</>} />
            ))}
          </div>
        ) : <EmptyState compact title={t('Nothing shared with you yet', '还没有与你共享的游戏')}>{t('When a creator invites you to a game, it shows here.', '当有创作者邀请你参与游戏开发时，会显示在这里。')}</EmptyState>}
      </Card>
      <Card title={t('How it works', '工作方式')} pad><HowItWorks /></Card>
    </div>
  );
}

// ---- one game ------------------------------------------------------------------------------------------------------
type Tab = 'changes' | 'branches' | 'people' | 'settings';

export function TeamProject({ id, inConsole }: { id: string; inConsole?: boolean }) {
  const { data, error, reload } = useData<any>(`/collab/projects/${id}`);
  const [tab, setTab] = useState<Tab>('changes');
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (!data) return <div className="wrap page"><div className="spinner" /></div>;
  const role: Role = data.role, p = data.project;
  const tabs: [Tab, string][] = [['changes', t('Change requests', '变更请求')], ['branches', t('Branches', '分支')], ['people', t('People', '成员')], ...(atLeast(role, 'admin') ? [['settings', t('Protection', '保护规则')] as [Tab, string]] : [])];
  return (
    <div className="wrap page stack l">
      <PageHeader eyebrow={t('Team', '团队')} back={inConsole ? undefined : { to: '/team', label: t('Team', '团队') }} title={p.title} badge={<RoleBadge role={role} />}
        sub={<>{roleText(role)} {p.preview_version ? <>· {t('Preview: version {n}', '预览：版本 {n}', { n: p.preview_version })}</> : null} {data.main.head_version ? <>· {t('main: version {n}', 'main：版本 {n}', { n: data.main.head_version })}</> : null}</>} />
      {inConsole && projectTabs(id, 'team')}
      <Segmented label={t('Section', '分区')} options={tabs} value={tab} onChange={setTab} />
      {tab === 'changes' && <Changes id={id} role={role} data={data} reload={reload} />}
      {tab === 'branches' && <Branches id={id} role={role} data={data} reload={reload} />}
      {tab === 'people' && <People id={id} role={role} data={data} reload={reload} />}
      {tab === 'settings' && <Protection id={id} data={data} reload={reload} />}
    </div>
  );
}

function Changes({ id, role, data, reload }: { id: string; role: Role; data: any; reload: () => Promise<void> }) {
  const [status, setStatus] = useState<'open' | 'merged' | 'closed' | 'all'>('open');
  const list = useData<any>(`/collab/projects/${id}/changes?status=${status}`);
  const [open, setOpen] = useState<number | null>(null), [creating, setCreating] = useState(false);
  const free = data.branches.filter((b: any) => !b.change_request && b.head_version);
  return (
    <Card title={t('Change requests', '变更请求')} aside={t('A branch proposed for main, reviewed, then merged', '提交到 main 的分支：先审查，再合并')}
      actions={atLeast(role, 'write') && <Button size="sm" variant="primary" disabled={!free.length} title={free.length ? undefined : t('Deploy a branch first', '请先部署一个分支')} onClick={() => setCreating(true)}>{t('New change request', '新建变更请求')}</Button>} pad>
      <div className="stack m">
        <Segmented label={t('Status', '状态')} options={[['open', t('Open', '进行中')], ['merged', t('Merged', '已合并')], ['closed', t('Closed', '已关闭')], ['all', t('All', '全部')]]} value={status} onChange={setStatus} />
        {list.data?.changes?.length ? (
          <div className="table-wrap"><Table dense>
            <thead><tr><th>#</th><th>{t('Title', '标题')}</th><th>{t('Branch', '分支')}</th><th>{t('By', '发起人')}</th><th className="n">{t('Approvals', '批准')}</th><th>{t('Status', '状态')}</th></tr></thead>
            <tbody>{list.data.changes.map((c: any) => (
              <tr key={c.number} className="clickable" onClick={() => setOpen(c.number)}>
                <td className="mono">#{c.number}</td><td><b>{c.title}</b><div className="dim fs-sm">{ago(c.updated_at)}</div></td>
                <td className="mono fs-sm">{c.branch || '—'}</td><td>{c.author}</td><td className="n">{c.approvals}</td>
                <td><Badge tone={changeTone(c.status)}>{changeLabel(c.status)}</Badge></td>
              </tr>
            ))}</tbody>
          </Table></div>
        ) : list.data ? <EmptyState compact title={t('No change requests here', '这里没有变更请求')}><HowItWorks /></EmptyState> : <div className="spinner" />}
      </div>
      {creating && <NewChange id={id} branches={free} onClose={() => setCreating(false)} onDone={(n) => { setCreating(false); void list.reload(); void reload(); setOpen(n); }} />}
      {open !== null && <ChangeDetail id={id} number={open} onClose={() => { setOpen(null); void list.reload(); void reload(); }} />}
    </Card>
  );
}

function NewChange({ id, branches, onClose, onDone }: { id: string; branches: any[]; onClose: () => void; onDone: (n: number) => void }) {
  const { busy, act } = useAct();
  const [branch, setBranch] = useState(branches[0]?.name || ''), [title, setTitle] = useState(''), [body, setBody] = useState('');
  return (
    <Modal onClose={onClose}>
      <form className="stack m" onSubmit={(e) => { e.preventDefault(); void act('new', async () => { const r = await api(`/collab/projects/${id}/changes`, { body: { branch, title, body } }); onDone(r.number); }); }}>
        <h2>{t('New change request', '新建变更请求')}</h2>
        <Field label={t('Branch', '分支')} hint={t('Its newest version is what gets reviewed and merged.', '审查和合并的是它的最新版本。')}>
          <Select value={branch} onChange={(e) => setBranch(e.target.value)}>{branches.map((b) => <option key={b.name} value={b.name}>{b.name} · v{b.head_version}</option>)}</Select>
        </Field>
        <Field label={t('Title', '标题')}><Input value={title} maxLength={120} required minLength={3} onChange={(e) => setTitle(e.target.value)} placeholder={t('What it changes, in a line', '一句话说明改动')} /></Field>
        <Field label={t('Description', '描述')}><Textarea rows={5} value={body} maxLength={8000} onChange={(e) => setBody(e.target.value)} /></Field>
        <div className="row end"><Button type="button" variant="ghost" onClick={onClose}>{t('Cancel', '取消')}</Button><Button variant="primary" disabled={!!busy || !branch || title.trim().length < 3}>{t('Open change request', '发起变更请求')}</Button></div>
      </form>
    </Modal>
  );
}

function ChangeDetail({ id, number, onClose }: { id: string; number: number; onClose: () => void }) {
  const { busy, act } = useAct();
  const d = useData<any>(`/collab/projects/${id}/changes/${number}`);
  const [diff, setDiff] = useState<any>(null), [verdict, setVerdict] = useState<'approve' | 'request_changes' | 'comment'>('comment'), [text, setText] = useState('');
  const [bypass, setBypass] = useState(false), [del, setDel] = useState(false);
  const c = d.data;
  const post = (path: string, body: unknown, ok: string) => act(path, async () => { await api(`/collab/projects/${id}/changes/${number}/${path}`, { method: 'POST', body }); await d.reload(); }, ok);
  return (
    <Modal wide onClose={onClose}>
      {!c ? (d.error ? <Fail error={d.error} retry={d.reload} /> : <div className="spinner" />) : (
        <div className="stack m">
          <div className="row between wrap-row">
            <h2>#{c.number} {c.title}</h2>
            <Badge tone={changeTone(c.status)}>{changeLabel(c.status)}</Badge>
          </div>
          <p className="mute fs-sm">
            {t('{author} wants to merge {branch} into main', '{author} 希望将 {branch} 合并到 main', { author: c.author, branch: c.branch || '—' })} · {c.head_version ? t('version {n}', '版本 {n}', { n: c.head_version }) : t('no version yet', '尚无版本')}
            {c.merge_base ? <> · {t('based on main version {n}', '基于 main 版本 {n}', { n: c.merge_base })}</> : null}
            {c.status === 'merged' && c.merged_version ? <> · {t('merged as version {n}', '已合并为版本 {n}', { n: c.merged_version })}</> : null}
          </p>
          {c.body && <p className="pre-wrap">{c.body}</p>}

          {c.status === 'open' && (
            <Card pad title={c.mergeable ? t('Ready to merge', '可以合并') : t('Before it can merge', '合并前还需要')}>
              <div className="stack s">
                {c.blockers.map((b: any) => <CheckRow key={b.id} ok={false} title={b.text} />)}
                {c.mergeable && <CheckRow ok title={t('{n} of {need} approvals, verified, no conflicts', '已获 {n}/{need} 个批准，已通过验证，无冲突', { n: c.approvals, need: c.required_approvals })} />}
                {c.warnings.map((w: string, i: number) => <p key={i} className="dim fs-sm">{w}</p>)}
                {c.you.may_merge && (c.mergeable || c.bypassable) && (
                  <div className="row wrap-row">
                    {!c.mergeable && <label className="row fs-sm"><Switch checked={bypass} onChange={(e) => setBypass(e.target.checked)} /> {t('Merge without the missing approvals or verification (recorded)', '跳过缺少的批准或验证直接合并（会被记录）')}</label>}
                    <label className="row fs-sm"><Switch checked={del} onChange={(e) => setDel(e.target.checked)} /> {t('Delete the branch after merging', '合并后删除分支')}</label>
                    <Button variant="primary" disabled={!!busy || (!c.mergeable && !bypass)} onClick={() => void post('merge', { bypass, delete_branch: del }, t('Merged: the new main version is being verified', '已合并：新的 main 版本正在验证'))}>{t('Merge into main', '合并到 main')}</Button>
                  </div>
                )}
              </div>
            </Card>
          )}

          {c.files_changed && (
            <Card pad title={t('Files changed', '改动的文件')} aside={c.files_changed.summary}
              actions={!diff && <Button size="sm" variant="ghost" onClick={() => void api(`/collab/projects/${id}/changes/${number}/diff`).then(setDiff)}>{t('Show the line changes', '显示逐行改动')}</Button>}>
              {diff ? (
                <div className="stack s">{diff.files.map((f: any) => (
                  <details key={f.path} open={diff.files.length <= 4}>
                    <summary className="mono fs-sm">{f.path} <span className="dim">· {f.kind}{f.binary ? ` · ${t('binary', '二进制')}` : ''}</span></summary>
                    {f.diff ? <pre className="diff">{f.diff.split('\n').map((l: string, i: number) => <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l || ' '}</span>)}</pre> : null}
                  </details>
                ))}</div>
              ) : (
                <ul className="mono fs-sm plain">
                  {c.files_changed.changed.map((f: string) => <li key={f}>~ {f}</li>)}
                  {c.files_changed.added.map((f: string) => <li key={f} className="good">+ {f}</li>)}
                  {c.files_changed.removed.map((f: string) => <li key={f} className="bad">− {f}</li>)}
                </ul>
              )}
            </Card>
          )}

          <Card pad title={t('Reviews', '审查')} aside={t('{n} of {need} approvals', '{n}/{need} 个批准', { n: c.approvals, need: c.required_approvals })}>
            <div className="stack s">
              {c.reviews.length ? c.reviews.map((r: any) => (
                <div key={r.id} className="review">
                  <div className="row between">
                    <span><b>{r.by}</b> <Badge tone={r.verdict === 'approve' ? 'good' : r.verdict === 'request_changes' ? 'bad' : 'neutral'} dot={false}>{r.verdict === 'approve' ? t('Approved', '已批准') : r.verdict === 'request_changes' ? t('Asked for changes', '要求修改') : t('Commented', '已评论')}</Badge>
                      {r.version ? <span className="dim fs-sm"> · v{r.version}</span> : null}{r.stale ? <span className="dim fs-sm"> · {t('an older version', '较早的版本')}</span> : null}{r.dismissed ? <span className="dim fs-sm"> · {t('dismissed', '已驳回')}</span> : null}</span>
                    <span className="dim fs-sm">{ago(r.created_at)}{c.you.may_merge && r.verdict === 'request_changes' && !r.dismissed && c.status === 'open' ? <> · <button className="linkish" onClick={() => void post(`reviews/${r.id}/dismiss`, {}, t('Review dismissed', '已驳回审查'))}>{t('Dismiss', '驳回')}</button></> : null}</span>
                  </div>
                  {r.body && <p className="pre-wrap fs-sm">{r.path ? <span className="mono dim">{r.path}{r.line ? `:${r.line}` : ''} · </span> : null}{r.body}</p>}
                </div>
              )) : <p className="dim fs-sm">{t('No reviews yet.', '暂无审查。')}</p>}
              {c.status === 'open' && (
                <form className="stack s" onSubmit={(e) => { e.preventDefault(); void post('review', { verdict, body: text }, t('Review sent', '审查已提交')).then((ok) => { if (ok) setText(''); }); }}>
                  <Segmented label={t('Your review', '你的审查')} options={[['comment', t('Comment', '评论')], ...(c.you.may_review ? [['approve', t('Approve', '批准')], ['request_changes', t('Ask for changes', '要求修改')]] as [typeof verdict, string][] : [])]} value={verdict} onChange={setVerdict} />
                  <Textarea rows={3} value={text} maxLength={8000} onChange={(e) => setText(e.target.value)} placeholder={verdict === 'approve' ? t('Optional note', '可选备注') : t('What you think', '你的意见')} />
                  <div className="row end"><Button variant={verdict === 'approve' ? 'primary' : 'secondary'} disabled={!!busy || (verdict !== 'approve' && !text.trim())}>{t('Send review', '提交审查')}</Button></div>
                </form>
              )}
            </div>
          </Card>
          {(c.you.is_author || c.you.may_merge) && c.status !== 'merged' && (
            <div className="row end">
              {c.status === 'open' ? <Button variant="ghost" disabled={!!busy} onClick={() => void post('close', {}, t('Closed', '已关闭'))}>{t('Close without merging', '关闭且不合并')}</Button>
                : <Button variant="ghost" disabled={!!busy || c.branch_deleted} onClick={() => void post('reopen', {}, t('Reopened', '已重新打开'))}>{t('Reopen', '重新打开')}</Button>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Branches({ id, role, data, reload }: { id: string; role: Role; data: any; reload: () => Promise<void> }) {
  const { busy, act } = useAct(), { user } = useApp();
  const [name, setName] = useState('');
  const call = (op: string, body: unknown, ok: string) => act(op + JSON.stringify(body), async () => { await api(`/collab/projects/${id}/branches${op ? '/' + op : ''}`, { method: 'POST', body }); await reload(); }, ok);
  return (
    <Card title={t('Branches', '分支')} aside={t('A working copy each, forked from main', '每个分支都是从 main 派生的独立工作副本')} pad>
      <div className="stack m">
        <div className="table-wrap"><Table dense>
          <thead><tr><th>{t('Branch', '分支')}</th><th>{t('Created by', '创建者')}</th><th className="n">{t('Newest version', '最新版本')}</th><th className="n">{t('Behind main', '落后 main')}</th><th>{t('Change request', '变更请求')}</th><th /></tr></thead>
          <tbody>
            <tr><td className="mono"><b>main</b></td><td>—</td><td className="n">{data.main.head_version ? `v${data.main.head_version}` : '—'}</td><td className="n">—</td><td className="dim fs-sm">{t('{n} approvals required', '需要 {n} 个批准', { n: data.main.protection.required_approvals })}</td><td /></tr>
            {data.branches.map((b: any) => (
              <tr key={b.name}>
                <td className="mono">{b.name}{b.conflicts.length ? <> <Badge tone="bad" dot={false}>{t('{n} conflicts', '{n} 个冲突', { n: b.conflicts.length })}</Badge></> : null}</td>
                <td>{b.created_by}<div className="dim fs-sm">{ago(b.created_at)}</div></td>
                <td className="n">{b.head_version ? <>v{b.head_version} <span className="dim fs-sm">{b.head_status}</span></> : '—'}</td>
                <td className="n">{b.main_versions_since_base || 0}</td>
                <td>{b.change_request ? `#${b.change_request.number}` : '—'}</td>
                <td className="row end">
                  {atLeast(role, 'write') && b.main_versions_since_base > 0 && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void call('update', { name: b.name }, t('main brought into the branch', '已将 main 合入分支'))}>{t('Bring in main', '合入 main')}</Button>}
                  {(atLeast(role, 'maintain') || b.created_by_id === user?.id) && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (confirm(t('Delete branch {name}? Its open change request is closed.', '删除分支 {name}？其进行中的变更请求将被关闭。', { name: b.name }))) void call('delete', { name: b.name }, t('Branch deleted', '分支已删除')); }}>{t('Delete', '删除')}</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </Table></div>
        {data.branches.some((b: any) => b.conflicts.length) && <Notice tone="bad" title={t('Conflicts to resolve', '待解决的冲突')}>{t('Bringing main in left both sides of some lines in the files, between <<<<<<< and >>>>>>>. Ask your agent to fix them (branches {action: "status"} lists them), upload, and deploy the branch again.', '合入 main 后，部分文件里同时保留了双方的改动，位于 <<<<<<< 与 >>>>>>> 之间。请让你的智能体修复（branches {action: "status"} 会列出这些文件），上传后重新部署该分支。')}</Notice>}
        {atLeast(role, 'write') && (
          <form className="row wrap-row" onSubmit={(e) => { e.preventDefault(); void call('', { name }, t('Branch created', '分支已创建')).then((ok) => { if (ok) setName(''); }); }}>
            <Input mono value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. boss-fight or anna/menus', '例如 boss-fight 或 anna/menus')} aria-label={t('New branch name', '新分支名称')} />
            <Button variant="secondary" disabled={!!busy || name.trim().length < 2}>{t('Create branch from main', '从 main 创建分支')}</Button>
          </form>
        )}
        <p className="dim fs-sm">{t('Agents work on a branch by passing branch to upload_files, deploy_preview and the other workspace tools, then open a change request with change_requests.', '智能体在 upload_files、deploy_preview 等工作区工具中传入 branch 参数即可在分支上工作，然后用 change_requests 发起变更请求。')}</p>
      </div>
    </Card>
  );
}

function People({ id, role, data, reload }: { id: string; role: Role; data: any; reload: () => Promise<void> }) {
  const { busy, act } = useAct(), { user } = useApp();
  const [email, setEmail] = useState(''), [newRole, setNewRole] = useState<Role>('write');
  const admin = atLeast(role, 'admin');
  const grantable = ROLES.filter((r) => r !== 'admin' || role === 'owner');
  const manageable = (r: Role) => admin && r !== 'owner' && (r !== 'admin' || role === 'owner');
  return (
    <Card title={t('People', '成员')} aside={t('Up to {n} collaborators', '最多 {n} 位协作者', { n: data.limits.members })} pad>
      <div className="stack m">
        <div className="table-wrap"><Table dense>
          <thead><tr><th>{t('Name', '名称')}</th><th>{t('Role', '角色')}</th><th /></tr></thead>
          <tbody>{data.members.map((m: any) => (
            <tr key={m.user_id}>
              <td><b>{m.name}</b>{m.email ? <div className="dim fs-sm">{m.email}</div> : null}</td>
              <td>{manageable(m.role) ? (
                <Select value={m.role} disabled={!!busy} onChange={(e) => void act('role' + m.user_id, async () => { await api(`/collab/projects/${id}/members/${m.user_id}`, { method: 'POST', body: { role: e.target.value } }); await reload(); }, t('Role changed', '角色已更改'))}>
                  {grantable.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
                </Select>) : <RoleBadge role={m.role} />}</td>
              <td className="row end">{m.role !== 'owner' && (manageable(m.role) || m.user_id === user?.id) && (
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (confirm(m.user_id === user?.id ? t('Leave this game?', '确定离开这个游戏？') : t('Remove {name}?', '移除 {name}？', { name: m.name }))) void act('rm' + m.user_id, async () => { await api(`/collab/projects/${id}/members/${m.user_id}`, { method: 'DELETE' }); if (m.user_id === user?.id) navigate('/team'); else await reload(); }, t('Removed', '已移除')); }}>
                  {m.user_id === user?.id ? t('Leave', '离开') : t('Remove', '移除')}
                </Button>)}</td>
            </tr>
          ))}</tbody>
        </Table></div>
        {admin && data.invites.length > 0 && (
          <div className="stack s">
            <h3 className="fs-sm mute">{t('Waiting for an answer', '等待回复')}</h3>
            {data.invites.map((i: any) => (
              <div key={i.id} className="row between">
                <span>{i.email} <RoleBadge role={i.role} /> <span className="dim fs-sm">{t('expires {when}', '{when}过期', { when: dateTime(i.expires_at) })}</span></span>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act('rv' + i.id, async () => { await api(`/collab/projects/${id}/invites/${i.id}`, { method: 'DELETE' }); await reload(); }, t('Invitation revoked', '邀请已撤回'))}>{t('Revoke', '撤回')}</Button>
              </div>
            ))}
          </div>
        )}
        {admin && (
          <form className="stack s" onSubmit={(e) => { e.preventDefault(); void act('invite', async () => { await api(`/collab/projects/${id}/invites`, { body: { email, role: newRole } }); setEmail(''); await reload(); }, t('Invitation sent', '邀请已发送')); }}>
            <div className="row wrap-row">
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('Email they sign in with', '对方登录所用的邮箱')} aria-label={t('Email', '邮箱')} />
              <Select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} aria-label={t('Role', '角色')}>{grantable.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}</Select>
              <Button variant="primary" disabled={!!busy || !email}>{t('Invite', '邀请')}</Button>
            </div>
            <p className="dim fs-sm">{roleText(newRole)} {t('The invitation is emailed and open for 7 days.', '邀请将通过邮件发送，7 天内有效。')}</p>
          </form>
        )}
      </div>
    </Card>
  );
}

function Protection({ id, data, reload }: { id: string; data: any; reload: () => Promise<void> }) {
  const { busy, act } = useAct();
  const [p, setP] = useState<any>(data.main.protection);
  const set = (k: string, v: unknown) => setP((x: any) => ({ ...x, [k]: v }));
  return (
    <Card title={t('main\'s protection', 'main 的保护规则')} aside={t('What a change needs before it reaches main', '改动进入 main 之前需要满足的条件')} pad>
      <form className="stack m" onSubmit={(e) => { e.preventDefault(); void act('prot', async () => { await api(`/collab/projects/${id}/protection`, { body: p }); await reload(); }, t('Protection saved', '保护规则已保存')); }}>
        <Field label={t('Approvals needed', '所需批准数')} hint={t('From people other than the author. Never more than the people who can review.', '来自作者以外的人；不会超过可审查的人数。')}>
          <Select value={p.required_approvals} onChange={(e) => set('required_approvals', Number(e.target.value))}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
        </Field>
        <label className="row"><Switch checked={p.require_verified} onChange={(e) => set('require_verified', e.target.checked)} /> {t('The proposed version must pass verification', '提交的版本必须通过验证')}</label>
        <label className="row"><Switch checked={p.dismiss_stale} onChange={(e) => set('dismiss_stale', e.target.checked)} /> {t('An approval counts only for the version it reviewed', '批准只对其审查的版本有效')}</label>
        <label className="row"><Switch checked={p.allow_bypass} onChange={(e) => set('allow_bypass', e.target.checked)} /> {t('Admins may merge without approvals or verification (recorded)', '管理员可跳过批准或验证直接合并（会被记录）')}</label>
        <Field label={t('Who may change main directly', '谁可以直接修改 main')}>
          <Select value={p.main_writers} onChange={(e) => set('main_writers', e.target.value)}>
            <option value="maintain">{t('Maintainers and above', '维护者及以上')}</option><option value="admin">{t('Admins and the owner', '管理员和所有者')}</option><option value="owner">{t('Only the owner', '仅所有者')}</option>
          </Select>
        </Field>
        <div className="row end"><Button variant="primary" disabled={!!busy}>{t('Save', '保存')}</Button></div>
      </form>
    </Card>
  );
}
