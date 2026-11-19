import { useState, type FormEvent } from 'react';
import { announceAuth } from '../account-sync';
import { ago, api, navigate, t, useApp, useData } from '../lib';
import { Button, Card, Field, Input, Notice, PageHeader } from '../ui';
import { PageSkeleton } from '../skeletons';

interface AccountData { created_at: number; sessions: { created_at: number; ua: string; current: boolean }[]; delete_blocker: string | null }

/** A rough name for the browser a sign-in came from, from its user agent. */
function deviceOf(ua: string) {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [b, os].filter(Boolean).join(' · ') || t('Unknown device', '未知设备');
}

/** The signed-in person's own account: password, where they are signed in, and deleting the account. */
export function Account() {
  const { user, refresh } = useApp(), { data, reload } = useData<AccountData>('/account');
  const [cur, setCur] = useState(''), [pw, setPw] = useState(''), [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null), [busy, setBusy] = useState('');
  const [endMsg, setEndMsg] = useState(''), [delPw, setDelPw] = useState(''), [sure, setSure] = useState(false), [delErr, setDelErr] = useState('');
  if (!user || !data) return <PageSkeleton />;
  const changePassword = async (e: FormEvent) => {
    e.preventDefault(); setPwMsg(null); setBusy('pw');
    try {
      await api('/auth/password', { body: { current: cur, password: pw } });
      setCur(''); setPw(''); setPwMsg({ ok: true, text: t('Password changed. Every other sign-in was ended.', '密码已修改，其他所有登录已退出。') }); void reload();
    } catch (x) { setPwMsg({ ok: false, text: (x as Error).message }); }
    setBusy('');
  };
  const endOthers = async () => {
    setBusy('end');
    try { const r = await api<{ ended: number }>('/auth/sessions/end-others', { body: {} }); setEndMsg(r.ended === 1 ? t('1 other sign-in was ended.', '已退出 1 个其他登录。') : t('{n} other sign-ins were ended.', '已退出 {n} 个其他登录。', { n: r.ended })); void reload(); }
    catch (x) { setEndMsg((x as Error).message); }
    setBusy('');
  };
  const deleteIt = async (e: FormEvent) => {
    e.preventDefault(); setDelErr(''); setBusy('del');
    try { await api('/account/delete', { body: { password: delPw } }); announceAuth(); await refresh(); navigate('/', true); }
    catch (x) { setDelErr((x as Error).message); setBusy(''); }
  };
  const others = data.sessions.filter((s) => !s.current).length;
  return (
    <div className="wrap page account">
      <PageHeader eyebrow={t('Account', '账户')} title={user.name} sub={<>{user.email} · {t('Joined {when}', '{when}加入', { when: ago(data.created_at) })}</>} />
      <div className="stack l">
        <Card title={t('Password', '密码')} pad>
          <form onSubmit={changePassword} className="stack">
            <Field label={t('Current password', '当前密码')}><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" /></Field>
            <Field label={t('New password', '新密码')} hint={t('At least 8 characters.', '至少 8 个字符。')}><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} autoComplete="new-password" /></Field>
            {pwMsg && <Notice tone={pwMsg.ok ? 'good' : 'bad'} role="alert">{pwMsg.text}</Notice>}
            <div><Button type="submit" variant="primary" disabled={busy === 'pw'}>{t('Change password', '修改密码')}</Button></div>
          </form>
        </Card>
        <Card title={t('Where you are signed in', '登录设备')} pad>
          <div className="stack">
            <ul className="acct-list stack s">
              {data.sessions.map((s, i) => <li key={i} className="row"><b>{deviceOf(s.ua)}</b><span className="mute fs-sm">{t('signed in {when}', '{when}登录', { when: ago(s.created_at) })}</span>{s.current && <span className="sig fs-sm">{t('this browser', '当前浏览器')}</span>}</li>)}
            </ul>
            {endMsg && <Notice tone="good" role="status">{endMsg}</Notice>}
            <div><Button onClick={endOthers} disabled={busy === 'end' || others === 0}>{t('Sign out everywhere else', '退出其他所有设备')}</Button></div>
          </div>
        </Card>
        <Card title={t('Delete your account', '删除账户')} pad>
          <form onSubmit={deleteIt} className="stack">
            <p className="mute">{t('This removes your email, name, password, saves, stats, scores and reviews, and signs you out everywhere. Your purchase records are kept, because the law requires us to keep them, but no longer show who you are. It cannot be undone.', '这会删除你的邮箱、名称、密码、存档、统计、分数和评价，并在所有设备上退出登录。购买记录依法保留，但不再显示你是谁。此操作无法撤销。')}</p>
            {data.delete_blocker ? <Notice tone="info">{data.delete_blocker}</Notice> : <>
              <Field label={t('Your password', '你的密码')}><Input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} required autoComplete="current-password" /></Field>
              <label className="row fs-sm"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> {t('I understand that my account and progress are gone for good.', '我了解我的账户和进度将被永久删除。')}</label>
              {delErr && <Notice tone="bad" role="alert">{delErr}</Notice>}
              <div><Button type="submit" variant="danger" disabled={!sure || busy === 'del'}>{t('Delete my account', '删除我的账户')}</Button></div>
            </>}
          </form>
        </Card>
      </div>
    </div>
  );
}
