# Stripe: payments and creator payouts

HearthCade is a marketplace on Stripe Connect with **separate charges and transfers**:

1. A player pays HearthCade through Stripe Checkout (`POST /api/games/:slug/buy`). HearthCade (Horylo LLC) is the seller
   of record; the card statement and the Checkout page say so.
2. The signed webhook records the sale: the platform keeps its cut and credits the rest to the creator's ledger, where it
   waits out the hold period (`earnings_hold_days`, default 7) so refunds can be taken back first.
3. The creator onboards a Connect account (Stripe-hosted onboarding, Express dashboard, `transfers` capability) and
   withdraws: the platform sends a Transfer from its balance to the creator's account, and Stripe pays it out to the
   creator's bank on that account's payout schedule.

The creator license fee (`POST /api/billing/creator-fee`) is a plain Checkout payment to the platform.

The pattern fits because the platform decides when creator money moves (after the hold period, pooled across many small
sales). Destination charges would move every sale to the creator at once, with no hold for refunds.

## Set up (sandbox first)

Do everything in a Stripe **sandbox** first, then repeat it in live mode with live keys.

### 1. Connect settings (Dashboard → Connect → Settings)

- Platform profile: marketplace, platform is the merchant of record, the platform is responsible for losses
  (negative balances) of connected accounts.
- Onboarding: Express, with HearthCade branding (name, icon, colour).
- If creators live outside the platform's country: enable cross-border payouts. Their accounts are created with the
  `recipient` service agreement automatically.
- Admin console → Settings → "Country of the platform Stripe account" must match the Stripe account's country.

### 2. API key: a restricted key, not the secret key

Create a restricted key (`rk_…`) named "HearthCade Worker" with only these permissions, all **Write** unless noted:

| Resource | Why |
| --- | --- |
| Checkout Sessions | Create sessions; retrieve and list them (Read is not enough) |
| Refunds | Admin refunds; automatic refund of a duplicate purchase |
| Transfers | Creator withdrawals |
| Connect → Accounts | Create a creator's payout account; read its status |
| Connect → Account Links | Onboarding links |

If a call fails with a 403 in the sandbox, `stripe logs tail` names the missing permission. Add an IP access policy to
the key if Stripe offers it for your account (Cloudflare Workers use Cloudflare's egress ranges, so this is optional).

### 3. Webhook endpoints

Both point at `https://hearthcade.com/api/stripe/webhook` and use API version **`2026-10-28.endive`**, the version the
Worker pins on every request (`STRIPE_API_VERSION` in `src/stripe.ts`). Upgrade the two together.

| Endpoint | Listens to | Events |
| --- | --- | --- |
| Platform | Your account | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` |
| Connect | Connected accounts | `account.updated` |

Each endpoint has its own signing secret (`whsec_…`). A signature from either is accepted; events from connected
accounts are only used for `account.updated`.

### 4. Worker secrets

Run these yourself, from the repository, and paste each value only into the prompt (never into chat, an issue, a commit or
`.dev.vars` that is committed):

```sh
npx wrangler secret put STRIPE_SECRET_KEY              # the rk_… restricted key
npx wrangler secret put STRIPE_WEBHOOK_SECRET          # whsec_… of the Platform endpoint
npx wrangler secret put STRIPE_CONNECT_WEBHOOK_SECRET  # whsec_… of the Connect endpoint
```

The admin console's health panel shows whether each one is set (never its value).

### 5. Test in the sandbox

- Buy a paid game with `4242 4242 4242 4242`; the creator's balance shows the sale as pending.
- Refund it from the admin console; access goes and the credit is taken back.
- Buy again with `4000 0000 0000 0259` (disputed charge): access goes and the credit is held. Submit winning evidence
  (`winning_evidence` in the evidence text field) and both come back.
- Onboard a payout account with test data, set the hold to 0 days in the admin console, and withdraw. In a sandbox, add
  funds to the platform balance first with `4000 0000 0000 0077` (available immediately), or the Transfer fails with
  "insufficient funds" and the balance is restored.

## What happens when

| Event | Effect |
| --- | --- |
| Checkout paid (`checkout.session.completed` with `payment_status: paid`, or `async_payment_succeeded`) | Purchase recorded, creator credited after the hold. Also applied when the buyer lands back on the site, so access does not wait for the webhook; both paths are idempotent. A second payment for a game already owned is refunded at once. |
| Full refund | Access revoked; the creator's remaining credit for that sale is taken back. A refunded license fee revokes the license. |
| Partial refund (from the Dashboard) | The creator gives back the same share of the credit; the buyer keeps the game. |
| Dispute opened (including an inquiry) | Access revoked; the credit is held back. A disputed license fee suspends the license. |
| Dispute won, or inquiry closed | Access and credit come back (once). |
| Dispute lost | Nothing more: the credit stays taken back. |
| `account.updated` | The creator's "payouts enabled" flag follows the account's `transfers` capability and `payouts_enabled`. |
| Withdrawal | The ledger debit and the withdrawal record are one transaction; the Transfer uses the withdrawal id as its idempotency key. A clear refusal restores the balance; an unknown outcome is retried every 10 minutes with the same key, so a creator is never paid twice. |

If money already left for the creator when a refund or chargeback arrives, the creator's balance goes negative and
their next sales pay it back first. The platform carries that loss if they never sell again; a longer hold period lowers
the chance.

## Before going live

- Live-mode restricted key, live webhook endpoints and live secrets (steps 2 to 4 again).
- Sales tax and VAT: HearthCade is the seller of record for game sales, so the tax obligation is the platform's. Stripe
  Tax can compute it, but turn on `automatic_tax` only after adding registrations; without one Stripe collects nothing.
- Stripe Dashboard team: passkeys or an authenticator app for 2FA, not SMS.
- Stripe's go-live checklist: https://docs.stripe.com/get-started/checklist/go-live
