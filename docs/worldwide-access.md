# Worldwide access

What can stop or slow a player somewhere in the world from using hearthcade.com and the games on `*.hearthcade.app`,
what the platform does about it, and what is outside its control. Audited 2026-11-20.

## No regional blocks

- **Code.** Nothing in the Worker, the web app or the game runtime refuses a request by country. `request.cf` is read
  only to place realtime rooms near their players (`src/placement.ts`) and to show where a device sign-in came from
  (`src/routes/device.ts`).
- **Cloudflare (both zones).** No IP access rules or country rules, no custom WAF or rate-limiting rules, no user-agent
  blocks, Bot Fight Mode off. Only Cloudflare's managed DDoS and Free managed rulesets run, which do not filter by country.
- **Dependencies.** The web app loads nothing from another host: its Latin fonts are self-hosted (`web/public/fonts`), CJK
  text uses the reader's system fonts, Three.js and the `@gcp/` modules are served from hearthcade.com, and there is no
  analytics, captcha or social sign-in. Sign-in is email and password. Email goes out through Cloudflare Email Service.
  Payments open Stripe Checkout, which is generally reachable from mainland China (not tested from inside China for this audit).

## Fixed in the platform

- **Games that load from blocked hosts.** `deploy_preview` now warns when a game loads Google Fonts, Google-hosted
  libraries, Firebase, Google Analytics or Tag Manager, reCAPTCHA, YouTube, Facebook, X or Discord
  (`src/region-hosts.js`, tests in `tests/region-hosts.mjs`), with what to ship in the bundle instead. These hosts are
  blocked in mainland China, so a game that depends on them hangs or loses its font, video or library there.
- **Shared addresses.** Carriers in much of Asia, Africa and South America put thousands of phones behind one IPv4
  address. Sign-ups per address went from 10 to 30 an hour; with guest play on, new guests per address from 20 to 60 an
  hour, and a returning guest is limited by its own id (240 play starts an hour, like an account) instead of sharing
  60 an hour with everyone on its address.

## Recommended Cloudflare change (needs the owner)

Both zones run Security Level *Medium* with Browser Integrity Check on. Visitors whose address has a poor reputation
(shared carrier and VPN addresses, common in mainland China) can then get a challenge page. On `hearthcade.app` that
page appears inside the game frame or answers a game's own `fetch()`, where it usually cannot be solved (the frame is a
third-party site, so Safari will not keep the clearance cookie), and an agent calling `/mcp` or `/oauth` cannot solve
it at all. Suggested:

1. `hearthcade.app`: Security Level *Essentially off*, Browser Integrity Check off. Games are already gated by a signed
   play token, and DDoS protection stays on.
2. `hearthcade.com`: a Configuration Rule for `/api/`, `/mcp`, `/oauth/` and `/.well-known/` setting Security Level
   *Essentially off* and Browser Integrity Check off. Pages stay as they are.

## Outside the platform's control

- **Mainland China.** Cloudflare serves mainland visitors from data centers outside China (often Hong Kong, Tokyo or the
  US West Coast) because only Cloudflare's China Network, an Enterprise add-on that requires an ICP licence, has data
  centers inside it. An ICP licence needs a Chinese legal entity. Without one the site works but is slower and less
  reliable at peak hours than elsewhere. There is no lawful way around this.
- **Sanctions.** HearthCade is operated by a US company. Stripe refuses payments from and payouts to sanctioned regions
  (such as Cuba, Iran, North Korea, Syria and occupied parts of Ukraine), and US export and sanctions rules can restrict
  providing paid services there. The site does not block these regions; whether it must is a legal question.
- **Creator payouts.** Payout accounts can be opened in the 55 countries listed on the Earnings page. Stripe's Global
  Payouts reaches more (mainland China only by USD wire, in private preview); adding countries is a Stripe product
  decision, not a code change.
- **Payment methods.** Checkout uses the payment methods enabled in the Stripe Dashboard. Turning on Alipay and WeChat
  Pay there (both accept USD) makes buying possible for players in China without an international card.
- **Games' own choices.** The warning above cannot stop a creator from publishing a game that depends on a blocked host.
