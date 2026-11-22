import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { announceAuth } from '../account-sync';
import { api, ApiError, artStyle, shown, Link, navigate, num, query, t, useApp, useData, type GameCard } from '../lib';
import { Button, CelScene, Eyebrow, Field, Input, Notice } from '../ui';
import { PageSkeleton } from '../skeletons';
import { getPasskey, passkeyAutofill, passkeyCancelled, passkeysSupported } from '../passkey';
import { legalTitle } from './Legal';

/** Only same-site paths are allowed as a return target. */
const safeNext = (n: string | null | undefined) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');
/** Server routes (the agent consent screen) need a full page load; app routes do not. */
const go = (to: string) => { if (to.startsWith('/authorize') || to.startsWith('/oauth')) location.href = to; else navigate(to, true); };
const RESEND_S = 30;

/** The sign-in errors in the page's language (the server words them in English); anything else as the server said it. */
export function authError(x: unknown): string {
  const code = x instanceof ApiError ? x.code : '';
  switch (code) {
    case 'bad_email_code': return t('That code is not right. Use the code in the latest email from us.', '验证码不正确。请使用我们最新一封邮件中的验证码。');
    case 'code_expired': return t('This code has expired or had too many wrong tries. Ask for a new code.', '此验证码已过期或输错次数过多。请重新获取验证码。');
    case 'challenge_expired': return t('This sign-in timed out or had too many wrong codes. Start again with your email.', '此次登录已超时或输错验证码次数过多。请重新输入邮箱开始。');
    case 'email_failed': return t('We could not send the email right now. Try again in a few minutes.', '暂时无法发送邮件，请几分钟后再试。');
    case 'bad_token': return t('This link has expired or was already used. Create your account again to get a new link.', '此链接已过期或已被使用。请重新注册以获取新的链接。');
    case 'passkey_failed': return t('That passkey could not be verified. Try again, or sign in with an email code.', '无法验证该通行密钥。请重试，或使用邮箱验证码登录。');
    case 'passkey_unknown': return t('This passkey is not on any account here. Sign in with an email code, then add it on your account page.', '此通行密钥不属于本站的任何账户。请先使用邮箱验证码登录，再在账户页面添加它。');
    case 'passkey_expired': return t('This passkey request expired. Try again.', '此通行密钥请求已过期，请重试。');
    case 'rate_limited': return t('Too many attempts. Try again later.', '尝试次数过多，请稍后再试。');
    default: return (x as Error)?.message || String(x);
  }
}


/** Seconds left before "send again" is offered, counting down from when the last email went out. */
function useCooldown(): [number, () => void] {
  const [until, setUntil] = useState(0), [, tick] = useState(0);
  useEffect(() => { if (!until) return; const i = setInterval(() => { tick((n) => n + 1); if (Date.now() >= until) setUntil(0); }, 1000); return () => clearInterval(i); }, [until]);
  return [until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0, () => setUntil(Date.now() + RESEND_S * 1000)];
}

/**
 * Sign in and sign up, with no password. Signing in: the email, then the 6-digit code we email (and the authenticator
 * code when two-factor is on), or a passkey. Signing up: a display name and the email, then the link we email, which
 * creates the account when it is opened (the Verify page).
 */
