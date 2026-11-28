import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePlayClock } from '../play-clock';
import { ago, api, bytes, dateTime, Fail, genreName, navigate, num, playTime, series, Stars, t, usd, useAct, useApp, useData, count } from '../lib';
import { withPlayLang, type Orientation, type StageCtl } from '../player';
import { Badge, Bars, Button, Card, ChartBlock, CheckRow, EmptyState, Input, KeyValue, ListPager, Modal, Notice, PageHeader, Stat, StatGrid, StatusBadge, Switch, Table } from '../ui';
import { ProjectSkeleton } from '../skeletons';
import { Stage } from './Game';
import { defaultPreviewOrientation, resolvePreviewFrame, type PreviewDevice, type PreviewOrientation } from '../preview-viewport';
import { CaptureButtons, FeedbackEditor, FeedbackQueue, type Shot } from '../feedback';
import { projectTabs } from './Analytics';
import { CompatSection, useCompat, type GameCompat } from '../compat-ui';
import { AgeBadge, ageLabel } from '../meta-ui';
import { TestPlayers } from '../test-bots';
import { DevlogCard } from '../devlog-ui';
import { ComingSoonCard } from '../wishlist-ui';
import { PlaytestCard } from '../playtest-ui';
import { CouponsCard } from '../coupon-ui';
import { BundlesCard } from '../bundle-ui';

/** What this version needs from a player's browser, checked against yours: the store page shows players the same. */
const metaField = (f: string) => ({ genre: t('Genre', '类型'), tags: t('Tags from the platform list', '平台标签'), requirements: t('Compatibility requirements', '兼容性要求'), languages: t('Languages', '语言'), players: t('Players', '玩家'), content: t('Content descriptors (age rating)', '内容描述（年龄分级）') } as Record<string, string>)[f] ?? f;

/** What the store page shows about the newest version, and what publishing still needs. */
function StoreMetadata({ m }: { m: { version: number; required: boolean; missing: string[]; age: number | null } }) {
  return (
    <Card title={t('Store page metadata', '商店页面元数据')} aside={<span className="dim fs-sm">v{m.version}</span>} pad>
      {m.age != null && <div className="row"><AgeBadge age={m.age} /><b>{ageLabel(m.age)}</b></div>}
      {m.missing.length ? <>
        <p className="mute fs-sm">{m.required ? t('Publishing needs these first:', '发布前需要先填写：') : t('Not filled in yet:', '尚未填写：')}</p>
        <ul className="meta-missing">{m.missing.map((f) => <li key={f}>{metaField(f)}</li>)}</ul>
        <p className="dim fs-sm">{t('Ask your agent to run game_metadata. It walks through each one with the allowed values and what it detected in the code.', '让你的智能体执行 game_metadata。它会逐项说明可选的值以及从代码中检测到的内容。')}</p>
      </> : <p className="mute fs-sm"><Badge tone="good" dot={false}>{t('Complete', '已完整')}</Badge> {t('Everything the store page needs is on record.', '商店页面所需的信息都已齐全。')}</p>}
    </Card>
  );
}

/** Where the game stands in the store (src/store-quality.ts): the New shelf and what it still needs to reach the main
    store, hiding by player reports, and the weekly cap on new games. */
const NEED_LABEL = {
  players: (have: number, need: number) => t('Players other than you: {have} of at least {need}', '除你之外的玩家：{have}（至少 {need}）', { have, need }),
  minutes: (have: number, need: number) => t('Average play time per player: {have} min of at least {need} min', '每位玩家平均游玩时长：{have} 分钟（至少 {need} 分钟）', { have, need }),
  quit: (have: number, need: number) => t('Players who left within a minute and never came back: {have}% (at most {need}%)', '一分钟内离开且再未回来的玩家：{have}%（至多 {need}%）', { have, need }),
  ratings: (have: number, need: number) => t('Ratings: {have} of at least {need}', '评分数：{have}（至少 {need}）', { have, need }),
  rating: (have: number, need: number) => t('Average rating: {have} (at least {need})', '平均评分：{have}（至少 {need}）', { have, need }),
};
function StoreStanding({ st, live }: { st: any; live: boolean }) {
  const left = st.graduation ? st.graduation.needs.filter((n: any) => !n.ok) : [];
  const cap = st.new_game_cap;
  return (
    <Card title={t('In the store', '在商店中')} pad>
      <div className="stack s">
        {st.hidden && <p className="bad">{st.hidden.reason === 'reports' ? t('Hidden from the store: enough players reported it. It stays playable by its link, and comes back by itself when you put a fixed version live.', '已在商店中隐藏：举报的玩家已达到阈值。它仍可通过链接游玩；你上线修复后的新版本后，它会自动回到商店。') : t('Hidden from the store by the platform.', '已被平台在商店中隐藏。')}</p>}
        {!st.new_shelf_on || st.shelf === 'main' ? <p>{live ? t('On the main store.', '在主商店中。') : t('Once live, it goes straight to the main store.', '上线后直接进入主商店。')}</p> : <>
          <p>{live ? t('On the New shelf. It moves to the main store once players stick with it:', '在新品架上。玩家愿意持续游玩后，它会进入主商店：') : t('Once live, it starts on the New shelf and moves to the main store once players stick with it:', '上线后先进入新品架，玩家愿意持续游玩后进入主商店：')}</p>
          {st.graduation && <ul className="fs-sm">{st.graduation.needs.map((n: any) => <li key={n.id} className={n.ok ? 'mute' : ''}>{n.ok ? '✓ ' : '○ '}{NEED_LABEL[n.id as keyof typeof NEED_LABEL]?.(n.have, n.need) ?? n.id}</li>)}</ul>}
          {live && !left.length && <p className="dim fs-sm">{t('It meets every condition and moves within 10 minutes.', '已满足所有条件，10 分钟内会移入主商店。')}</p>}
        </>}
        {st.reports_open > 0 && <p className="fs-sm">{t('{n} open player reports.', '{n} 条待处理的玩家举报。', { n: st.reports_open })}</p>}
        {cap && cap.limited && <p className="dim fs-sm">{t('New games you put live in the last 7 days: {used} of {cap}.', '过去 7 天你上线的新游戏：{used} / {cap}。', { used: cap.used, cap: cap.cap })}{cap.next_at ? ' ' + t('The next slot opens {when}.', '下一个名额将于 {when} 开放。', { when: dateTime(cap.next_at) }) : ''}</p>}
      </div>
    </Card>
  );
}

