// The legal pages linked from the footer: terms, privacy, cookies and storage, refunds. Plain, short and specific to
// how this platform works. The platform is developed and operated by Horylo LLC (web/src/operator.ts): it is the
// contracting party in the Terms and the data controller in the Privacy Policy, and each page says so at the top.
// Every string goes through t() for translation; names, addresses and dates are filled in, never translated.
import { Fragment, type ReactNode } from 'react';
import { t, useApp } from '../lib';
import { PageHeader, Tabs, Notice } from '../ui';
import { OPERATOR, DEFAULT_BRAND } from '../operator';

export type LegalDoc = 'terms' | 'privacy' | 'cookies' | 'refunds';
export const LEGAL_DOCS: LegalDoc[] = ['terms', 'privacy', 'cookies', 'refunds'];
export const legalTitle = (d: LegalDoc) => ({
  terms: t('Terms of service', '服务条款'), privacy: t('Privacy policy', '隐私政策'), cookies: t('Cookies and storage', 'Cookie 与本地存储'), refunds: t('Refund policy', '退款政策'),
}[d]);

/** The date each text takes effect. Change it whenever that text changes in a meaningful way. */
const EFFECTIVE: Record<LegalDoc, string> = { terms: '2026-11-18', privacy: '2026-11-18', cookies: '2026-11-18', refunds: '2026-11-18' };

/** Set to true once a lawyer has reviewed these texts; until then every legal page says they are a draft. */
const LAWYER_REVIEWED = false;

const S = ({ h, children }: { h: string; children: ReactNode }) => <section><h2>{h}</h2>{children}</section>;

/** Turns the email addresses and the operator's site inside a translated sentence into links. */
function linked(text: string): ReactNode {
  const parts = text.split(/([\w.+-]+@[\w-]+(?:\.[\w-]+)+|horylo\.com\b)/);
  return parts.map((p, i) => (i % 2 === 0 ? <Fragment key={i}>{p}</Fragment>
    : p.includes('@') ? <a key={i} href={`mailto:${p}`}>{p}</a> : <a key={i} href={OPERATOR.url} target="_blank" rel="noreferrer">{p}</a>));
}
const P = ({ children }: { children: string }) => <p>{linked(children)}</p>;