export function Auth({ mode, tools }: { mode: 'login' | 'signup'; tools?: ReactNode }) {
  const { user, config } = useApp(), next = safeNext(query().get('next'));
  useEffect(() => { if (user) go(next); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  const forAgent = next.startsWith('/authorize') || next.startsWith('/device');
  return (
    <div className={'auth split' + (forAgent ? ' solo' : '')}>
      {!forAgent && <Showcase />}
      <div className="auth-side">
        <div className="auth-top">
          <Link to="/" className="brand" aria-label={config.settings.brand_name}><i className="logo" aria-hidden="true" /><span>{config.settings.brand_name}</span></Link>
          <span className="auth-tools">{tools}</span>
        </div>
        {mode === 'login' ? <SignIn next={next} forAgent={forAgent} /> : <SignUp next={next} forAgent={forAgent} />}
        <Link to="/" className="auth-home"><span aria-hidden="true">←</span> {t('Back to the store', '返回商店')}</Link>
      </div>
    </div>
  );
}

function SignIn({ next, forAgent }: { next: string; forAgent: boolean }) {
  const { refresh, config } = useApp();
  const [email, setEmail] = useState(query().get('email') || ''), [code, setCode] = useState(''), [handle, setHandle] = useState(''), [challenge, setChallenge] = useState('');
  const [err, setErr] = useState(''), [busy, setBusy] = useState(''), [wait, startWait] = useCooldown(), [resent, setResent] = useState(false);
  const auto = useRef<AbortController | null>(null);
  const done = async () => { announceAuth(); await refresh(); };
  // Passkeys in the email field's autofill list, where the browser offers that; a press on the button works everywhere.
  const signInWithPasskey = async (conditional: boolean) => {
    auto.current?.abort();
    const ctl = new AbortController(); auto.current = ctl;
    if (!conditional) { setErr(''); setBusy('passkey'); }
    try {
      const o = await api<Parameters<typeof getPasskey>[0]>('/auth/passkey/options', { body: { purpose: 'login' } });
      const credential = await getPasskey(o, { conditional, signal: ctl.signal });
      setBusy('passkey');
      await api('/auth/passkey/login', { body: { credential } });
      await done();
    } catch (x) {
      // the autofill offer fails quietly (no passkeys, an unsupported browser): only a pressed button reports a problem
      if (!conditional && !passkeyCancelled(x) && !ctl.signal.aborted) setErr(authError(x));
      setBusy('');
    }
  };
  useEffect(() => { void passkeyAutofill().then((ok) => { if (ok) void signInWithPasskey(true); }); return () => auto.current?.abort(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (e?: FormEvent) => {
    e?.preventDefault(); setErr(''); setBusy('send');
    try {
      const r = await api<{ challenge: string }>('/auth/login', { body: { email, next } });
      auto.current?.abort();
      setResent(!!handle); setHandle(r.challenge); setCode(''); startWait();
    } catch (x) { setErr(authError(x)); }
    setBusy('');
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy('verify');
    try {
      const r = await api<{ two_factor?: boolean; challenge?: string }>('/auth/login/verify', { body: { challenge: handle, code } });
      if (r.two_factor && r.challenge) { setChallenge(r.challenge); setBusy(''); return; }
      await done();
    } catch (x) {
      if (x instanceof ApiError && x.code === 'code_expired') { setHandle(''); setCode(''); }
      setErr(authError(x)); setBusy('');
    }
  };
  if (challenge) return <div className="auth-card"><CodeStep challenge={challenge} onRestart={(msg) => { setChallenge(''); setHandle(''); setCode(''); setErr(msg); }} /></div>;
  if (handle) return (
    <form onSubmit={verify} className="auth-card">
      <div className="stack">
        <Eyebrow tone="accent">{t('Step 2 of 2', '第 2 步，共 2 步')}</Eyebrow>
        <h1>{t('Check your email', '查收邮件')}</h1>
        <p className="mute">{t('If {email} has an account, we sent it a 6-digit code. It works once, for 10 minutes. Check your spam folder if it does not arrive.', '如果 {email} 有账户，我们已向它发送了 6 位验证码。验证码只能使用一次，10 分钟内有效。如果没有收到，请检查垃圾邮件。', { email })}</p>
      </div>
      <Field label={t('6-digit code', '6 位验证码')}>
        <Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} required mono autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="123456" className="otp" />
      </Field>
      {resent && !err && <Notice tone="good" role="status">{t('We sent a new code. Use the one in the latest email.', '我们已发送新的验证码，请使用最新一封邮件中的验证码。')}</Notice>}
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      <Button type="submit" variant="primary" size="lg" block disabled={!!busy || code.length !== 6}>{busy === 'verify' ? t('One moment…', '请稍候…') : t('Sign in', '登录')}</Button>
      <p className="mute switch-line auth-alt">
        <button type="button" className="linkish sig" disabled={wait > 0 || !!busy} onClick={() => void send()}>{wait > 0 ? t('Send a new code in {n}s', '{n} 秒后可重新发送', { n: wait }) : t('Send a new code', '重新发送验证码')}</button>
        <button type="button" className="linkish sig" onClick={() => { setHandle(''); setCode(''); setErr(''); setResent(false); }}>{t('Use a different email', '使用其他邮箱')}</button>
      </p>
    </form>
  );
  return (
    <form onSubmit={send} className="auth-card">
      <div className="stack">
        <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
        <h1>{t('Welcome back', '欢迎回来')}</h1>
        <p className="mute">{forAgent ? t('Sign in to connect your agent. You will confirm what it may do on the next screen.', '登录以连接你的智能体，下一步你将确认它可以执行的操作。') : t('Sign in to play, review and manage your games.', '登录后即可游玩、评价并管理你的游戏。')}</p>
      </div>
      <Field label={t('Email', '邮箱')} hint={t('We email you a code to sign in. There are no passwords.', '我们会通过邮件发送登录验证码，无需密码。')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username webauthn" autoFocus /></Field>
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      <Button type="submit" variant="primary" size="lg" block disabled={!!busy}>{busy === 'send' ? t('One moment…', '请稍候…') : t('Email me a code', '通过邮件发送验证码')}</Button>
      {passkeysSupported() && <>
        <div className="auth-or" aria-hidden="true"><span>{t('or', '或')}</span></div>
        <Button type="button" size="lg" block disabled={!!busy} onClick={() => void signInWithPasskey(false)} icon={<KeyIcon />}>{busy === 'passkey' ? t('One moment…', '请稍候…') : t('Sign in with a passkey', '使用通行密钥登录')}</Button>
      </>}
      <p className="mute switch-line">{t('New here?', '还没有账户？')} <Link to={`/signup?next=${encodeURIComponent(next)}${email ? `&email=${encodeURIComponent(email)}` : ''}`} className="sig">{t('Create an account', '立即注册')}</Link></p>
    </form>
  );
}

function SignUp({ next, forAgent }: { next: string; forAgent: boolean }) {
  const { config } = useApp();
  const [email, setEmail] = useState(query().get('email') || ''), [name, setName] = useState(''), [sent, setSent] = useState(false);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [wait, startWait] = useCooldown(), [again, setAgain] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault(); setErr(''); setBusy(true);
    try { await api('/auth/signup', { body: { email, name, next } }); setAgain(sent); setSent(true); startWait(); } catch (x) { setErr(authError(x)); }
    setBusy(false);
  };
  if (sent) return (
    <div className="auth-card">
      <div className="stack">
        <Eyebrow tone="accent">{t('Step 2 of 2', '第 2 步，共 2 步')}</Eyebrow>
        <h1>{t('Check your email', '查收邮件')}</h1>
        <p className="mute">{t('We sent a link to {email}. Open it to create your account: the account exists only once you do. The link works once, for 24 hours. Check your spam folder if it does not arrive.', '我们已向 {email} 发送了一个链接。打开它即可创建账户：只有打开链接后账户才会创建。链接只能使用一次，24 小时内有效。如果没有收到，请检查垃圾邮件。', { email })}</p>
      </div>
      {again && !err && <Notice tone="good" role="status">{t('We sent a new link. Use the one in the latest email.', '我们已发送新的链接，请使用最新一封邮件中的链接。')}</Notice>}
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      <p className="mute switch-line auth-alt">
        <button type="button" className="linkish sig" disabled={wait > 0 || busy} onClick={() => void submit()}>{wait > 0 ? t('Send a new link in {n}s', '{n} 秒后可重新发送链接', { n: wait }) : t('Send a new link', '重新发送链接')}</button>
        <button type="button" className="linkish sig" onClick={() => { setSent(false); setErr(''); setAgain(false); }}>{t('Use a different email', '使用其他邮箱')}</button>
      </p>
    </div>
  );
  return (
    <form onSubmit={submit} className="auth-card">
      <div className="stack">
        <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
        <h1>{t('Create your account', '创建账户')}</h1>
        <p className="mute">{forAgent ? t('Create an account to connect your agent. You will confirm what it may do after you open the link we email you.', '创建账户以连接你的智能体。打开我们发送的邮件链接后，你将确认它可以执行的操作。') : t('One account for playing and for making games.', '一个账户，既能玩游戏，也能做游戏。')}</p>
      </div>
      {!config.settings.signups_open && <Notice>{t('Sign-ups are closed right now.', '目前暂未开放注册。')}</Notice>}
      <Field label={t('Display name', '显示名称')}><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} autoComplete="nickname" autoFocus /></Field>
      <Field label={t('Email', '邮箱')} hint={t('We email you a link to confirm it. There are no passwords.', '我们会通过邮件发送确认链接，无需密码。')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></Field>
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy}>{busy ? t('One moment…', '请稍候…') : t('Email me a link', '通过邮件发送链接')}</Button>
      <p className="auth-terms">{t('By creating an account you agree to the {terms} and the {privacy}.', '创建账户即表示你同意{terms}和{privacy}。').split(/(\{terms\}|\{privacy\})/).map((part, i) => part === '{terms}' ? <a key={i} href="/legal/terms" target="_blank" rel="noopener">{legalTitle('terms')}</a> : part === '{privacy}' ? <a key={i} href="/legal/privacy" target="_blank" rel="noopener">{legalTitle('privacy')}</a> : part)}</p>
      <p className="mute switch-line">{t('Already have an account?', '已有账户？')} <Link to={`/login?next=${encodeURIComponent(next)}${email ? `&email=${encodeURIComponent(email)}` : ''}`} className="sig">{t('Sign in', '登录')}</Link></p>
    </form>
  );
}

const KeyIcon = () => <svg className="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="7.5" r="3.5" /><path d="M9.6 10l6.4 6.4M13.5 13.9l1.6-1.6M11.6 12l1.4-1.4" /></svg>;

/**
 * Opened from the sign-up email. Shows who the account is for, and creates it (and signs in) only when the person
 * presses the button, so a mail scanner that opens links cannot create accounts.
 */
export function Verify() {
  const { config, refresh, user } = useApp(), tk = query().get('token') || '';
  const { data, error } = useData<{ email: string; name: string; exists: boolean }>(tk ? `/auth/signup/link?token=${encodeURIComponent(tk)}` : null);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [challenge, setChallenge] = useState(''), [after, setAfter] = useState('/');
  const confirm = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api<{ two_factor?: boolean; challenge?: string; next?: string | null }>('/auth/signup/confirm', { body: { token: tk } });
      const to = safeNext(r.next);
      if (r.two_factor && r.challenge) { setAfter(to); setChallenge(r.challenge); setBusy(false); return; }
      announceAuth(); await refresh(); go(to);
    } catch (x) { setErr(authError(x)); setBusy(false); }
  };
  if (challenge) return <div className="auth"><div className="auth-card"><CodeStep challenge={challenge} onDone={() => go(after)} onRestart={() => navigate('/login', true)} /></div></div>;
  const broken = !tk || error;
  return (
    <div className="auth"><div className="auth-card wide">
      <Eyebrow tone="accent">{config.settings.brand_name}</Eyebrow>
      {broken ? <>
        <h1>{t('This link does not work', '此链接无效')}</h1>
        <p className="mute">{tk ? authError(error) : t('The link is missing its token.', '链接缺少令牌参数。')}</p>
        <Button to="/signup" variant="primary" size="lg" block>{t('Get a new link', '获取新的链接')}</Button>
        <p className="mute switch-line">{t('Already have an account?', '已有账户？')} <Link to="/login" className="sig">{t('Sign in', '登录')}</Link></p>
      </> : !data ? <PageSkeleton /> : <>
        <h1>{data.exists ? t('Sign in to your account', '登录你的账户') : t('Create your account', '创建账户')}</h1>
        <p className="mute">{data.exists
          ? t('{email} already has an account. This link signs you in to it.', '{email} 已经有账户了。此链接会让你登录该账户。', { email: data.email })
          : t('Your email {email} is confirmed. Create your account as {name}?', '你的邮箱 {email} 已确认。要以 {name} 的名称创建账户吗？', { email: data.email, name: data.name })}</p>
        {user && <Notice tone="info">{t('You are signed in as {name}. Continuing signs this browser in to the account for {email} instead.', '你当前以 {name} 的身份登录。继续操作会让此浏览器改为登录 {email} 的账户。', { name: user.name, email: data.email })}</Notice>}
        {err && <Notice tone="bad" role="alert">{err}</Notice>}
        <Button variant="primary" size="lg" block disabled={busy} onClick={() => void confirm()}>{busy ? t('One moment…', '请稍候…') : data.exists ? t('Sign in', '登录') : t('Create my account', '创建我的账户')}</Button>
        {!data.exists && <p className="auth-terms">{t('By creating an account you agree to the {terms} and the {privacy}.', '创建账户即表示你同意{terms}和{privacy}。').split(/(\{terms\}|\{privacy\})/).map((part, i) => part === '{terms}' ? <a key={i} href="/legal/terms" target="_blank" rel="noopener">{legalTitle('terms')}</a> : part === '{privacy}' ? <a key={i} href="/legal/privacy" target="_blank" rel="noopener">{legalTitle('privacy')}</a> : part)}</p>}
      </>}
    </div></div>
  );
}

/** The other half of the sign-in page: the rendered scene, a few of the store's covers and what the account is for. */
function Showcase() {
  const { data } = useData<{ stats: { games: number; creators: number }; shelves: { trending: GameCard[]; new: GameCard[] } }>('/home');
  const covers = data ? [...data.shelves.trending, ...data.shelves.new].filter((g, i, a) => !g.mature?.length && a.findIndex((x) => x.id === g.id) === i).slice(0, 4).map(shown) : [];
  return (
    <aside className="auth-show ink" aria-hidden="true">
      <CelScene seed={4} />
      <div className="auth-pitch">
        <b>{data ? t('{games} web games. One account.', '{games} 款网页游戏，一个账户。', { games: num(data.stats.games) }) : t('Web games. One account.', '网页游戏，一个账户。')}</b>
        <span>{t('Play in your browser, keep your library, rate what you love, and publish your own with your agent.', '在浏览器里畅玩，收藏游戏库，为喜欢的作品评分，还能用智能体发布你自己的游戏。')}</span>
        {covers.length > 0 && <div className="auth-wall">{covers.map((g, k) => <span key={g.id} className={'aw' + k} style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" loading="lazy" />}</span>)}</div>}
      </div>
    </aside>
  );
}

/**
 * The second step of a sign-in when the account has two-factor on: a 6-digit code from the authenticator app, or one of
 * the recovery codes. Signs the browser in when it is right; a timed-out sign-in starts again from the email.
 */
export function CodeStep({ challenge, onRestart, onDone }: { challenge: string; onRestart: (message: string) => void; onDone?: () => void }) {
  const { refresh } = useApp(), [code, setCode] = useState(''), [recovery, setRecovery] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await api('/auth/login/code', { body: { challenge, code } }); announceAuth(); await refresh(); onDone?.(); }
    catch (x) {
      if (x instanceof ApiError && x.code === 'challenge_expired') { onRestart(authError(x)); return; }
      setErr(authError(x)); setCode(''); setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack">
      <div className="stack">
        <Eyebrow tone="accent">{t('Two-factor sign-in', '两步验证登录')}</Eyebrow>
        <h1>{recovery ? t('Enter a recovery code', '输入恢复码') : t('Enter your code', '输入验证码')}</h1>
        <p className="mute">{recovery
          ? t('Use one of the recovery codes you saved when you turned on two-factor sign-in. Each code works once.', '使用你开启两步验证时保存的恢复码之一。每个恢复码只能使用一次。')
          : t('Open your authenticator app and enter the 6-digit code it shows for this account.', '打开你的身份验证器应用，输入它为此账户显示的 6 位数字验证码。')}</p>
      </div>
      <Field label={recovery ? t('Recovery code', '恢复码') : t('6-digit code', '6 位验证码')}>
        {recovery
          ? <Input key="rc" value={code} onChange={(e) => setCode(e.target.value)} required mono autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="xxxxx-xxxxx" maxLength={20} />
          : <Input key="otp" value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} required mono autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="123456" className="otp" />}
      </Field>
      {err && <Notice tone="bad" role="alert">{err}</Notice>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy || (!recovery && code.length !== 6)}>{busy ? t('One moment…', '请稍候…') : t('Verify and sign in', '验证并登录')}</Button>
      <p className="mute switch-line">
        <button type="button" className="linkish sig" onClick={() => { setRecovery(!recovery); setCode(''); setErr(''); }}>{recovery ? t('Use the authenticator app instead', '改用身份验证器应用') : t('Lost your phone? Use a recovery code', '手机丢了？使用恢复码')}</button>
      </p>
      {recovery && <p className="dim fs-sm">{t('No recovery codes either? Contact us from the email on your account and we will help you get back in.', '恢复码也没有了？请用账户邮箱联系我们，我们会帮你恢复访问。')}</p>}
    </form>
  );
}

/** The first administrator claims the platform with the one-time link printed at deploy time. */
export function ClaimAdmin() {
  const { refresh, user } = useApp(), [state, setState] = useState<'idle' | 'busy' | 'done' | 'fail'>('idle'), [msg, setMsg] = useState('');
  const token = query().get('token') || '';
  const claim = async () => {
    setState('busy');
    try { await api('/claim-admin', { body: { token } }); await refresh(); setState('done'); }
    catch (e) { setMsg((e as Error).message); setState('fail'); }
  };
  if (!user) return <PageSkeleton />;
  return (
    <div className="auth"><div className="auth-card wide">
      <Eyebrow tone="accent">{t('Platform setup', '平台初始化')}</Eyebrow>
      <h1>{state === 'done' ? t('You are the administrator', '你已成为管理员') : t('Claim the admin console', '认领管理后台')}</h1>
      {state === 'done' ? <><p className="mute">{t('This link no longer works for anyone else. Open the admin console to set prices, limits and payouts.', '该链接已对其他人失效。打开管理后台即可设置价格、限制与提现规则。')}</p><Button to="/admin" variant="primary" size="lg" block>{t('Open admin console', '打开管理后台')}</Button></> : (
        <>
          <p className="mute">{t('This makes the account you are signed in with', '此操作会将当前登录的账户')} <b style={{ color: 'var(--text)' }}>{user.email}</b> {t('the first administrator. It works once.', '设为首位管理员，且只能使用一次。')}</p>
          {state === 'fail' && <Notice tone="bad" role="alert">{msg}</Notice>}
          {!token && <Notice tone="bad">{t('The link is missing its token.', '链接缺少令牌参数。')}</Notice>}
          <Button variant="primary" size="lg" block onClick={claim} disabled={!token || state === 'busy'}>{t('Make me the administrator', '设为管理员')}</Button>
        </>
      )}
    </div></div>
  );
}