function VersionCompat({ c }: { c: GameCompat }) {
  const v = useCompat(c);
  return <div className="ver-compat"><CompatSection c={c} v={v} /></div>;
}

function Report({ v }: { v: any }) {
  const r = v.report;
  if (!r) return <p className="mute">{v.status === 'verified' || v.status === 'failed' ? t('No report was stored for this version.', '该版本没有保存报告。') : t('Working on it. This page refreshes by itself.', '处理中，页面会自动刷新。')}</p>;
  return (
    <div className="stack">
      <div>{(r.checks || []).map((c: any) => <CheckRow key={c.id} ok={c.ok} title={c.label} detail={c.detail} hint={!c.ok && c.hint} />)}</div>
      {r.playthrough === null && (r.checks || []).some((c: any) => c.id === 'input') && <p className="mute fs-sm">{t('Only start-up, rendering and input were checked. This version has no play-through script (optional), so nothing played it through its own rules. Your agent can add one.', '仅检查了启动、渲染与输入。该版本没有试玩脚本（可选），因此没有按游戏自己的规则试玩。可以让你的智能体补上。')}</p>}
      {!!r.errors?.length && <div className="log">{r.errors.join('\n')}</div>}
      {!!r.missing?.length && <div className="log">{t('Files that failed to load', '加载失败的文件')}:{'\n'}{r.missing.join('\n')}</div>}
      {r.browser === 'unavailable' && <p className="mute fs-sm">{t('The automatic browser check could not run for this version. Play the preview yourself for a short while to verify it.', '该版本无法进行自动浏览器检查。请亲自试玩预览版一小段时间来完成验证。')}</p>}
    </div>
  );
}

/** Open Implementation as a build skill: share the skill the game's agent writes (free or for a price) in the Creator
 *  Store, see whether it matches the live and the newest version */
function BuildSkill({ id, p, skill, reload }: { id: string; p: any; skill: any; reload: () => Promise<unknown> }) {
  const { busy, act } = useAct(), [priceText, setPriceText] = useState<string | null>(null), s = useApp().config.settings;
  const cut = Number(s.platform_fee_percent), openCut = Number(s.platform_fee_open_percent ?? cut), skillCut = Number(s.skill_fee_percent ?? 5);
  const on = !!p.open_implementation, paidSkill = skill.price_cents > 0;
  const newestRow = skill.versions?.find((v: any) => v.version === skill.newest_version);
  const newestHas = !!newestRow;
  const newestMissing: string[] = newestRow ? (newestRow.missing_languages || []) : [];
  const perk = paidSkill
    ? t('A sold skill: this game keeps the standard {cut}% cut on its own sales, and the platform keeps {skill}% of each skill sale.', '付费技能：这款游戏自身销售按标准 {cut}% 收取，平台另从每笔技能销售中收取 {skill}%。', { cut, skill: skillCut })
    : p.price_cents > 0
      ? (s.paid_games_enabled && openCut < cut ? t('A free skill: while shared, the platform keeps {open}% of each sale of this game instead of {cut}%.', '免费技能：开放期间，平台从这款游戏的每笔销售中收取 {open}%，而不是 {cut}%。', { open: openCut, cut }) : null)
      : (Number(s.open_impl_free_boost_percent) > 0 ? t('While shared, this free game ranks higher among free games, unless players rate it poorly.', '开放期间，这款免费游戏在免费游戏中排名更靠前（玩家评价较差时除外）。') : null);
  const toggle = (next: boolean) => act('impl', async () => { await api(`/console/projects/${id}`, { method: 'PATCH', body: { open_implementation: next } }); await reload(); },
    next ? t('Shared. The build skill is now in the Creator Store.', '已开放。构建技能现已上架创作者商店。') : t('No longer shared.', '已停止分享。'));
  const savePrice = (cents: number) => act('sprice', async () => { await api(`/console/projects/${id}`, { method: 'PATCH', body: { skill_price_cents: cents } }); setPriceText(null); await reload(); },
    cents ? t('Skill price set to {price}.', '技能价格已设为 {price}。', { price: usd(cents) }) : t('The skill is now free.', '技能现在免费。'));
  const submitPrice = () => { const c = Math.round(Number(String(priceText).replace(',', '.')) * 100); if (!Number.isFinite(c) || c < 0) return; void savePrice(c); };
  const live = skill.live;
  return (
    <Card title={t('Build skill', '构建技能')} aside={<span className="dim fs-sm">{t('Open implementation', '开放实现')}</span>} pad>
      <div className="stack">
        <label className="row" style={{ gap: 12, cursor: 'pointer' }}>
          <Switch checked={on} disabled={busy === 'impl'} onChange={(e) => void toggle(e.target.checked)} aria-label={t('Share this game\'s build skill', '分享这款游戏的构建技能')} />
          <b>{on ? t('In the Creator Store', '已上架创作者商店') : t('Not shared', '未分享')}</b>
          {on && <Badge dot={false} tone={paidSkill ? 'accent' : 'good'}>{paidSkill ? usd(skill.price_cents) : t('Free', '免费')}</Badge>}
        </label>
        <p className="mute fs-sm">{t('Your agent writes this game\'s build skill: how it is made, as an agent skill other developers\' agents can follow to build something similar. No source code is ever shared. Your agent updates it before each release, so it always matches the live game.', '你的智能体会为这款游戏编写构建技能：以智能体技能的形式说明它是如何做出来的，其他开发者的智能体可以按此做出类似的游戏。源代码永远不会被分享。智能体会在每次发布前更新它，使其始终与线上游戏一致。')}</p>
        {perk && <p className={on ? 'good fs-sm' : 'fs-sm'}>{perk}</p>}
        <KeyValue items={[
          [t('Live skill', '线上技能'), !live ? <span className="dim">{t('Not written yet', '尚未编写')}</span> : live.written_by_platform ? <span className="sig">{t('Not written by your agent yet', '你的智能体尚未编写')}</span> : <span className={live.in_sync ? undefined : 'sig'}>v{live.version} · {live.in_sync ? t('matches the live game', '与线上游戏一致') : t('behind the live game', '落后于线上游戏')}{live.languages?.length ? ` (${live.languages.join(', ')})` : ''}</span>],
          skill.newest_version && [t('Newest version', '最新版本'), <span className={newestHas && !newestMissing.length ? undefined : 'sig'}>v{skill.newest_version} · {!newestHas ? t('no skill yet', '尚无技能') : newestMissing.length ? t('missing languages: {langs}', '缺少语言：{langs}', { langs: newestMissing.join(', ') }) : t('skill written', '技能已编写')}</span>],
          on && [t('Copies', '复制次数'), num(skill.copies)],
          on && paidSkill && [t('Skill sales', '技能销量'), `${num(skill.sales?.n || 0)} · ${usd(skill.sales?.net || 0)}`],
        ]} />
        {on && skill.required_to_publish && skill.newest_version && (!newestHas || newestMissing.length > 0) && skill.newest_version !== p.live_version && <Notice tone="info">{!newestHas
          ? t('Before version {n} can go live, ask your agent to update the build skill for it (build_skill). Publishing waits for it while the skill is shared.', '第 {n} 版上线前，请让你的智能体为它更新构建技能（build_skill）。技能分享期间，发布会等待技能就绪。', { n: skill.newest_version })
          : t('Before version {n} can go live, ask your agent to finish the missing build skill languages ({langs}) via build_skill.', '第 {n} 版上线前，请让你的智能体通过 build_skill 补齐构建技能缺失的语言（{langs}）。', { n: skill.newest_version, langs: newestMissing.join(', ') })}</Notice>}
        <div className="stack s">
          <b className="fs-sm">{t('Skill price', '技能价格')}</b>
          {priceText === null ? (
            <div className="row"><span>{paidSkill ? usd(skill.price_cents) : t('Free', '免费')}</span>{s.paid_skills_enabled !== false && <Button size="sm" className="right" onClick={() => setPriceText(paidSkill ? (skill.price_cents / 100).toFixed(2) : '')}>{t('Change', '修改')}</Button>}{paidSkill && <Button size="sm" variant="ghost" onClick={() => void savePrice(0)} disabled={busy === 'sprice'}>{t('Make free', '改为免费')}</Button>}</div>
          ) : (
            <div className="price-edit"><span className="mute">$</span><Input mono inputMode="decimal" value={priceText} placeholder="0.00" onChange={(e) => setPriceText(e.target.value)} autoFocus aria-label={t('Skill price in US dollars', '技能美元价格')} /><Button variant="primary" onClick={submitPrice} disabled={busy === 'sprice'}>{t('Save', '保存')}</Button><Button variant="ghost" onClick={() => setPriceText(null)}>{t('Cancel', '取消')}</Button></div>
          )}
          {skill.split ? <KeyValue items={[[t('Skill commission', '技能佣金'), usd(skill.split.fee)], [t('You receive per skill sale', '每笔技能销售你获得'), usd(skill.split.net), 'good']]} />
            : <p className="dim fs-sm">{s.paid_skills_enabled !== false ? t('Free skills show in full to everyone. To sell it, set a price from {min} to {max}; the platform keeps {skill}% of each skill sale, apart from game sales.', '免费技能对所有人完整展示。如需出售，可定价 {min} 至 {max}；平台从每笔技能销售中收取 {skill}%，与游戏销售分开计算。', { min: usd(s.skill_price_min_cents), max: usd(s.skill_price_max_cents), skill: skillCut }) : t('Selling skills is turned off on this platform.', '平台暂未开放技能销售。')}</p>}
        </div>
        <div className="row wrapx">
          {on && p.status === 'live' && <Button size="sm" variant="primary" to={`/creator-store/${p.slug}`}>{t('Open in the Creator Store', '在创作者商店中查看')}</Button>}
          {!p.live_version && <span className="dim fs-sm">{t('Publish the game first. The skill describes the live version.', '请先发布游戏，技能描述的是线上版本。')}</span>}
        </div>
      </div>
    </Card>
  );
}

