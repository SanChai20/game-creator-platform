// Email to users through Cloudflare Email Service (the EMAIL send_email binding). Sending needs the site's domain onboarded
// as a sending domain (Dashboard: Compute > Email Service > Email Sending). Without the binding or the domain, email is
// skipped or fails quietly for courtesy emails (payouts, refunds). Signing up and signing in are emailed too
// (src/auth-mail.ts), so there a failed send is reported to the person instead of passed over.
import type { Env } from './env';
import { getSettings } from './settings';

export interface Mail { to: string; subject: string; text: string; html: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const originOf = (env: Env) => env.PUBLIC_ORIGIN || 'https://hearthcade.com';

/** Local development only (DEV_MAIL "1" with the local driver): the last emails, read back by tests through /api/dev/mail. */
export const devOutbox: (Mail & { at: number })[] = [];
export const devMailOn = (env: Env) => env.DEV_MAIL === '1' && env.DEPLOY_DRIVER === 'local';

export async function sendMail(env: Env, m: Mail): Promise<boolean> {
  if (devMailOn(env)) { devOutbox.push({ ...m, at: Date.now() }); if (devOutbox.length > 200) devOutbox.shift(); console.log(`[dev mail] to ${m.to}: ${m.subject}`); return true; }
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

// ---- refunds (src/refunds.ts) ---------------------------------------------------------------------------------------
interface RefundRow { id: string; status: string; price_cents: number; decision_note: string | null; review_reason: string | null; buyer_email: string | null; buyer_name: string | null; creator_email: string | null; creator_name: string | null; title: string; slug: string; creator_net_cents: number | null; fee_bearer: string | null; stripe_fee_cents: number | null; transfer_reversal_cents: number }
async function refundRow(env: Env, id: string): Promise<RefundRow | null> {
  return env.DB.prepare(`SELECT q.*, b.email AS buyer_email, b.name AS buyer_name, o.email AS creator_email, o.name AS creator_name, p.title, p.slug
    FROM refund_requests q JOIN projects p ON p.id = q.project_id LEFT JOIN users b ON b.id = q.user_id LEFT JOIN users o ON o.id = q.owner_id WHERE q.id = ?`).bind(id).first<RefundRow>();
}
/** How long a refund takes to show up, said the same way everywhere (the confirmation, the emails, the policy). */
export const REFUND_TIMELINE = 'It usually takes 5 to 10 business days to show up on your statement, depending on your bank.';

async function simpleMail(env: Env, to: string, name: string, subject: string, lines: string[], link: { href: string; label: string }): Promise<boolean> {
  const brand = (await getSettings(env)).brand_name || 'HearthCade';
  return sendMail(env, {
    to, subject: `${brand}: ${subject}`,
    text: [`Hi ${name},`, ...lines, `${link.label}: ${link.href}`, `— ${brand}`].join('\n\n'),
    html: `<p>Hi ${esc(name)},</p>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}<p><a href="${esc(link.href)}">${esc(link.label)}</a></p><p>— ${esc(brand)}</p>`,
  });
}

/** Tells a buyer their refund request reached the platform and waits for a decision. */
export async function refundReceivedMail(env: Env, id: string, origin?: string): Promise<boolean> {
  const r = await refundRow(env, id);
  if (!r?.buyer_email) return false;
  return simpleMail(env, r.buyer_email, r.buyer_name || '', `we received your refund request for ${r.title}`,
    [`We received your request to refund ${r.title} (${usd(r.price_cents)}). The platform reviews it, usually within 2 business days, and emails you the decision. You can keep playing meanwhile.`],
    { href: `${origin || originOf(env)}/purchases`, label: 'See your purchases' });
}

/** Tells a buyer their refund went through, or that the platform declined it and why. */
export async function refundDecidedMail(env: Env, id: string, origin?: string): Promise<boolean> {
  const r = await refundRow(env, id);
  if (!r?.buyer_email || (r.status !== 'refunded' && r.status !== 'denied')) return false;
  const ok = r.status === 'refunded';
  return simpleMail(env, r.buyer_email, r.buyer_name || '', ok ? `${usd(r.price_cents)} for ${r.title} is on its way back` : `your refund request for ${r.title}`,
    ok ? [`We refunded ${r.title}: ${usd(r.price_cents)} goes back to the card or account you paid with. ${REFUND_TIMELINE}`, 'The game has left your library. Your saves are kept in case you buy it again; a game bought again after a refund cannot be refunded a second time.']
      : [`We looked at your request to refund ${r.title} and could not refund it under the refund policy.${r.decision_note ? ` ${r.decision_note}` : ''}`, 'The game stays in your library. If you think this is wrong, reply to this email.'],
    { href: `${origin || originOf(env)}/purchases`, label: 'See your purchases' });
}

/** Tells a creator a sale of their game was refunded and what it took off their balance. */
export async function saleRefundedMail(env: Env, id: string, origin?: string): Promise<boolean> {
  const r = await refundRow(env, id);
  if (!r?.creator_email || r.status !== 'refunded') return false;
  const net = r.creator_net_cents ?? 0, fee = r.fee_bearer === 'creator' ? (r.stripe_fee_cents || 0) : 0;
  const lines = [`A sale of ${r.title} (${usd(r.price_cents)}) was refunded to its buyer. Your ${usd(net)} credit for that sale was taken back${fee ? `, with the ${usd(fee)} payment fee Stripe keeps on a refund` : ''}.`];
  if (r.transfer_reversal_cents > 0) lines.push(`That share had already been paid out, so ${usd(r.transfer_reversal_cents)} was taken back from your payout account.`);
  return simpleMail(env, r.creator_email, r.creator_name || '', `a sale of ${r.title} was refunded`, lines, { href: `${origin || originOf(env)}/console/earnings`, label: 'See your Earnings page' });
}
