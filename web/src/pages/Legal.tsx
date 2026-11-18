// The legal pages linked from the footer: terms, privacy, cookies and storage, refunds. Plain, short and specific to
// how this platform works; figures (the platform's cut, the holding period, the minimum withdrawal) come from the
// live settings so the pages never disagree with the admin console. Every string goes through t() for translation.
import type { ReactNode } from 'react';
import { t, usd, useApp } from '../lib';
import { PageHeader, Tabs } from '../ui';

export type LegalDoc = 'terms' | 'privacy' | 'cookies' | 'refunds';
export const LEGAL_DOCS: LegalDoc[] = ['terms', 'privacy', 'cookies', 'refunds'];
export const legalTitle = (d: LegalDoc) => ({
  terms: t('Terms of service', '服务条款'), privacy: t('Privacy policy', '隐私政策'), cookies: t('Cookies and storage', 'Cookie 与本地存储'), refunds: t('Refund policy', '退款政策'),
}[d]);

/** The date these texts last changed in a meaningful way. Update it with them. */
const UPDATED = '2026-11-15';

const S = ({ h, children }: { h: string; children: ReactNode }) => <section><h2>{h}</h2>{children}</section>;

export function Legal({ doc }: { doc: LegalDoc }) {
  const { config } = useApp(), s = config.settings, brand = String(s.brand_name || 'HearthCade'), support = String(s.support_email || '');
  const fee = Number(s.platform_fee_percent ?? 10), hold = Number(s.earnings_hold_days ?? 7), min = Number(s.withdraw_min_cents ?? 5000);
  const body: Record<LegalDoc, ReactNode> = {
    terms: <>
      <S h={t('Using the platform', '使用本平台')}>
        <p>{t('{brand} hosts web games made by creators with their own AI agents, and lets players find, play, rate and buy them. By creating an account or playing a game you agree to these terms.', '{brand} 托管由创作者借助自己的 AI 智能体制作的网页游戏，玩家可以在这里发现、游玩、评价和购买游戏。创建账户或游玩游戏即表示你同意本条款。', { brand })}</p>
        <p>{t('You must be old enough to agree to these terms where you live, keep your sign-in safe, and tell us if you think someone else is using your account.', '你需要达到所在地区同意本条款的法定年龄，妥善保管登录方式，并在怀疑账户被他人使用时通知我们。')}</p>
      </S>
      <S h={t('Creators and their games', '创作者与游戏')}>
        <p>{t('Creators keep the rights to their games. By publishing, a creator gives the platform permission to host, show, verify and sell the game, and to show screenshots and facts about it in the store.', '创作者保留其游戏的权利。发布即表示创作者授权平台托管、展示、验证和销售该游戏，并在商店中展示其截图与相关信息。')}</p>
        <p>{t('Only web games are accepted. A creator must own or have permission for everything in a game, and may not publish copies of other creators\' games, malware, or anything unlawful or harmful. Games that break these rules can be taken offline.', '平台仅接受网页游戏。创作者必须拥有或已获授权使用游戏中的全部内容，不得发布其他创作者游戏的副本、恶意软件或任何违法、有害的内容。违反规则的游戏可能会被下线。')}</p>
        <p>{t('Games for adults, with sexual content or graphic violence, are allowed only when the creator declares that content. They are shown as 18+ with a blurred picture, and players confirm they are 18 or older before playing. A game that hides such content is refused or taken offline. Sexual content involving minors is never allowed.', '面向成人、含有性内容或血腥暴力的游戏，只有在创作者声明这些内容后才允许发布。这类游戏显示为 18+、图片模糊，玩家需确认已年满 18 岁后才能游玩。隐瞒此类内容的游戏将被拒绝或下线。任何涉及未成年人的性内容一律禁止。')}</p>
      </S>
      <S h={t('Payments and earnings', '付款与收益')}>
        <p>{t('Players pay the platform. The platform keeps {fee}% of each sale and credits the rest to the creator, available to withdraw after {days} days once the balance reaches {min}. Payments and payouts are processed by Stripe.', '玩家向平台付款。平台从每笔销售中收取 {fee}%，其余部分计入创作者余额，{days} 天后且余额达到 {min} 即可提现。付款与提现由 Stripe 处理。', { fee, days: hold, min: usd(min) })}</p>
      </S>
      <S h={t('Players', '玩家')}>
        <p>{t('A purchase gives you a personal licence to play the game on this platform, not ownership of it. Reviews must be honest and about the game.', '购买即获得在本平台游玩该游戏的个人许可，而非游戏的所有权。评价必须真实且与游戏相关。')}</p>
      </S>
      <S h={t('Changes and ending', '变更与终止')}>
        <p>{t('We may change these terms; the date above shows the latest version. You can stop using the platform at any time. We may suspend accounts that break these terms.', '我们可能会修改本条款，页首日期为最新版本。你可以随时停止使用本平台。对于违反本条款的账户，我们可能会暂停其使用。')}</p>
        <p>{t('The platform is provided as it is. To the extent the law allows, we are not liable for indirect losses or for games made by creators.', '本平台按现状提供。在法律允许的范围内，我们不对间接损失或创作者制作的游戏承担责任。')}</p>
      </S>
    </>,
    privacy: <>
      <S h={t('What we collect', '我们收集的信息')}>
        <ul>
          <li>{t('Your account: email address, display name, and your role (player, creator, administrator).', '账户信息：电子邮箱、显示名称和身份（玩家、创作者、管理员）。')}</li>
          <li>{t('What you do here: games you play and for how long, purchases, reviews, and for creators, projects, versions and agent connections.', '使用记录：你游玩的游戏及时长、购买、评价；对于创作者，还包括项目、版本和智能体连接。')}</li>
          <li>{t('Your device, coarsely: the kind of device and the browser family, for creators\' play statistics. Not your exact browser version or a fingerprint.', '粗略的设备信息：设备类型和浏览器种类，用于创作者的游玩统计。不包括具体浏览器版本，也不做设备指纹识别。')}</li>
          <li>{t('Payments: Stripe handles card and bank details. We see the result of a payment, never your card number.', '支付信息：银行卡与银行账户信息由 Stripe 处理。我们只能看到付款结果，永远看不到你的卡号。')}</li>
        </ul>
      </S>
      <S h={t('Why we use it', '我们为何使用这些信息')}>
        <p>{t('To run your account, let you play and buy games, pay creators, show creators how their games are played, keep the platform safe, and meet legal duties. We do not sell personal data and do not show third-party ads.', '用于运行你的账户、让你游玩和购买游戏、向创作者付款、向创作者展示游戏的游玩情况、保障平台安全，以及履行法律义务。我们不出售个人数据，也不展示第三方广告。')}</p>
      </S>
      <S h={t('Who else sees it', '谁还能看到这些信息')}>
        <p>{t('Cloudflare hosts the platform and the games; Stripe processes payments. Creators see aggregated statistics about their own games and the public name on your reviews. Games you play receive your player name and a player id.', 'Cloudflare 托管本平台和游戏；Stripe 处理付款。创作者可以看到其游戏的汇总统计，以及你评价上的公开名称。你游玩的游戏会获得你的玩家名称和玩家 ID。')}</p>
      </S>
      <S h={t('Your choices', '你的选择')}>
        <p>{t('You can ask for a copy of your data, ask us to correct it, or close your account and have it deleted, except what we must keep for payments and tax. Contact the platform\'s administrator to do so.', '你可以申请获取个人数据副本、要求更正，或注销账户并删除数据，但出于支付和税务原因必须保留的信息除外。如需办理，请联系平台管理员。')}</p>
      </S>
    </>,
    cookies: <>
      <S h={t('Cookies', 'Cookie')}>
        <p>{t('We use only the cookies the site needs to work: one that keeps you signed in, and one that lets a game you opened know it may run for you. There are no advertising or tracking cookies.', '我们只使用网站运行所必需的 Cookie：一个用于保持登录状态，另一个让你打开的游戏确认可以为你运行。没有广告或追踪 Cookie。')}</p>
      </S>
      <S h={t('Stored in your browser', '保存在浏览器中的信息')}>
        <p>{t('Some choices are kept in this browser only and never sent to us:', '有些选择只保存在当前浏览器中，从不发送给我们：')}</p>
        <ul>
          <li>{t('Your language.', '你选择的语言。')}</li>
          <li>{t('Whether visual effects are on or off, and whether they failed on this device during this visit.', '视觉特效的开关状态，以及本次访问中特效是否在此设备上出错。')}</li>
          <li>{t('Games you played recently, games you have seen in the discovery queue, and when you last visited, so the store can say what is new.', '最近玩过的游戏、在探索队列中看过的游戏，以及你上次来访的时间，以便商店提示新内容。')}</li>
        </ul>
        <p>{t('Clearing your browser\'s site data removes all of it. Games may keep their own data in your browser; that belongs to each game.', '清除浏览器的网站数据即可将其全部删除。游戏可能会在你的浏览器中保存自己的数据，这些数据归各游戏所有。')}</p>
      </S>
    </>,
    refunds: <>
      <S h={t('Asking for a refund', '申请退款')}>
        <p>{t('If a game you bought does not work, or is not what its page described, ask the platform\'s administrator for a refund. Tell us which game and what went wrong.', '如果你购买的游戏无法运行，或与游戏页面描述不符，可以向平台管理员申请退款，并说明是哪款游戏以及出现了什么问题。')}</p>
      </S>
      <S h={t('What happens next', '之后会怎样')}>
        <p>{t('A refund goes back to the card or account you paid with, through Stripe. It removes your access to the game, and the creator\'s share of that sale is taken back from their balance.', '退款将通过 Stripe 原路退回你付款时使用的银行卡或账户。退款后你将失去该游戏的访问权限，创作者在该笔销售中的分成也会从其余额中扣回。')}</p>
        <p>{t('Creators\' earnings are held for {days} days before they can be withdrawn, so most refunds are settled before any money leaves the platform.', '创作者的收益在可提现前会冻结 {days} 天，因此大多数退款会在资金离开平台前处理完毕。', { days: hold })}</p>
      </S>
      <S h={t('Your rights', '你的权利')}>
        <p>{t('Nothing here limits the rights consumer law gives you where you live.', '本政策不限制你所在地区消费者保护法赋予你的任何权利。')}</p>
      </S>
    </>,
  };
  return (
    <div className="wrap page legal">
      <PageHeader eyebrow={t('Legal', '法律信息')} title={legalTitle(doc)} sub={t('Last updated {date}', '最后更新：{date}', { date: UPDATED })} />
      <Tabs active={doc} items={LEGAL_DOCS.map((d) => ({ key: d, to: `/legal/${d}`, label: legalTitle(d) }))} />
      <article className="legal-body">{body[doc]}
        {support && <S h={t('Contact', '联系我们')}><p>{t('Questions about these terms, your data or a payment: write to {email}.', '对本条款、你的数据或付款有疑问，请发邮件至 {email}。', { email: support })}</p></S>}
      </article>
    </div>
  );
}