/** A paid game's free trial: whether players may try it before buying, and for how many minutes. Kept per player account on the server. */
function FreeTrial({ id, paid, trial, max, reload }: { id: string; paid: boolean; trial: { minutes: number; active: boolean; players: number; bought: number }; max: number; reload: () => Promise<unknown> }) {
  const { busy, act } = useAct(), [mins, setMins] = useState<string | null>(null);
  const on = paid && trial.minutes > 0;
  const save = (m: number) => act('trial', async () => {
    if (!Number.isInteger(m) || m < 0 || m > max) throw new Error(t('Enter a whole number of minutes from 1 to {max}.', '请输入 1 到 {max} 之间的整数分钟。', { max }));
    await api(`/console/projects/${id}`, { method: 'PATCH', body: { trial_minutes: m } }); setMins(null); await reload();
  }, m ? t('Free trial set to {m} minutes.', '免费试玩已设为 {m} 分钟。', { m }) : t('Free trial turned off.', '已关闭免费试玩。'));
  const toggle = (next: boolean) => { if (next) setMins(String(trial.minutes || Math.min(30, max))); else if (trial.minutes) void save(0); else setMins(null); };
  return (
    <Card title={t('Free trial', '免费试玩')} pad>
      <div className="row">
        <span className="grow">{!paid ? t('Set a price first. A free game needs no trial.', '请先设置价格。免费游戏无需试玩。') : on ? <b>{trial.minutes === 1 ? t('1 minute before buying', '购买前可玩 1 分钟') : t('{minutes} minutes before buying', '购买前可玩 {minutes} 分钟', { minutes: trial.minutes })}</b> : t('Players must buy before playing.', '玩家需购买后才能游玩。')}</span>
        <Switch checked={on || mins !== null} disabled={!paid || busy === 'trial'} onChange={(e) => toggle(e.target.checked)} aria-label={t('Let players try it for free', '允许玩家免费试玩')} />
      </div>
      {mins !== null && (
        <div className="trial-edit">
          <Input mono inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value.replace(/[^0-9]/g, ''))} autoFocus aria-label={t('Trial length in minutes', '试玩时长（分钟）')} />
          <span className="mute">{t('minutes', '分钟')}</span>
          <Button variant="primary" onClick={() => void save(Number(mins))} disabled={busy === 'trial' || !mins}>{t('Save', '保存')}</Button>
          <Button variant="ghost" onClick={() => setMins(null)}>{t('Cancel', '取消')}</Button>
        </div>
      )}
      {on && mins === null && <div className="row"><span className="mute fs-sm grow">{t('{players} tried it · {bought} then bought it', '{players} 人试玩 · 其中 {bought} 人购买', { players: num(trial.players), bought: num(trial.bought) })}</span><Button size="sm" onClick={() => setMins(String(trial.minutes))}>{t('Change', '修改')}</Button></div>}
      <p className="dim fs-sm">{t('Players who have not bought the game can play this long in total, then are asked to buy. The time is counted on our servers for their account, so reloading or switching devices does not reset it. Up to {max} minutes.', '未购买的玩家总共可以玩这么久，之后会提示购买。时长按玩家账号在服务器端计算，刷新页面或更换设备都不会重置。最长 {max} 分钟。', { max })}</p>
    </Card>
  );
}

