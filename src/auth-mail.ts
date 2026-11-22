// The sign-up and sign-in emails, in the six languages of the web app (the language the person was using on the page).
// Each one says plainly what it is for and what to do if the person did not ask for it.
import type { Lang } from '../web/src/i18n/langs';
import type { Env } from './env';
import { sendMail } from './mail';
import { getSettings } from './settings';

export type AuthMail =
  | { kind: 'signup_link'; name: string; link: string }      // open the link to create the account
  | { kind: 'signup_exists'; link: string }                   // that email already has an account: sign in instead
  | { kind: 'login_code'; name: string; code: string }        // the sign-in code
  | { kind: 'login_unknown'; link: string }                   // no account uses this email: create one
  | { kind: 'confirm_code'; name: string; code: string };     // the code that confirms a change on the account page

type Parts = { subject: string; lines: string[]; button?: string };
type Text = { hi: (n: string) => string; ignore: string } & { [K in AuthMail['kind']]: (brand: string, m: any) => Parts };

const TEXT: Record<Lang, Text> = {
  en: {
    hi: (n) => (n ? `Hi ${n},` : 'Hi,'), ignore: 'If you did not ask for this, you can ignore this email. Nothing changes on any account.',
    signup_link: (b) => ({ subject: `${b}: confirm your email to create your account`, lines: [`Open the link below to create your ${b} account. Your account is created only when you open it. The link works once, for 24 hours.`], button: 'Create my account' }),
    signup_exists: (b) => ({ subject: `${b}: you already have an account`, lines: [`Someone tried to create a ${b} account with this email, but you already have one. Sign in instead: we will email you a code.`], button: 'Sign in' }),
    login_code: (b, m) => ({ subject: `${m.code} is your ${b} sign-in code`, lines: [`Your sign-in code is ${m.code}`, 'Enter it on the sign-in page within 10 minutes. It works once. Never share it: we will never ask you for it.'] }),
    login_unknown: (b) => ({ subject: `${b}: no account uses this email`, lines: [`Someone tried to sign in to ${b} with this email, but no account uses it. If it was you, create an account instead.`], button: 'Create an account' }),
    confirm_code: (b, m) => ({ subject: `${m.code} is your ${b} confirmation code`, lines: [`Your confirmation code is ${m.code}`, 'Enter it on your account page within 10 minutes to confirm a change to your sign-in settings. Never share it.'] }),
  },
  zh: {
    hi: (n) => (n ? `${n}，你好：` : '你好：'), ignore: '如果这不是你本人操作，请忽略此邮件，任何账户都不会有变化。',
    signup_link: (b) => ({ subject: `${b}：确认邮箱以创建账户`, lines: [`打开下面的链接即可创建你的 ${b} 账户。只有打开链接后账户才会创建。链接只能使用一次，24 小时内有效。`], button: '创建我的账户' }),
    signup_exists: (b) => ({ subject: `${b}：你已经有账户了`, lines: [`有人尝试用这个邮箱创建 ${b} 账户，但你已经有账户了。请直接登录，我们会向你发送验证码。`], button: '登录' }),
    login_code: (b, m) => ({ subject: `${m.code} 是你的 ${b} 登录验证码`, lines: [`你的登录验证码是 ${m.code}`, '请在 10 分钟内在登录页面输入，验证码只能使用一次。请勿告诉任何人，我们绝不会向你索要。'] }),
    login_unknown: (b) => ({ subject: `${b}：没有账户使用这个邮箱`, lines: [`有人尝试用这个邮箱登录 ${b}，但没有账户使用它。如果是你本人，请先创建账户。`], button: '创建账户' }),
    confirm_code: (b, m) => ({ subject: `${m.code} 是你的 ${b} 确认码`, lines: [`你的确认码是 ${m.code}`, '请在 10 分钟内在账户页面输入，以确认对登录设置的修改。请勿告诉任何人。'] }),
  },
  'zh-TW': {
    hi: (n) => (n ? `${n}，你好：` : '你好：'), ignore: '如果這不是你本人操作，請忽略此郵件，任何帳戶都不會有變化。',
    signup_link: (b) => ({ subject: `${b}：確認電子郵件以建立帳戶`, lines: [`開啟下方連結即可建立你的 ${b} 帳戶。只有開啟連結後帳戶才會建立。連結只能使用一次，24 小時內有效。`], button: '建立我的帳戶' }),
    signup_exists: (b) => ({ subject: `${b}：你已經有帳戶了`, lines: [`有人嘗試用這個電子郵件建立 ${b} 帳戶，但你已經有帳戶了。請直接登入，我們會寄驗證碼給你。`], button: '登入' }),
    login_code: (b, m) => ({ subject: `${m.code} 是你的 ${b} 登入驗證碼`, lines: [`你的登入驗證碼是 ${m.code}`, '請在 10 分鐘內於登入頁面輸入，驗證碼只能使用一次。請勿告訴任何人，我們絕不會向你索取。'] }),
    login_unknown: (b) => ({ subject: `${b}：沒有帳戶使用這個電子郵件`, lines: [`有人嘗試用這個電子郵件登入 ${b}，但沒有帳戶使用它。如果是你本人，請先建立帳戶。`], button: '建立帳戶' }),
    confirm_code: (b, m) => ({ subject: `${m.code} 是你的 ${b} 確認碼`, lines: [`你的確認碼是 ${m.code}`, '請在 10 分鐘內於帳戶頁面輸入，以確認對登入設定的變更。請勿告訴任何人。'] }),
  },
  ja: {
    hi: (n) => (n ? `${n} さん` : 'こんにちは'), ignore: 'お心当たりがない場合は、このメールを無視してください。どのアカウントにも変更はありません。',
    signup_link: (b) => ({ subject: `${b}：メールアドレスを確認してアカウントを作成`, lines: [`下のリンクを開くと ${b} のアカウントが作成されます。リンクを開くまでアカウントは作成されません。リンクは 1 回限り、24 時間有効です。`], button: 'アカウントを作成' }),
    signup_exists: (b) => ({ subject: `${b}：すでにアカウントがあります`, lines: [`このメールアドレスで ${b} のアカウントを作成しようとした人がいますが、すでにアカウントがあります。代わりにログインしてください。コードをメールでお送りします。`], button: 'ログイン' }),
    login_code: (b, m) => ({ subject: `${m.code} は ${b} のログインコードです`, lines: [`ログインコード：${m.code}`, '10 分以内にログイン画面で入力してください。コードは 1 回限りです。誰にも教えないでください。こちらから尋ねることはありません。'] }),
    login_unknown: (b) => ({ subject: `${b}：このメールアドレスのアカウントはありません`, lines: [`このメールアドレスで ${b} にログインしようとした人がいますが、このアドレスを使うアカウントはありません。ご本人の場合は、アカウントを作成してください。`], button: 'アカウントを作成' }),
    confirm_code: (b, m) => ({ subject: `${m.code} は ${b} の確認コードです`, lines: [`確認コード：${m.code}`, 'ログイン設定の変更を確認するため、10 分以内にアカウントページで入力してください。誰にも教えないでください。'] }),
  },
  ko: {
    hi: (n) => (n ? `${n}님, 안녕하세요.` : '안녕하세요.'), ignore: '요청하지 않으셨다면 이 메일을 무시하셔도 됩니다. 어떤 계정에도 변경 사항이 없습니다.',
    signup_link: (b) => ({ subject: `${b}: 이메일을 확인하고 계정을 만드세요`, lines: [`아래 링크를 열면 ${b} 계정이 만들어집니다. 링크를 열어야만 계정이 만들어집니다. 링크는 한 번만, 24시간 동안 사용할 수 있습니다.`], button: '내 계정 만들기' }),
    signup_exists: (b) => ({ subject: `${b}: 이미 계정이 있습니다`, lines: [`누군가 이 이메일로 ${b} 계정을 만들려고 했지만 이미 계정이 있습니다. 대신 로그인하세요. 코드를 이메일로 보내 드립니다.`], button: '로그인' }),
    login_code: (b, m) => ({ subject: `${m.code}은(는) ${b} 로그인 코드입니다`, lines: [`로그인 코드: ${m.code}`, '10분 안에 로그인 페이지에 입력하세요. 한 번만 사용할 수 있습니다. 누구에게도 알려 주지 마세요. 저희는 절대 코드를 묻지 않습니다.'] }),
    login_unknown: (b) => ({ subject: `${b}: 이 이메일을 사용하는 계정이 없습니다`, lines: [`누군가 이 이메일로 ${b}에 로그인하려 했지만 이 이메일을 사용하는 계정이 없습니다. 본인이라면 계정을 만드세요.`], button: '계정 만들기' }),
    confirm_code: (b, m) => ({ subject: `${m.code}은(는) ${b} 확인 코드입니다`, lines: [`확인 코드: ${m.code}`, '로그인 설정 변경을 확인하려면 10분 안에 계정 페이지에 입력하세요. 누구에게도 알려 주지 마세요.'] }),
  },
  es: {
    hi: (n) => (n ? `Hola, ${n}:` : 'Hola:'), ignore: 'Si no lo pediste, ignora este correo. No cambia nada en ninguna cuenta.',
    signup_link: (b) => ({ subject: `${b}: confirma tu correo para crear tu cuenta`, lines: [`Abre el enlace de abajo para crear tu cuenta de ${b}. La cuenta solo se crea cuando lo abres. El enlace funciona una vez, durante 24 horas.`], button: 'Crear mi cuenta' }),
    signup_exists: (b) => ({ subject: `${b}: ya tienes una cuenta`, lines: [`Alguien intentó crear una cuenta de ${b} con este correo, pero ya tienes una. Inicia sesión: te enviaremos un código por correo.`], button: 'Iniciar sesión' }),
    login_code: (b, m) => ({ subject: `${m.code} es tu código para iniciar sesión en ${b}`, lines: [`Tu código para iniciar sesión es ${m.code}`, 'Escríbelo en la página de inicio de sesión en menos de 10 minutos. Funciona una vez. No lo compartas: nunca te lo pediremos.'] }),
    login_unknown: (b) => ({ subject: `${b}: ninguna cuenta usa este correo`, lines: [`Alguien intentó iniciar sesión en ${b} con este correo, pero ninguna cuenta lo usa. Si fuiste tú, crea una cuenta.`], button: 'Crear una cuenta' }),
    confirm_code: (b, m) => ({ subject: `${m.code} es tu código de confirmación de ${b}`, lines: [`Tu código de confirmación es ${m.code}`, 'Escríbelo en la página de tu cuenta en menos de 10 minutos para confirmar un cambio en tu forma de iniciar sesión. No lo compartas.'] }),
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/** The email's subject, plain text and HTML (exported for the tests). */
export function renderAuthMail(lang: Lang, brand: string, m: AuthMail): { subject: string; text: string; html: string } {
  const T = TEXT[lang] || TEXT.en, p = T[m.kind](brand, m), name = 'name' in m ? m.name : '';
  const link = 'link' in m ? m.link : null, code = 'code' in m ? m.code : null;
  const text = [T.hi(name), ...p.lines, ...(link ? [link] : []), T.ignore, `— ${brand}`].join('\n\n');
  const lines = p.lines.map((l, i) => code && i === 0
    ? `<p style="font-size:15px">${esc(l.replace(code, '')).trim()}</p><p style="font:700 32px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:6px;margin:8px 0 18px">${esc(code)}</p>`
    : `<p>${esc(l)}</p>`).join('');
  const button = link ? `<p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#d8462b;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:6px">${esc(p.button || link)}</a></p><p style="font-size:12px;color:#666;word-break:break-all">${esc(link)}</p>` : '';
  const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17151c;max-width:520px"><p>${esc(T.hi(name))}</p>${lines}${button}<p style="font-size:13px;color:#666">${esc(T.ignore)}</p><p>— ${esc(brand)}</p></div>`;
  return { subject: p.subject, text, html };
}

/** Sends one of the sign-in emails. False when it could not be sent. */
export async function sendAuthMail(env: Env, to: string, lang: Lang, m: AuthMail): Promise<boolean> {
  const brand = (await getSettings(env)).brand_name || 'HearthCade';
  return sendMail(env, { to, ...renderAuthMail(lang, brand, m) });
}
