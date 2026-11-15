import { useEffect, useState, type FormEvent } from 'react';
import { api, navigate, query, t, useApp } from '../lib';
import { Button, Eyebrow, Field, Input, Notice, Ticks } from '../ui';

interface Pending { user_code: string; client_name: string; created_at: number; expires_at: number; grant_days: number }
const tidy = (raw: string) => { const s = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8); return s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s; };

/** Where a creator approves an agent that cannot open a browser itself. The agent showed them a link here and a code. */
export function Device() {
  const { user, config } = useApp();
  const [code, setCode] = useState(tidy(query().get('code') || '')), [req, setReq] = useState<Pending | null>(null);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const look = async (c: string) => {
    setErr(''); setBusy(true);
    try { setReq(await api<Pending>('/device/' + encodeURIComponent(c))); } catch (e) { setReq(null); setErr((e as Error).message); }
    setBusy(false);
  };
  useEffect(() => { if (user && code.length === 9) look(code); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = async (decision: 'approve' | 'deny') => {
    if (!req) return;
    setErr(''); setBusy(true);
    try { await api('/device/' + encodeURIComponent(req.user_code), { body: { decision } }); setDone(decision === 'approve' ? 'approved' : 'denied'); }
    catch (e) { setErr((e as Error).message); setReq(null); }
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
    body = (
      <>
        <h1>{t(`Let “${req.client_name}” make games for you?`, `允许“${req.client_name}”为你制作游戏吗？`)}</h1>
        <p className="mute">{t('Signed in as', '当前登录账户')} <b style={{ color: 'var(--text)' }}>{user!.name}</b> ({user!.email}). {t('Code', '验证码')} <b className="mono" style={{ color: 'var(--text)' }}>{req.user_code}</b>.</p>
        <Notice tone="bad">{t('Allow this only if your own agent just showed you this code. The agent chose its own name, so the name proves nothing. If someone else sent you this link, choose Deny.', '仅当这个验证码是你自己的智能体刚刚显示给你的，才可以允许。名称由智能体自行填写，不能作为凭据。如果链接是别人发给你的，请选择拒绝。')}</Notice>
        <Ticks items={[t('Create and edit your game projects', '创建并编辑你的游戏项目'), t('Deploy previews and run verification', '部署预览并运行验证'), t('Publish, roll back and take games offline', '发布、回滚与下线游戏'), t('Set listing details and prices, and read your game stats', '设置上架信息与价格，查看游戏数据')]} />
        <p className="mute">{t('It cannot withdraw money, change your password or see payment details.', '它无法提现、修改密码或查看支付信息。')}</p>
        {err && <Notice tone="bad" role="alert">{err}</Notice>}
        <div className="row">
          <Button type="button" size="lg" className="grow" disabled={busy} onClick={() => decide('deny')}>{t('Deny', '拒绝')}</Button>
          <Button type="button" variant="primary" size="lg" className="grow" disabled={busy} onClick={() => decide('approve')}>{t('Allow', '允许')}</Button>
        </div>
        <p className="dim fs-sm">{t(`Access expires after ${req.grant_days} day${req.grant_days === 1 ? '' : 's'}; you can revoke it sooner from your console.`, `访问权限将在 ${req.grant_days} 天后过期，你也可以随时在控制台提前撤销。`)}</p>
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