type SaleView = {
  enabled: boolean; running: { price_cents: number; regular_cents: number; percent_off: number; starts_at: number; ends_at: number } | null;
  last: { price_cents: number; starts_at: number; ended_at: number } | null; next_sale_at: number | null;
  rules: { max_days: number; min_percent_off: number; min_price_cents: number; gap_days: number }; split: { fee: number; net: number } | null;
};
/** A limited-time sale (src/sales.ts): a lower price for a number of days, then the regular price again by itself. */
function SaleCard({ id, regular, sale, reload }: { id: string; regular: number; sale: SaleView; reload: () => Promise<unknown> }) {
  const { busy, act } = useAct(), [form, setForm] = useState<{ price: string; days: string } | null>(null);
  const r = sale.rules, run = sale.running, most = Math.floor((regular * (100 - r.min_percent_off)) / 100);
  const daysSoFar = run ? Math.ceil((Date.now() - run.starts_at) / 86_400_000) : 0;
  const open = () => setForm(run ? { price: (run.price_cents / 100).toFixed(2), days: String(Math.round((run.ends_at - run.starts_at) / 86_400_000)) } : { price: (Math.max(r.min_price_cents, Math.round(regular * 0.75)) / 100).toFixed(2), days: String(Math.min(7, r.max_days)) });
  const save = () => act('sale', async () => {
    const cents = Math.round(parseFloat(form?.price || '') * 100), days = Number(form?.days);
    if (!Number.isFinite(cents) || cents <= 0) throw new Error(t('Enter a sale price like 2.99.', '请输入类似 2.99 的特价。'));
    if (!Number.isInteger(days) || days < 1 || days > r.max_days) throw new Error(t('Enter a whole number of days from 1 to {max}.', '请输入 1 到 {max} 之间的整数天数。', { max: r.max_days }));
    await api(`/console/projects/${id}`, { method: 'PATCH', body: { sale: { price_cents: cents, days } } }); setForm(null); await reload();
  }, run ? t('Sale updated.', '特价已更新。') : t('Sale started. The store shows it now.', '特价已开始，商店已同步显示。'));
  const end = () => { if (confirm(t('End the sale now? The game goes back to {price} at once.', '确定现在结束特价吗？游戏将立即恢复为 {price}。', { price: usd(regular) }))) void act('sale', async () => { await api(`/console/projects/${id}`, { method: 'PATCH', body: { sale: null } }); await reload(); }, t('Sale ended.', '特价已结束。')); };
  const waiting = !run && sale.next_sale_at && sale.next_sale_at > Date.now() ? sale.next_sale_at : null;
  return (
    <Card title={t('Limited-time sale', '限时特价')} pad>
      {!sale.enabled ? <p className="mute fs-sm">{t('Sales are turned off on this platform.', '平台暂未开放特价。')}</p>
        : !(regular > 0) ? <p className="mute fs-sm">{t('Set a price first. A free game cannot go on sale.', '请先设置价格。免费游戏无法设置特价。')}</p>
        : <>
          {run && form === null && <>
            <div className="row"><b className="price-big">{usd(run.price_cents)}</b><Badge tone="accent" dot={false}>−{run.percent_off}%</Badge><s className="mute">{usd(run.regular_cents)}</s></div>
            <KeyValue items={[[t('Ends', '结束时间'), dateTime(run.ends_at)], ...(sale.split ? [[t('You receive per sale', '每笔销售你获得'), usd(sale.split.net), 'good'] as [string, string, string]] : [])]} />
            <div className="row"><Button size="sm" onClick={open}>{t('Change', '修改')}</Button><Button size="sm" variant="ghost" onClick={end} disabled={busy === 'sale'}>{t('End sale', '结束特价')}</Button></div>
          </>}
          {!run && form === null && <div className="row"><span className="grow">{waiting ? t('The next sale can start {date}.', '下一次特价可于 {date} 开始。', { date: dateTime(waiting) }) : t('Not on sale.', '目前没有特价。')}</span><Button size="sm" variant="primary" onClick={open} disabled={!!waiting}>{t('Start a sale', '开始特价')}</Button></div>}
          {form !== null && (
            <div className="stack s">
              <div className="price-edit"><span className="mute">$</span><Input mono inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} autoFocus aria-label={t('Sale price in US dollars', '特价（美元）')} />
                <Input mono inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value.replace(/[^0-9]/g, '') })} aria-label={t('Sale length in days', '特价天数')} /><span className="mute">{run ? t('days in total', '天（总计）') : t('days', '天')}</span></div>
              <div className="row"><Button variant="primary" onClick={save} disabled={busy === 'sale'}>{run ? t('Save', '保存') : t('Start sale', '开始特价')}</Button><Button variant="ghost" onClick={() => setForm(null)}>{t('Cancel', '取消')}</Button></div>
              {run && <p className="dim fs-sm">{t('Counted from when the sale started, {days} days ago.', '从特价开始时计算，已进行 {days} 天。', { days: daysSoFar })}</p>}
            </div>
          )}
          <p className="dim fs-sm">{t('Buyers pay the sale price until it ends; the store shows it with your regular price struck through and when it ends. A sale takes at least {pct}% off ({most} or less), lasts up to {max} days, and your regular price stays fixed while it runs.', '特价结束前，买家按特价付款；商店会显示特价、划掉的原价以及结束时间。特价至少优惠 {pct}%（{most} 或更低），最长 {max} 天，期间原价不可修改。', { pct: r.min_percent_off, most: usd(most), max: r.max_days })}{r.gap_days > 0 ? ' ' + t('The next sale can start {gap} days after one ends or after the regular price goes up.', '特价结束或原价上调后，需等待 {gap} 天才能开始下一次特价。', { gap: r.gap_days }) : ''}</p>
        </>}
    </Card>
  );
}

