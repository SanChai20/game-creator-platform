import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ago, api, navigate, query, t, useApp } from '../lib';
import { Button, Eyebrow, Field, Input, ListPager, Notice, StatusBadge, Ticks, useClientPage } from '../ui';

interface SelectableProject { id: string; slug: string; title: string; status: string }
interface Pending {
  user_code: string; client_name: string; created_at: number; expires_at: number; grant_days: number;
  from?: string | null; elsewhere?: boolean; projects?: SelectableProject[];
}
const tidy = (raw: string) => { const s = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8); return s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s; };

/** Where a creator approves an agent that cannot open a browser itself. The agent showed them a link here and a code. */
export function Device() {
  const { user, config } = useApp();
  const [code, setCode] = useState(tidy(query().get('code') || '')), [req, setReq] = useState<Pending | null>(null);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const [projectScope, setProjectScope] = useState<'all' | 'selected'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  // Opened from a link with the code already in it: the person confirms the agent is theirs before Allow is offered,
  // since a link is exactly what someone phishing for access would send.
  const linked = !!query().get('code'), [mine, setMine] = useState(false);

  const projects = req?.projects || [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? projects.filter((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)) : projects;
  }, [projects, search]);
  const pg = useClientPage(filtered, 8, [req?.user_code, search]);

  const look = async (c: string) => {
    setErr(''); setBusy(true);
    try {
      const next = await api<Pending>('/device/' + encodeURIComponent(c));
      setReq(next);
      setProjectScope('all');
      setSelectedIds(new Set());
      setSearch('');
    } catch (e) { setReq(null); setErr((e as Error).message); }
    setBusy(false);
  };
  useEffect(() => { if (user && code.length === 9) look(code); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleProject = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of filtered) next.add(p.id);
      return next;
    });
  };
  const clearSelected = () => setSelectedIds(new Set());

  const decide = async (decision: 'approve' | 'deny') => {
    if (!req) return;
    setErr(''); setBusy(true);
    try {
      const body = decision === 'approve'
        ? { decision, project_scope: projectScope, ...(projectScope === 'selected' ? { project_ids: [...selectedIds] } : {}) }
        : { decision };
      await api('/device/' + encodeURIComponent(req.user_code), { body });
      setDone(decision === 'approve' ? 'approved' : 'denied');
    } catch (e) {
      const ae = e as Error & { status?: number };
      setErr(ae.message);
      if (ae.status === 404 || ae.status === 410) setReq(null);
    }
    setBusy(false);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (code.length === 9) look(code); };

  let body;
  if (done) {
    body = (
      <>
        <h1>{done === 'approved' ? t('Your agent is connected', '智能体已连接') : t('Request declined', '已拒绝该请求')}</h1>
        <p className="mute">{done === 'approved'
          ? t('Go back to your agent: it picks this up within a few seconds and can start working. You can close this tab.', '回到你的智能体即可，它会在几秒内收到授权并开始工作。此页面可以关闭。')
          : t('Nothing was shared. The agent has been told the request was declined.', '未共享任何内容，智能体已被告知请求遭到拒绝。')}</p>
        <Button to="/console" size="lg" block>{t('Open your console', '打开控制台')}</Button>
      </>
    );
  } else if (req) {
    const canApprove = !busy && (!linked || mine) && (projectScope === 'all' || selectedIds.size > 0);
    body = (
      <>
        <h1>{t('Let “{client_name}” make games for you?', '允许“{client_name}”为你制作游戏吗？', { client_name: req.client_name })}</h1>
        <p className="mute">{t('Signed in as', '当前登录账户')} <b style={{ color: 'var(--text)' }}>{user!.name}</b> ({user!.email}). {t('Code', '验证码')} <b className="mono" style={{ color: 'var(--text)' }}>{req.user_code}</b>.</p>
        <Notice tone="bad">{t('Allow this only if your own agent just showed you this code. The agent chose its own name, so the name proves nothing. If someone else sent you this link, choose Deny.', '仅当这个验证码是你自己的智能体刚刚显示给你的，才可以允许。名称由智能体自行填写，不能作为凭据。如果链接是别人发给你的，请选择拒绝。')}</Notice>
        <p className="mute fs-sm">{req.from ? t('Requested {when} from around {place}.', '{when}从{place}附近发起。', { when: ago(req.created_at), place: req.from }) : t('Requested {when}.', '{when}发起。', { when: ago(req.created_at) })}</p>
        {req.elsewhere && <Notice tone="bad" role="alert">{t('This request came from another country than the one you are in. If you are not running an agent there, choose Deny.', '该请求来自与你当前所在不同的国家或地区。如果你没有在那里运行智能体，请选择拒绝。')}</Notice>}
        {linked && <label className="row fs-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {t('I started this sign-in myself, from my own agent, just now.', '这个登录是我自己刚刚从我的智能体发起的。')}</label>}

        <div className="scope-box">
          <Eyebrow>{t('Project access', '项目访问权限')}</Eyebrow>
          <label className={`scope-opt${projectScope === 'all' ? ' on' : ''}`}>
            <input type="radio" name="project_scope" checked={projectScope === 'all'} onChange={() => setProjectScope('all')} />
            <span>
              <b>{t('All projects (including new ones)', '所有项目（包含新建项目）')}</b>
              <small>{t('Full creator access across every game in your account.', '可访问账户下的所有游戏项目，并可创建新项目。')}</small>
            </span>
          </label>
          <label className={`scope-opt${projectScope === 'selected' ? ' on' : ''}`} style={!projects.length ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
            <input type="radio" name="project_scope" checked={projectScope === 'selected'} disabled={!projects.length} onChange={() => setProjectScope('selected')} />
            <span>
              <b>{t('Only selected projects', '仅所选项目')}</b>
              <small>{projects.length
                ? t('Restrict this agent to the projects you check below. It cannot create new projects.', '将该智能体限制在你下方勾选的项目范围内，且无法创建新项目。')
                : t('You have no projects yet. Authorize all projects first so your agent can create one.', '你还没有项目。请先授权所有项目，以便智能体创建第一个项目。')}</small>
            </span>
          </label>
          {projectScope === 'selected' && projects.length > 0 && (
            <div className="stack s">
              {projects.length > 6 && (
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search projects…', '搜索项目…')} aria-label={t('Search projects…', '搜索项目…')} />
              )}
              <div className="scope-list">
                <div className="scope-list-bar">
                  <span className="mute num">{t('{n} selected', '已选 {n} 个', { n: selectedIds.size })}</span>
                  <div className="row s">
                    <Button type="button" size="sm" variant="ghost" onClick={selectVisible}>{t('Select all', '全选')}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={clearSelected} disabled={!selectedIds.size}>{t('Clear', '清空')}</Button>
                  </div>
                </div>
                {pg.slice.length ? pg.slice.map((p) => (
                  <label key={p.id} className="scope-proj">
                    <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleProject(p.id)} />
                    <span className="scope-proj-main">
                      <strong>{p.title}</strong>
                      <span>/{p.slug}</span>
                    </span>
                    <StatusBadge status={p.status} />
                  </label>
                )) : <div className="pad mute fs-sm">{t('No matching projects.', '没有匹配的项目。')}</div>}
                <ListPager flush compact page={pg.page} total={pg.total} perPage={pg.perPage} onPage={pg.setPage} />
              </div>
              {!selectedIds.size && <p className="bad fs-sm">{t('Select at least one project to continue.', '请至少选择一个项目以继续。')}</p>}
            </div>
          )}
        </div>

        <Ticks items={[t('Create and edit your game projects', '创建并编辑你的游戏项目'), t('Deploy previews and run verification', '部署预览并运行验证'), t('Publish, roll back and take games offline', '发布、回滚与下线游戏'), t('Set listing details and prices, and read your game stats', '设置上架信息与价格，查看游戏数据')]} />
        <p className="mute">{t('It cannot withdraw money, change your password or see payment details.', '它无法提现、修改密码或查看支付信息。')}</p>
        {err && <Notice tone="bad" role="alert">{err}</Notice>}
        <div className="row">
          <Button type="button" size="lg" className="grow" disabled={busy} onClick={() => decide('deny')}>{t('Deny', '拒绝')}</Button>
          <Button type="button" variant="primary" size="lg" className="grow" disabled={!canApprove} onClick={() => decide('approve')}>{t('Allow', '允许')}</Button>
        </div>
        <p className="dim fs-sm">{(req.grant_days === 1 ? t('Access expires after 1 day; you can revoke it sooner from your console.', '访问权限将在 1 天后过期，你也可以随时在控制台提前撤销。') : t('Access expires after {n} days; you can revoke it sooner from your console.', '访问权限将在 {n} 天后过期，你也可以随时在控制台提前撤销。', { n: req.grant_days }))}</p>
      </>
    );
  } else {
    body = (
      <>
        <h1>{t('Connect an agent', '连接智能体')}</h1>
        <p className="mute">{t('Enter the code your agent showed you. You will see what it is asking for before anything is shared.', '输入智能体显示给你的验证码。在共享任何内容之前，你会先看到它请求的权限。')}</p>
        <Field label={t('Code', '验证码')}>
          <Input mono className="code-input" value={code} onChange={(e) => setCode(tidy(e.target.value))} placeholder="BCDF-GHJK" autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-label={t('Code', '验证码')} />
        </Field>
        {err && <Notice tone="bad" role="alert">{err}</Notice>}
        <Button type="submit" variant="primary" size="lg" block disabled={busy || code.length !== 9}>{busy ? t('One moment…', '请稍候…') : t('Continue', '继续')}</Button>
      </>
    );
  }
  return (
    <div className="auth">
      <form onSubmit={submit} className="auth-card wide">
        <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
        {body}
        {!done && !req && <p className="dim fs-sm center"><a onClick={(e) => { e.preventDefault(); navigate('/create'); }} href="/create" className="sig">{t('How agents connect', '了解智能体如何连接')}</a></p>}
      </form>
    </div>
  );
}