export function Legal({ doc }: { doc: LegalDoc }) {
  const { config } = useApp(), s = config.settings, brand = String(s.brand_name || DEFAULT_BRAND);
  const op = OPERATOR.name, legal = OPERATOR.legalEmail, support = String(s.support_email || OPERATOR.supportEmail), state = OPERATOR.jurisdiction;
  const body: Record<LegalDoc, ReactNode> = {
    terms: <>
      <S h={t('Who we are', '我们是谁')}>
        <P>{t('These Terms govern your use of {brand} (the “Service”), which is developed and operated by {op}, a {state} limited liability company (“Horylo”, “we”, “us”).', '本条款适用于你对 {brand}（“本服务”）的使用。本服务由 {op}（一家 {state} 州有限责任公司，以下称“Horylo”或“我们”）开发和运营。', { brand, op, state })}</P>
        <P>{t('By using the Service, you agree to these Terms with {op}. If you do not agree, do not use the Service.', '使用本服务即表示你与 {op} 就本条款达成协议。如果你不同意，请不要使用本服务。', { op })}</P>
        <P>{t('The Service hosts web games made by creators with their own AI agents, and lets players find, play, rate and buy them.', '本服务托管由创作者借助自己的 AI 智能体制作的网页游戏，玩家可以在这里发现、游玩、评价和购买游戏。')}</P>
      </S>
      <S h={t('Accounts and age limits', '账户与年龄限制')}>
        <P>{t('You must be at least 13 years old to use the Service, and older if the law where you live sets a higher minimum age. If you are under the age of majority where you live, a parent or guardian must agree to these Terms for you.', '你必须年满 13 周岁才能使用本服务；如果你所在地区的法律规定了更高的最低年龄，则以该年龄为准。如果你未达到所在地区的成年年龄，须由父母或监护人代你同意本条款。')}</P>
        <P>{t('Games marked 18+ contain sexual content or graphic violence. Only players aged 18 or older may open them, and you confirm your age before playing.', '标记为 18+ 的游戏含有性内容或血腥暴力，仅限年满 18 岁的玩家打开，游玩前需确认你的年龄。')}</P>
        <P>{t('Give accurate account details, keep your sign-in safe, and tell us at once if you think someone else is using your account. You are responsible for what happens under your account.', '请提供真实的账户信息，妥善保管登录方式，如怀疑账户被他人使用请立即通知我们。你需对账户下发生的一切行为负责。')}</P>
      </S>
      <S h={t('Your content and creator uploads', '你的内容与创作者上传')}>
        <P>{t('You keep the rights to what you make or upload: games, their files, listings, screenshots, reviews and your display name (“your content”).', '你保留对自己制作或上传的内容的权利，包括游戏及其文件、商店信息、截图、评价和显示名称（“你的内容”）。')}</P>
        <P>{t('You give {op} a worldwide, non-exclusive, royalty-free licence to host, store, copy, run, verify, scan, display, distribute and promote your content, as needed to operate, improve and promote the Service. The licence lasts while your content is on the Service, and afterwards for backups and for players who already bought a game.', '你授予 {op} 一项全球范围、非独占、免版税的许可，可在运营、改进和推广本服务所需的范围内托管、存储、复制、运行、验证、扫描、展示、分发和推广你的内容。该许可在你的内容留存于本服务期间有效，之后在备份范围内及对已购买游戏的玩家继续有效。', { op })}</P>
        <P>{t('Creators confirm they own or have permission for everything in a game, and that it follows these Terms. Only web games are accepted. Games for adults must declare that content. A game may be refused, hidden or taken offline if it breaks these Terms or the law.', '创作者确认自己拥有或已获授权使用游戏中的全部内容，且游戏符合本条款。平台仅接受网页游戏。面向成人的游戏必须声明相关内容。违反本条款或法律的游戏可能会被拒绝、隐藏或下线。')}</P>
      </S>
      <S h={t('Purchases and virtual items', '购买与虚拟物品')}>
        <P>{t('Purchases on the Service are sold by {op} and processed by Stripe. Prices are shown before you pay.', '本服务上的购买由 {op} 销售，并由 Stripe 处理付款。价格会在付款前显示。', { op })}</P>
        <P>{t('Buying a game gives you a personal, non-transferable licence to play it on the Service, not ownership of the game. The licence ends if the game is refunded or your account is closed for breaking these Terms.', '购买游戏即获得在本服务上游玩该游戏的个人、不可转让的许可，而非游戏的所有权。如果该游戏已退款，或你的账户因违反本条款被关闭，该许可即告终止。')}</P>
        <P>{t('Virtual items, in-game currency, scores and progress have no cash value, cannot be exchanged for money, and are not your property. They are non-refundable unless the law requires otherwise, and they may change or disappear if a game is updated or removed.', '虚拟物品、游戏内货币、分数和进度没有现金价值，不能兑换为金钱，也不属于你的财产。除非法律另有规定，这些内容不予退款；游戏更新或下架时，它们可能发生变化或消失。')}</P>
        <P>{t('Refunds for games follow the Refund policy.', '游戏退款适用《退款政策》。')}</P>
      </S>
      <S h={t('Rules of conduct', '行为规范')}>
        <P>{t('Do not use the Service to:', '不得利用本服务：')}</P>
        <ul>
          <li>{t('harass, threaten or impersonate anyone, or post hateful, sexual or violent content outside games declared for it;', '骚扰、威胁或冒充他人，或在未作相应声明的游戏之外发布仇恨、色情或暴力内容；')}</li>
          <li>{t('publish copies of other creators’ games, malware, scams, or anything unlawful;', '发布其他创作者游戏的副本、恶意软件、诈骗内容或任何违法内容；')}</li>
          <li>{t('cheat, exploit bugs, get around payments, trials or age checks, or tamper with other players’ data;', '作弊、利用漏洞、绕过付款、试玩或年龄确认，或篡改其他玩家的数据；')}</li>
          <li>{t('attack, overload, scrape or reverse engineer the Service, or reach accounts or data that are not yours;', '攻击、超负荷访问、抓取或逆向工程本服务，或访问不属于你的账户或数据；')}</li>
          <li>{t('write reviews that are dishonest or not about the game.', '发布不真实或与游戏无关的评价。')}</li>
        </ul>
      </S>
      <S h={t('Termination', '终止')}>
        <P>{t('You can stop using the Service at any time and ask us to close your account.', '你可以随时停止使用本服务，并要求我们关闭你的账户。')}</P>
        <P>{t('We may suspend or close an account, or remove content, if it breaks these Terms, puts players or the Service at risk, or when the law requires it. Where we can, we tell you why. Sections that by their nature should last, such as the licences already given for bought games, disclaimers and governing law, continue after termination.', '如果账户或内容违反本条款、危及玩家或本服务，或法律有此要求，我们可能会暂停或关闭账户、删除内容。在可行时，我们会告知原因。按其性质应继续有效的条款，例如已购买游戏的许可、免责声明和适用法律，在终止后继续有效。')}</P>
      </S>
      <S h={t('Disclaimers and liability', '免责声明与责任限制')}>
        <P>{t('The Service is provided “as is”. Games are made by their creators, who are responsible for them. To the extent the law allows, {op} is not liable for indirect or consequential losses, and its total liability to you is limited to the amount you paid it in the 12 months before the claim. Nothing in these Terms limits rights that consumer law gives you.', '本服务按“现状”提供。游戏由其创作者制作，并由创作者负责。在法律允许的范围内，{op} 不对间接或后果性损失承担责任，且对你的全部责任以你在索赔前 12 个月内向其支付的金额为限。本条款不限制消费者保护法赋予你的任何权利。', { op })}</P>
      </S>
      <S h={t('Governing law', '适用法律')}>
        <P>{t('These Terms are governed by the laws of the State of {state}, United States, without regard to its conflict of laws rules. Disputes go to the state or federal courts located in {state}, unless the law where you live gives you the right to bring them at home.', '本条款受美国 {state} 州法律管辖，不适用其冲突法规则。争议由位于 {state} 州的州法院或联邦法院管辖，除非你所在地的法律赋予你在当地提起诉讼的权利。', { state })}</P>
      </S>
      <S h={t('Changes and contact', '变更与联系方式')}>
        <P>{t('We may update these Terms. The effective date above shows the current version, and we will tell you about important changes before they apply. Using the Service after that means you accept them.', '我们可能会更新本条款。页首的生效日期显示当前版本，重要变更生效前我们会通知你。此后继续使用本服务即表示你接受变更。')}</P>
        <P>{t('Questions about these Terms can be sent to {email}.', '关于本条款的问题，请发送至 {email}。', { email: legal })}</P>
      </S>
    </>,
    privacy: <>
      <S h={t('Who we are', '我们是谁')}>
        <P>{t('This Privacy Policy explains how {op} (“we”) collects and uses information when you use {brand}. {op} is the data controller for the Service.', '本隐私政策说明 {op}（“我们”）在你使用 {brand} 时如何收集和使用信息。{op} 是本服务的数据控制者。', { op, brand })}</P>
      </S>
      <S h={t('What we collect', '我们收集的信息')}>
        <ul>
          <li>{t('Account: email address, display name, your role (player, creator, administrator) and how you sign in.', '账户信息：电子邮箱、显示名称、身份（玩家、创作者、管理员）以及登录方式。')}</li>
          <li>{t('Gameplay: games you play and for how long, trial time, saves, stats and leaderboard entries that games keep with us, messages relayed in multiplayer rooms, purchases and reviews.', '游玩信息：你游玩的游戏及时长、试玩时间、游戏在我们这里保存的存档、统计数据和排行榜记录、多人房间中转发的消息、购买记录和评价。')}</li>
          <li>{t('Creators: projects, uploaded files, versions, verification screenshots, listings and agent connections.', '创作者信息：项目、上传的文件、版本、验证截图、商店信息和智能体连接。')}</li>
          <li>{t('Device, coarsely: the kind of device and the browser family, plus IP addresses in short-lived security logs. No exact browser version and no fingerprinting.', '粗略的设备信息：设备类型和浏览器种类，以及短期安全日志中的 IP 地址。不包括具体浏览器版本，也不做设备指纹识别。')}</li>
          <li>{t('Payments: Stripe, our payment processor, handles card and bank details. We see the result of a payment, never your full card number.', '支付信息：银行卡与银行账户信息由我们的支付处理方 Stripe 处理。我们只能看到付款结果，永远看不到你的完整卡号。')}</li>
          <li>{t('What you send us: messages to support or to {email}.', '你发给我们的内容：发送给客服或 {email} 的消息。', { email: legal })}</li>
        </ul>
      </S>
      <S h={t('Why we use it', '我们为何使用这些信息')}>
        <P>{t('To run your account, let you play and buy games, show creators how their games are played, check games for safety and originality, prevent fraud and abuse, answer you, and meet legal and tax duties. We do not sell personal information, do not share it for targeted advertising, and do not show third-party ads.', '用于运行你的账户、让你游玩和购买游戏、向创作者展示游戏的游玩情况、检查游戏的安全性和原创性、防止欺诈和滥用、回复你的消息，以及履行法律和税务义务。我们不出售个人信息，不为定向广告共享个人信息，也不展示第三方广告。')}</P>
      </S>
      <S h={t('Who we share it with', '我们与谁共享')}>
        <ul>
          <li>{t('Hosting: Cloudflare runs the Service and the games, including the automated checks of uploaded games.', '托管：Cloudflare 运行本服务和游戏，包括对上传游戏的自动检查。')}</li>
          <li>{t('Payments: Stripe processes purchases and refunds.', '支付：Stripe 处理购买和退款。')}</li>
          <li>{t('Analytics: play statistics are computed by us on our own hosting; no outside analytics service receives them. Creators see aggregated statistics about their own games.', '分析：游玩统计由我们在自己的托管环境中计算，不会发送给任何外部分析服务。创作者可以看到其游戏的汇总统计。')}</li>
          <li>{t('Games and other players: a game you play receives your player name and a player id; your reviews and leaderboard entries show your public name.', '游戏与其他玩家：你游玩的游戏会获得你的玩家名称和玩家 ID；你的评价和排行榜记录会显示你的公开名称。')}</li>
          <li>{t('When the law requires it, to protect people or the Service, or to a buyer if {op} or the Service is sold.', '在法律要求时、为保护他人或本服务时，或在 {op} 或本服务被出售时提供给买方。', { op })}</li>
        </ul>
      </S>
      <S h={t('How long we keep it', '保存期限')}>
        <P>{t('We keep account and gameplay data while your account is open, and delete it within 30 days after you close it. Payment and tax records are kept as long as the law requires, usually up to 7 years. Security logs are kept for a short time. A game’s saves and stats are deleted with the game or your account.', '账户和游玩数据在你的账户存续期间保留，并在你注销后 30 天内删除。支付和税务记录按法律要求保留，通常最长 7 年。安全日志仅短期保留。游戏的存档和统计会随游戏或你的账户一并删除。')}</P>
      </S>
      <S h={t('Your rights', '你的权利')}>
        <P>{t('Depending on where you live, you can ask to see, correct, export or delete your information, or object to how we use it. Send privacy requests to {email}. We may need to confirm it is you, and we will answer within the time the law sets. You can also complain to your local data protection authority.', '根据你所在地区的法律，你可以要求查看、更正、导出或删除你的信息，或反对我们使用这些信息的方式。隐私请求请发送至 {email}。我们可能需要核实你的身份，并会在法律规定的期限内答复。你也可以向当地的数据保护机构投诉。', { email: legal })}</P>
      </S>
      <S h={t('Children’s privacy', '儿童隐私')}>
        <P>{t('The Service is not directed to children under 13, and we do not knowingly collect personal information from them. If we learn that a child under 13 has an account, we delete it and its data. A parent or guardian who believes this has happened can write to {email}.', '本服务并非面向 13 岁以下儿童，我们不会在知情的情况下收集其个人信息。如果我们得知有 13 岁以下儿童注册了账户，将删除该账户及其数据。父母或监护人如认为发生了此类情况，可发送邮件至 {email}。', { email: legal })}</P>
      </S>
      <S h={t('Where it is processed', '数据处理地点')}>
        <P>{t('{op} is based in the United States, and our providers may process information in other countries. Where the law requires it, we use safeguards such as standard contractual clauses. We protect information with encryption in transit and access limited to those who need it.', '{op} 位于美国，我们的服务商可能在其他国家处理信息。在法律要求时，我们会采取标准合同条款等保障措施。我们通过传输加密和仅限必要人员访问来保护信息。', { op })}</P>
      </S>
      <S h={t('Changes and contact', '变更与联系方式')}>
        <P>{t('We may update this policy. The effective date above shows the current version, and we will tell you about important changes. Questions and requests: {email}.', '我们可能会更新本政策。页首的生效日期显示当前版本，重要变更我们会通知你。问题与请求请发送至：{email}。', { email: legal })}</P>
      </S>
    </>,
    cookies: <>
      <S h={t('Cookies', 'Cookie')}>
        <P>{t('{brand} is operated by {op}. We use only the cookies the site needs to work: one that keeps you signed in, one that remembers your language, and one that lets a game you opened know it may run for you. There are no advertising or tracking cookies.', '{brand} 由 {op} 运营。我们只使用网站运行所必需的 Cookie：一个用于保持登录状态，一个用于记住你的语言，另一个让你打开的游戏确认可以为你运行。没有广告或追踪 Cookie。', { brand, op })}</P>
      </S>
      <S h={t('Stored in your browser', '保存在浏览器中的信息')}>
        <p>{t('Some choices are kept in this browser only and never sent to us:', '有些选择只保存在当前浏览器中，从不发送给我们：')}</p>
        <ul>
          <li>{t('Your language.', '你选择的语言。')}</li>
          <li>{t('Whether visual effects are on or off, and whether they failed on this device during this visit.', '视觉特效的开关状态，以及本次访问中特效是否在此设备上出错。')}</li>
          <li>{t('Games you played recently, games you have seen in the discovery queue, and when you last visited, so the store can say what is new.', '最近玩过的游戏、在探索队列中看过的游戏，以及你上次来访的时间，以便商店提示新内容。')}</li>
        </ul>
        <p>{t('Clearing your browser\'s site data removes all of it. Games may keep their own data in your browser; that belongs to each game.', '清除浏览器的网站数据即可将其全部删除。游戏可能会在你的浏览器中保存自己的数据，这些数据归各游戏所有。')}</p>
        <P>{t('Questions: {email}.', '如有疑问：{email}。', { email: legal })}</P>
      </S>
    </>,
    refunds: <>
      <S h={t('Asking for a refund', '申请退款')}>
        <P>{t('Games on {brand} are sold by {op}. If a game you bought does not work, or is not what its page described, write to {email} for a refund. Tell us which game and what went wrong.', '{brand} 上的游戏由 {op} 销售。如果你购买的游戏无法运行，或与游戏页面描述不符，可发送邮件至 {email} 申请退款，并说明是哪款游戏以及出现了什么问题。', { brand, op, email: support })}</P>
      </S>
      <S h={t('What happens next', '之后会怎样')}>
        <P>{t('A refund goes back to the card or account you paid with, through Stripe, and removes your access to the game.', '退款将通过 Stripe 原路退回你付款时使用的银行卡或账户，退款后你将失去该游戏的访问权限。')}</P>
        <P>{t('Virtual items, in-game currency and progress are not refunded on their own, unless the law requires it.', '除非法律另有规定，虚拟物品、游戏内货币和进度不单独退款。')}</P>
      </S>
      <S h={t('Your rights', '你的权利')}>
        <p>{t('Nothing here limits the rights consumer law gives you where you live.', '本政策不限制你所在地区消费者保护法赋予你的任何权利。')}</p>
      </S>
    </>,
  };
  return (
    <div className="wrap page legal">
      <PageHeader eyebrow={t('Legal', '法律信息')} title={legalTitle(doc)} sub={t('Effective date: {date}', '生效日期：{date}', { date: EFFECTIVE[doc] })} />
      <p className="legal-op mute">{linked(t('{brand} is developed and operated by {op}, a {state} limited liability company (horylo.com).', '{brand} 由 {op}（一家 {state} 州有限责任公司，horylo.com）开发和运营。', { brand, op, state }))}</p>
      {!LAWYER_REVIEWED && <Notice tone="info" role="note" title={t('Draft pending legal review', '待法律审核的草稿')}>{t('This text has not yet been reviewed by a lawyer and may change before launch.', '本文本尚未经过律师审核，上线前可能会有修改。')}</Notice>}
      <Tabs active={doc} items={LEGAL_DOCS.map((d) => ({ key: d, to: `/legal/${d}`, label: legalTitle(d) }))} />
      <article className="legal-body">{body[doc]}</article>
    </div>
  );
}