export function Project({ id }: { id: string }) {
  const { config } = useApp(), { busy, act } = useAct(), s = config.settings;
  const { data, error, loading, reload } = useData<any>(`/console/projects/${id}`);
  const [open, setOpen] = useState<number | null>(null), [preview, setPreview] = useState<string | null>(null), [previewSession, setPreviewSession] = useState<string | null>(null), [previewClock, setPreviewClock] = useState<string | null>(null), [previewOrient, setPreviewOrient] = useState<Orientation>('any'), [priceText, setPriceText] = useState<string | null>(null);
  const [pvDevice, setPvDevice] = useState<PreviewDevice>('current'), [pvOrient, setPvOrient] = useState<PreviewOrientation>('portrait');
  const [pvWin, setPvWin] = useState(() => ({ vw: typeof innerWidth === 'number' ? innerWidth : 1440, vh: typeof innerHeight === 'number' ? innerHeight : 900, cw: 0 }));
  usePlayClock(preview ? previewSession : null, preview ? previewClock : null);   // the platform's play clock for the preview session (src/play-clock.ts)
  // creator feedback: a capture being marked up (the game keeps its place, hidden, behind the editor), and a counter that
  // refreshes the queue card after an item was added
  const stage = useRef<StageCtl>(null), stageBox = useRef<HTMLDivElement>(null), [shot, setShot] = useState<Shot | null>(null), [fbStamp, setFbStamp] = useState(0), [canCapture, setCanCapture] = useState(false);

  // Track modal stage container width & window dimensions for accurate Phone / Tablet scaling.
  useLayoutEffect(() => {
    if (!preview) return;
    const sync = () => setPvWin({ vw: innerWidth, vh: innerHeight, cw: stageBox.current?.clientWidth ?? 0 });
    sync();
    const el = stageBox.current;
    const ro = typeof ResizeObserver === 'function' && el ? new ResizeObserver(sync) : null;
    if (el) ro?.observe(el);
    addEventListener('resize', sync);
    return () => { ro?.disconnect(); removeEventListener('resize', sync); };
  }, [preview]);

  // While a deployment is running, keep the page fresh.
  const working = !!data?.versions.some((v: any) => ['queued', 'deploying', 'verifying'].includes(v.status));
  useEffect(() => { if (!working) return; const i = setInterval(() => void reload(), 4000); return () => clearInterval(i); }, [working, reload]);
  useEffect(() => { if (data && open === null && data.versions[0]) setOpen(data.versions[0].version); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <ProjectSkeleton />;
  const p = data.project, versions = data.versions as any[], reg: number = p.regular_price_cents ?? p.price_cents;   // the regular price; p.price_cents is the sale price during a sale
  const playPreview = () => act('pv', async () => {
    const r = await api<{ url: string; session: string; clock?: string; orientation?: Orientation }>(`/console/projects/${id}/preview`, { method: 'POST' });
    const orient = r.orientation ?? 'any';
    setPreviewSession(r.session); setPreviewClock(r.clock || null); setPreviewOrient(orient);
    setPvDevice('current'); setPvOrient(defaultPreviewOrientation('phone', orient));
    setPreview(withPlayLang(r.url));
  });
  const pickDevice = (next: PreviewDevice) => {
    setPvDevice(next);
    if (next !== 'current') setPvOrient(defaultPreviewOrientation(next, previewOrient));
  };
  const offline = () => { if (confirm(t('Take this game offline? Players will not be able to open it until you put it back.', '确定下线这款游戏吗？在重新上线之前，玩家将无法打开它。'))) void act('off', async () => { await api(`/console/projects/${id}/offline`, { method: 'POST' }); await reload(); }, t('The game is offline.', '游戏已下线。')); };
  // Delete project (src/project-delete.ts): the creator types the game's address; the server refuses a live or bought game
  const remove = () => {
    const typed = prompt(t('Delete "{title}"? It stops counting toward your project limit and its preview stops working. Players\' saves are deleted after 30 days. Type its address ({slug}) to confirm.', '确定删除“{title}”吗？它将不再计入你的项目上限，预览也会停止。玩家存档会在 30 天后删除。请输入它的地址（{slug}）确认。', { title: p.title, slug: p.slug }));
    if (typed === null) return;
    void act('del', async () => { await api(`/console/projects/${id}/delete`, { method: 'POST', body: { confirm: typed.trim() } }); navigate('/console', true); }, t('Project deleted.', '项目已删除。'));
  };
  const online = () => act('on', async () => { await api(`/console/projects/${id}/online`, { method: 'POST' }); await reload(); }, t('Going back online. This takes a moment.', '正在重新上线，请稍候。'));
  const savePrice = () => act('price', async () => {
    const cents = Math.round(parseFloat(priceText || '0') * 100);
    if (!Number.isFinite(cents) || cents < 0) throw new Error(t('Enter a price like 4.99, or 0 for free.', '请输入类似 4.99 的价格，免费请填 0。'));
    await api(`/console/projects/${id}`, { method: 'PATCH', body: { price_cents: cents } }); setPriceText(null); await reload();
  }, t('Price saved.', '价格已保存。'));
  const plays = series<any>(data.daily, 30, (r) => r.plays), mins = series<any>(data.daily, 30, (r) => Math.round(r.seconds / 60));
  const sum30 = (k: string) => data.daily.reduce((a: number, r: any) => a + r[k], 0);

  return (
    <div className="wrap page">
      <PageHeader back={{ to: '/console', label: t('Console', '控制台') }} title={p.title} badge={<StatusBadge status={p.status} />} sub={p.tagline || undefined}
        actions={<>
          {p.preview_version && <Button onClick={playPreview} disabled={busy === 'pv'}>▶ {t('Play preview', '试玩预览')} v{p.preview_version}</Button>}
          {p.status === 'live' && <Button to={`/g/${p.slug}`}>{t('Store page', '商店页面')}</Button>}
          {p.status === 'live' && <Button variant="danger" onClick={offline} disabled={busy === 'off'}>{t('Take offline', '下线')}</Button>}
          {p.status === 'offline' && p.live_version && <Button variant="primary" onClick={online} disabled={busy === 'on'}>{t('Put back online', '重新上线')}</Button>}
        </>} />
      {projectTabs(id, 'overview')}
      {p.status === 'removed' && <div style={{ marginBottom: 22 }}><Notice tone="bad">{t('This game was removed by the platform.', '该游戏已被平台移除。')} {p.removed_reason}</Notice></div>}

      <div className="stack l">
        <StatGrid>
          <Stat tone="accent" to={`/console/p/${id}/analytics`} label={t('Online now', '当前在线')} value={num(data.online?.online.live ?? 0)} sub={t('{n} in rooms · see analytics', '{n} 人在房间中 · 查看数据分析', { n: num(data.online?.rooms.players_in_rooms ?? 0) })} />
          <Stat label={t('Plays', '游玩次数')} value={num(p.plays)} sub={`${num(sum30('plays'))} ${t('in 30 days', '近 30 天')}`} />
          <Stat label={t('Time played', '游玩时长')} value={playTime(p.minutes * 60)} sub={`${playTime(sum30('seconds'))} ${t('in 30 days', '近 30 天')}`} />
          <Stat label={t('Rating', '评分')} value={p.rating != null ? p.rating.toFixed(1) : '—'} sub={count(p.rating_count, 'rating', 'ratings', '个评分')} />
          <Stat label={t('Game sales', '游戏销量')} value={num(data.sales.n)} sub={`${usd(data.sales.net)} ${t('to you', '归你所得')} · ${usd(data.sales.gross)} ${t('gross', '总额')}`} />
          <Stat label={t('Skill sales', '技能销量')} value={num(data.skill?.sales?.n || 0)} sub={`${usd(data.skill?.sales?.net || 0)} ${t('to you', '归你所得')} · ${t('{n} copies', '{n} 次复制', { n: num(data.skill?.copies || 0) })}`} />
        </StatGrid>

        <div className="cols">
          <div className="stack l">
            <ProjectVersionsCard id={id} project={p} initial={versions} total={data.versions_total ?? versions.length} open={open} setOpen={setOpen} />

            <Card title={t('Last 30 days', '近 30 天')} pad>
              <div className="stack l">
                <ChartBlock label={t('Plays per day', '每日游玩次数')} value={num(sum30('plays'))}><Bars data={plays} tip={(d) => `${d.label} · ${d.value}`} /></ChartBlock>
                <ChartBlock label={t('Minutes played per day', '每日游玩分钟数')} value={playTime(sum30('seconds'))}><Bars data={mins} tip={(d) => `${d.label} · ${d.value} min`} /></ChartBlock>
              </div>
            </Card>

            <ProjectErrorsCard id={id} initial={data.errors} total={data.errors_total ?? data.errors.length} />
          </div>

          <div className="stack l">
            {s.feedback_enabled !== false && <FeedbackQueue projectId={id} stamp={fbStamp} />}
            {data.store && <StoreStanding st={data.store} live={data.project.status === 'live'} />}
            {data.metadata && <StoreMetadata m={data.metadata} />}
            <Card title={t('Price', '价格')} pad>
              {priceText === null ? (
                <div className="row"><b className="price-big">{reg > 0 ? usd(reg) : t('Free', '免费')}</b>{s.paid_games_enabled && <Button size="sm" className="right" onClick={() => setPriceText((reg / 100).toFixed(2))} disabled={!!data.sale?.running} title={data.sale?.running ? t('End the sale to change the regular price.', '结束特价后才能修改原价。') : undefined}>{t('Change', '修改')}</Button>}</div>
              ) : (
                <div className="price-edit"><span className="mute">$</span><Input mono inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} autoFocus aria-label={t('Price in US dollars', '美元价格')} /><Button variant="primary" onClick={savePrice} disabled={busy === 'price'}>{t('Save', '保存')}</Button><Button variant="ghost" onClick={() => setPriceText(null)}>{t('Cancel', '取消')}</Button></div>
              )}
              {data.split ? <KeyValue items={[[t('Platform fee', '平台服务费'), usd(data.split.fee)], [t('You receive per sale', '每笔销售你获得'), usd(data.split.net), 'good']]} />
                : <p className="mute fs-sm">{s.paid_games_enabled ? t('Free to play. Set a price between {min} and {max} to sell it; the platform keeps {cut}% of each sale.', '目前免费。可在 {min} 至 {max} 之间定价销售，平台从每笔销售中收取 {cut}%。', { min: usd(s.game_price_min_cents), max: usd(s.game_price_max_cents), cut: s.platform_fee_percent }) : t('Paid games are turned off on this platform.', '平台暂未开放付费游戏。')}</p>}
            </Card>
            {s.paid_games_enabled && data.sale && <SaleCard id={id} regular={reg} sale={data.sale as SaleView} reload={reload} />}
            {s.paid_games_enabled && p.status !== 'removed' && <CouponsCard id={id} paid={p.price_cents > 0} />}
            {s.paid_games_enabled && p.status !== 'removed' && <BundlesCard id={p.id} paid={p.price_cents > 0} />}
            {s.paid_games_enabled && s.trials_enabled !== false && <FreeTrial id={id} paid={p.price_cents > 0} trial={data.trial} max={Number(s.trial_max_minutes) || 120} reload={reload} />}
            <BuildSkill id={id} p={p} skill={data.skill} reload={reload} />
            {p.status !== 'removed' && <ComingSoonCard id={id} onChange={reload} />}
            {p.status !== 'removed' && <PlaytestCard id={id} />}
            {p.status !== 'removed' && <DevlogCard id={id} slug={p.slug} live={p.status === 'live' || (!!p.coming_soon_at && !p.published_at)} />}
            <Card title={t('Details', '详情')} pad>
              <KeyValue items={[
                [t('Address', '地址'), `/g/${p.slug}`, 'mono'],
                [t('Working files', '工作区文件'), `${data.files.count} · ${bytes(data.files.bytes)}`],
                [t('Storage', '存储空间'), <span className={data.files.bytes > data.files.storage_bytes ? 'bad' : data.files.bytes >= data.files.storage_bytes * 0.8 ? 'sig' : undefined}>{t('{used} of {size} ({pct}%)', '已用 {used}，共 {size}（{pct}%）', { used: bytes(data.files.bytes), size: bytes(data.files.storage_bytes), pct: Math.round((data.files.bytes / Math.max(1, data.files.storage_bytes)) * 100) })}{data.files.request?.status === 'pending' && <span className="mute"> · {t('asked for {size}', '已申请 {size}', { size: bytes(data.files.request.bytes) })}</span>}</span>],
                [t('Tags', '标签'), p.tags.map(genreName).join(', ') || '—'],
                [t('Rating', '评分'), <Stars rating={p.rating} count={p.rating_count} />],
                [t('Project id', '项目 ID'), p.id, 'mono'],
              ]} />
            </Card>
            {p.status !== 'removed' && <Card title={t('Delete project', '删除项目')} pad>
              <p className="mute fs-sm">{p.status === 'live'
                ? t('Take the game offline before you delete it. A game someone has bought cannot be deleted; take it offline instead.', '删除前请先下线游戏。已有人购买的游戏无法删除，请改为下线。')
                : t('Frees a place under your project limit. A game someone has bought cannot be deleted.', '释放一个项目名额。已有人购买的游戏无法删除。')}</p>
              <Button variant="danger" size="sm" onClick={remove} disabled={p.status === 'live' || busy === 'del'}>{t('Delete project', '删除项目')}</Button>
            </Card>}
            <ProjectActivityCard id={id} initial={data.events} total={data.events_total ?? data.events.length} />
          </div>
        </div>
      </div>

      {preview && (() => {
        const pvFrame = resolvePreviewFrame({ device: pvDevice, orientation: pvOrient, containerW: pvWin.cw, viewportW: pvWin.vw, viewportH: pvWin.vh });
        const stageViewport = pvDevice === 'current' ? null : { device: pvDevice, w: pvFrame.w, h: pvFrame.h, displayW: pvFrame.displayW, displayH: pvFrame.displayH, scale: pvFrame.scale, touch: pvFrame.touch };
        const capture = (compact: boolean) => s.feedback_enabled !== false ? <CaptureButtons compact={compact} supported={canCapture} version={p.preview_version} capture={(pic) => stage.current!.capture(pic)}
          fullscreen={() => !!stage.current?.isActive()} onShot={(sh) => { if (stage.current?.isActive()) stage.current.exit(); (document.activeElement as HTMLElement | null)?.blur?.(); setShot(sh); }} /> : null;
        return (
          <Modal wide game onClose={() => { setPreview(null); setShot(null); void reload(); }}><div className="stack">
            <div className="pv-head">
              <div className="pv-head-id">
                <b className="clip">{p.title}</b>
                <Badge tone="info">{t('Preview', '预览')} v{p.preview_version}</Badge>
              </div>
              <Button size="sm" onClick={() => { setPreview(null); setShot(null); void reload(); }}>{t('Close', '关闭')}</Button>
            </div>
            <div className="pv-bar">
              <div className="pv-modes">
                <div className="seg" role="group" aria-label={t('Preview screen size', '预览屏幕尺寸')}>
                  <button type="button" data-testid="preview-mode-current" className={pvDevice === 'current' ? 'on' : undefined} aria-pressed={pvDevice === 'current'} onClick={() => pickDevice('current')}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
                    <span>{t('Current screen', '当前屏幕')}</span>
                  </button>
                  <button type="button" data-testid="preview-mode-phone" className={pvDevice === 'phone' ? 'on' : undefined} aria-pressed={pvDevice === 'phone'} onClick={() => pickDevice('phone')}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18h2" /></svg>
                    <span>{t('Phone', '手机')}</span>
                  </button>
                  <button type="button" data-testid="preview-mode-tablet" className={pvDevice === 'tablet' ? 'on' : undefined} aria-pressed={pvDevice === 'tablet'} onClick={() => pickDevice('tablet')}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M11 18h2" /></svg>
                    <span>{t('Tablet', '平板')}</span>
                  </button>
                </div>
                {pvDevice !== 'current' && (
                  <Button size="sm" className="pv-rot" data-testid="preview-rotate" onClick={() => setPvOrient((o) => o === 'portrait' ? 'landscape' : 'portrait')}
                    aria-label={pvOrient === 'portrait' ? t('Switch to landscape', '切换为横屏') : t('Switch to portrait', '切换为竖屏')}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.3M3 12a9 9 0 0 1 15.5-6.3" /><path d="M18.5 2.5v3.5h-3.5M5.5 21.5V18h3.5" /></svg>
                    <span>{pvOrient === 'portrait' ? t('Portrait', '竖屏') : t('Landscape', '横屏')}</span>
                  </Button>
                )}
              </div>
              <div className="pv-meta">
                <span className="pv-dim" data-testid="preview-dimensions">
                  {pvFrame.w} × {pvFrame.h}
                  {pvFrame.scale < 0.995 && <small>· {Math.round(pvFrame.scale * 100)}%</small>}
                </span>
              </div>
            </div>
            {/* While a capture is marked up, the editor covers the game rather than replacing it: the game's frame keeps its
                size and stays on screen. Hiding or shrinking it would resize the game, and a browser slows the drawing of a
                frame it no longer shows, which a game can take for a slow device and lower its picture quality for good. */}
            <div className="fb-stack">
              <div ref={stageBox} inert={shot ? true : undefined}>
                <Stage ctl={stage} poster={null} seed={p.slug} url={preview} orientation={previewOrient} viewport={stageViewport} controls={versions.find((v) => v.version === p.preview_version)?.controls ?? null} onQuit={() => { setPreview(null); setShot(null); void reload(); }} tools={capture(false)} badge={capture(true)} onCaptureHook={setCanCapture} />
              </div>
              {shot && <div className="fb-over"><FeedbackEditor projectId={id} shot={shot} onCancel={() => setShot(null)} onDone={() => { setShot(null); setFbStamp((n) => n + 1); }} /></div>}
            </div>
            <TestPlayers projectId={id} />
            <p className="dim fs-sm">{t('Only you can open the preview. Playing it without errors also counts as verification when the automatic check cannot run the game.', '预览仅你本人可见。当自动检查无法运行游戏时，你无错误地试玩一段时间也算通过验证。')}</p>
          </div></Modal>
        );
      })()}
    </div>
  );
}

const VER_PER = 10, ERR_PER = 10, ACT_PER = 15;

function ProjectVersionsCard({ id, project: p, initial, total, open, setOpen }: { id: string; project: any; initial: any[]; total: number; open: number | null; setOpen: (v: number | null) => void }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>(() => initial.slice(0, VER_PER));
  const [countTotal, setCountTotal] = useState(total);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setPage(1); }, [id]);
  useEffect(() => {
    if (page === 1) { setRows(initial.slice(0, VER_PER)); setCountTotal(total); setLoading(false); return; }
    let live = true; setLoading(true);
    api<{ versions: any[]; total: number }>(`/console/projects/${id}/versions?page=${page}&per_page=${VER_PER}`)
      .then((r) => { if (live) { setRows(r.versions); setCountTotal(r.total); } }, () => {})
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [id, page, initial, total]);

  return (
    <Card title={t('Versions', '版本')} aside={t('Your agent deploys, verifies and publishes', '由智能体部署、验证并发布')}>
      <div aria-busy={loading}>
        {rows.length ? rows.map((v) => (
          <div className={'ver' + (open === v.version ? ' open' : '')} key={v.version}>
            <button onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
              <span className="chev" aria-hidden="true" />
              <b className="mono">v{v.version}</b><StatusBadge status={v.status} />
              {p.live_version === v.version && <Badge tone="good" dot={false}>{t('Live', '线上')}</Badge>}
              {p.preview_version === v.version && <Badge tone="info" dot={false}>{t('Preview', '预览')}</Badge>}
              {v.human_ok && <Badge dot={false}>{t('Verified by play', '试玩验证')}</Badge>}
              <span className="mute clip grow fs-sm">{v.note || v.stage}</span>
              <span className="dim fs-sm" style={{ whiteSpace: 'nowrap' }}>{ago(v.created_at)}</span>
            </button>
            {open === v.version && (
              <div className="body">
                <div className="stack">{v.report?.summary && <p>{v.report.summary}</p>}<Report v={v} /></div>
                <div className="stack">
                  {v.screenshot ? <a href={v.screenshot} target="_blank" rel="noreferrer"><img src={v.screenshot} alt={t('Verification screenshot', '验证截图')} /></a> : <EmptyState compact title={t('No screenshot', '暂无截图')} />}
                  <KeyValue items={[
                    [t('Files', '文件'), `${v.files} · ${bytes(v.bytes)}`],
                    v.report?.metrics && [t('Load time', '加载耗时'), `${v.report.metrics.loadMs} ms`],
                    v.report?.metrics && [t('Frame rate in check', '检查帧率'), `${v.report.metrics.fps} fps`],
                    [t('Created', '创建于'), dateTime(v.created_at)],
                    v.published_at && [t('Published', '发布于'), dateTime(v.published_at)],
                  ]} />
                </div>
                {v.compat && <VersionCompat c={v.compat} />}
              </div>
            )}
          </div>
        )) : <div className="pad mute">{t('No version yet. Ask your agent to run deploy_preview.', '还没有版本。让你的智能体执行 deploy_preview。')}</div>}
      </div>
      <ListPager flush page={page} total={countTotal} perPage={VER_PER} onPage={setPage} />
    </Card>
  );
}

