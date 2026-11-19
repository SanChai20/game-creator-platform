// Email to users through Cloudflare Email Service (the EMAIL send_email binding). Sending needs the site's domain onboarded
// as a sending domain (Dashboard: Compute > Email Service > Email Sending). Without the binding or the domain, email is
// skipped or fails quietly: it is a courtesy, never something money or access waits on.
import type { Env } from './env';
import { getSettings } from './settings';

export interface Mail { to: string; subject: string; text: string; html: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const originOf = (env: Env) => env.PUBLIC_ORIGIN || 'https://hearthcade.com';

export async function sendMail(env: Env, m: Mail): Promise<boolean> {
  if (!env.EMAIL) return false;
  try {
    const host = new URL(originOf(env)).hostname.replace(/^www\./, '');
    const name = (await getSettings(env)).brand_name || 'HearthCade';
    await env.EMAIL.send({ from: { email: `notifications@${host}`, name }, to: m.to, subject: m.subject, text: m.text, html: m.html });
    return true;
  } catch (e) {
    console.error('email not sent:', m.subject, (e as Error).message);
    return false;
  }
}

/** Tells a creator that a payout was sent to their Stripe payout account. */
export async function payoutSentMail(env: Env, userId: string, amountCents: number): Promise<boolean> {
  const u = await env.DB.prepare('SELECT email, name FROM users WHERE id = ?').bind(userId).first<{ email: string; name: string }>();
  if (!u?.email) return false;
  const brand = (await getSettings(env)).brand_name || 'HearthCade';
  const amount = usd(amountCents), link = `${originOf(env)}/console/earnings`;
  const body = `We sent ${amount} of your game sales to your payout account. Stripe pays it into your bank account on your payout schedule, usually within a few business days.`;
  return sendMail(env, {
    to: u.email,
    subject: `${brand}: ${amount} is on its way to you`,
    text: [`Hi ${u.name},`, body, `See the details on your Earnings page: ${link}`, `— ${brand}`].join('\n\n'),
    html: `<p>Hi ${esc(u.name)},</p><p>${esc(body)}</p><p><a href="${esc(link)}">See the details on your Earnings page</a></p><p>— ${esc(brand)}</p>`,
  });
}

/** The password reset link (security review, finding 8). Returns false when email cannot be sent. */
export async function passwordResetMail(env: Env, to: string, name: string, link: string): Promise<boolean> {
  const brand = (await getSettings(env)).brand_name || 'HearthCade';
  const body = 'Someone asked to reset the password of your account. If it was you, open the link below within an hour to choose a new password. If it was not you, ignore this email: your password stays as it is.';
  return sendMail(env, {
    to, subject: `${brand}: reset your password`,
    text: [`Hi ${name},`, body, link, `— ${brand}`].join('\n\n'),
    html: `<p>Hi ${esc(name)},</p><p>${esc(body)}</p><p><a href="${esc(link)}">Choose a new password</a></p><p>— ${esc(brand)}</p>`,
  });
}