function ProjectErrorsCard({ id, initial, total }: { id: string; initial: any[]; total: number }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>(() => initial.slice(0, ERR_PER));
  const [countTotal, setCountTotal] = useState(total);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setPage(1); }, [id]);
  useEffect(() => {
    if (page === 1) { setRows(initial.slice(0, ERR_PER)); setCountTotal(total); setLoading(false); return; }
    let live = true; setLoading(true);
    api<{ errors: any[]; total: number }>(`/console/projects/${id}/errors?page=${page}&per_page=${ERR_PER}`)
      .then((r) => { if (live) { setRows(r.errors); setCountTotal(r.total); } }, () => {})
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [id, page, initial, total]);

  if (!countTotal && !rows.length) return null;
  return (
    <Card title={t('Errors players hit', '玩家遇到的错误')} aside={t('Reported by the game', '游戏自己上报的')}>
      <div aria-busy={loading}>
        <Table><thead><tr><th>{t('Message', '信息')}</th><th>{t('Version', '版本')}</th><th className="n">{t('Count', '次数')}</th><th className="n">{t('Last seen', '最近出现')}</th></tr></thead>
          <tbody>{rows.map((e: any, i: number) => <tr key={`${page}-${i}`}><td className="mono bad fs-sm" style={{ wordBreak: 'break-word' }}>{e.message}</td><td>v{e.version} · {e.env}</td><td className="n">{e.count}</td><td className="n">{ago(e.last_at)}</td></tr>)}</tbody></Table>
      </div>
      <ListPager flush page={page} total={countTotal} perPage={ERR_PER} onPage={setPage} />
    </Card>
  );
}

function ProjectActivityCard({ id, initial, total }: { id: string; initial: any[]; total: number }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>(() => initial.slice(0, ACT_PER));
  const [countTotal, setCountTotal] = useState(total);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setPage(1); }, [id]);
  useEffect(() => {
    if (page === 1) { setRows(initial.slice(0, ACT_PER)); setCountTotal(total); setLoading(false); return; }
    let live = true; setLoading(true);
    api<{ events: any[]; total: number }>(`/console/projects/${id}/events?page=${page}&per_page=${ACT_PER}`)
      .then((r) => { if (live) { setRows(r.events); setCountTotal(r.total); } }, () => {})
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [id, page, initial, total]);

  return (
    <Card title={t('Activity', '动态')}>
      <div className="pad" aria-busy={loading}>
        {rows.length ? <div>{rows.map((e: any, i: number) => (
          <div key={`${page}-${i}`} className="activity"><Badge dot={false}>{String(e.kind).replace(/_/g, ' ')}</Badge><span className="mute" style={{ wordBreak: 'break-word' }}>{e.version ? `v${e.version} ` : ''}{e.detail}</span><span className="dim" style={{ whiteSpace: 'nowrap' }}>{ago(e.created_at)}</span></div>
        ))}</div> : <span className="mute">{t('Nothing yet.', '暂无动态。')}</span>}
      </div>
      <ListPager flush compact page={page} total={countTotal} perPage={ACT_PER} onPage={setPage} />
    </Card>
  );
}

