// The Creator Store: every live game's build skill, free or sold, listed under its game. A build skill is an agent skill
// the game's own development agent wrote about how it is built (never its code), kept in step with the live version.
// Free skills show in full; a paid one shows its outline until it is bought. Copy skill puts a complete SKILL.md on the
// clipboard for the reader's own agent. Served by src/skills.ts.
import { useEffect, useRef, useState } from 'react';
import { api, artStyle, date, shown, type ListingI18n, Fail, Link, loginUrl, navigate, num, query, t, usd, useAct, useApp, useData, useLang } from '../lib';
import { LANGS } from '../i18n/langs';
import { Badge, Button, Card, Crumbs, EmptyState, KeyValue, ListPager, Notice, PageHeader, Segmented, Stat, StatGrid, Steps, Ticks } from '../ui';
import { Skeleton, SkRows } from '../ui/skeleton';
import { SkillMarkdown } from '../skill-md';

const PER = 24;

interface SkillLangMeta { description: string; sections: string[]; characters: number }
interface SkillEntry {
  game: { id: string; slug: string; title: string; tagline: string; by: string; tags: string[]; cover: string | null; lang?: string; i18n?: ListingI18n; game_page: string; plays: number; live_version: number; price_cents: number };
  skill: { name: string; price_cents: number; free: boolean; version: number; in_sync: boolean; written_by_platform: boolean; lang?: string; languages?: string[]; i18n?: Record<string, SkillLangMeta>; description: string; sections: string[]; characters: number; sales: number; copies: number; updated_at: number; page: string; owned?: boolean };
}
interface SkillItem extends SkillEntry {
  shared: boolean; access: 'free' | 'yours' | 'admin' | 'bought' | null; locked: boolean; active_lang?: string; content: string | null; skill_md: string | null;
  buy: { price_cents: number; sign_in: boolean } | null; never_shared: string;
  yours?: { sales: number; copies: number; views: number; creator_receives_per_sale: number | null };
}

const langLabel = (code: string) => LANGS.find((l) => l.code === code)?.name || code;
const priceTag = (s: SkillEntry['skill']) => (s.free ? <Badge tone="good" dot={false}>{t('Free', '免费')}</Badge> : <Badge tone="accent" dot={false}>{usd(s.price_cents)}</Badge>);
const syncTag = (e: SkillEntry) => (e.skill.in_sync
  ? <span className="dim fs-sm">{t('Matches live v{v}', '对应线上 v{v}', { v: e.game.live_version })}</span>
  : <span className="sig fs-sm">{t('Written for v{v} · live is v{live}', '写于 v{v} · 线上为 v{live}', { v: e.skill.version, live: e.game.live_version })}</span>);

/** The skills list: search, free or paid, and order. */
export function CreatorStore() {
  const [q, setQ] = useState(query().get('q') || ''), [price, setPrice] = useState<'all' | 'free' | 'paid'>('all'), [sort, setSort] = useState('popular');
  const [page, setPage] = useState(() => Math.max(1, Number(query().get('page')) || 1));
  const [typed, setTyped] = useState(q);
  useEffect(() => { const h = setTimeout(() => setQ(typed.trim()), 250); return () => clearTimeout(h); }, [typed]);
  useEffect(() => { setPage(1); }, [q, price, sort]);
  const path = `/creator-store?${new URLSearchParams({ ...(q ? { q } : {}), ...(price !== 'all' ? { price } : {}), sort, page: String(page), per_page: String(PER) }).toString()}`;
  const { data, error, loading, reload } = useData<{ total: number; page: number; per_page: number; pages: number; skills: SkillEntry[] }>(path);
  useEffect(() => { if (data && page > data.pages) setPage(data.pages); }, [data, page]);
  const { user } = useApp();
  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Creator Store', '创作者商店')} title={t('Build skills from live games', '来自线上游戏的构建技能')}
        sub={t('Each skill is written by a game\'s own development agent and kept in step with its latest release. Drop one into your agent to build something similar. Skills hold practices, never source code.', '每个技能都由游戏自己的开发智能体编写，并与其最新发布版本保持同步。把它放进你的智能体，就能做出类似的游戏。技能只包含实践经验，从不包含源代码。')}
        actions={user?.makes_games ? <Button to="/console">{t('Share your game\'s skill', '分享你的游戏技能')}</Button> : <Button to="/create">{t('Make a game', '创作游戏')}</Button>} />
      <div className="stack l">
        <Card>
          <div className="list-tools">
            <input className="input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('Search skills by game, genre or technique', '按游戏、类型或技术搜索技能')} aria-label={t('Search skills', '搜索技能')} />
            <Segmented label={t('Price', '价格')} value={price} onChange={setPrice} options={[['all', t('All', '全部')], ['free', t('Free', '免费')], ['paid', t('Paid', '付费')]]} />
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t('Sort', '排序')}>
              <option value="popular">{t('Most played games', '游玩最多的游戏')}</option><option value="new">{t('Recently updated', '最近更新')}</option><option value="sales">{t('Most used', '使用最多')}</option>
            </select>
          </div>
          {error && !data ? <div className="pad"><Fail error={error} retry={reload} /></div>
            : loading && !data ? <Skeleton><SkRows n={4} /></Skeleton>
              : !data!.skills.length ? <div className="pad"><EmptyState compact title={q || price !== 'all' ? t('No skill matches that.', '没有符合条件的技能。') : t('No skills shared yet', '还没有分享的技能')}>{t('Creators share a skill by turning on Open Implementation for a live game.', '创作者为线上游戏开启开放实现后，即可分享技能。')}</EmptyState></div>
                : <>
                  <div className="skill-grid">{data!.skills.map((e) => <SkillCard key={e.game.id} e={e} />)}</div>
                  <ListPager flush page={page} total={data!.total} perPage={PER} onPage={(p) => { setPage(p); scrollTo({ top: 0 }); }} />
                </>}
        </Card>
        <Card title={t('How build skills work', '构建技能如何运作')} pad>
          <Steps items={[
            t('A creator opens up their game\'s implementation and chooses free or a price.', '创作者开放游戏的实现方式，并选择免费或定价。'),
            t('Before every release, the game\'s development agent updates the skill, so it always matches the live version.', '每次发布前，游戏的开发智能体都会更新技能，确保它始终对应线上版本。'),
            t('You copy the skill into your own agent. It captures the game\'s best practices; how close you get depends on your agent.', '你把技能复制到自己的智能体中。它记录了这款游戏的最佳实践；能做到多接近取决于你的智能体。'),
          ]} />
        </Card>
      </div>
    </div>
  );
}

function SkillCard({ e: raw }: { e: SkillEntry }) {
  const lang = useLang();
  const e = { ...raw, game: shown(raw.game) };
  const tr = lang !== 'en' ? e.skill.i18n?.[lang] : undefined;
  const desc = tr?.description || e.skill.description || e.game.tagline;
  const sections = tr?.sections?.length ? tr.sections : e.skill.sections;
  return (
    <Link to={`/creator-store/${e.game.slug}`} className="skill-card">
      <div className="thumb" style={e.game.cover ? undefined : artStyle(e.game.slug)}>{e.game.cover && <img src={e.game.cover} alt="" loading="lazy" />}</div>
      <div className="skill-card-body">
        <div className="row s"><b className="clip">{e.game.title}</b>{priceTag(e.skill)}{e.skill.owned && <Badge tone="good" dot={false}>{t('Yours', '已拥有')}</Badge>}</div>
        <span className="mono fs-sm mute clip">{e.skill.name}</span>
        <p className="mute fs-sm skill-desc">{desc}</p>
        <div className="row s wrapx">{syncTag(e)}<span className="dim fs-sm">· {t('by {name}', '作者 {name}', { name: e.game.by })}</span>{sections.length > 0 && <span className="dim fs-sm">· {t('{n} sections', '{n} 个章节', { n: sections.length })}</span>}</div>
      </div>
    </Link>
  );
}

/** One game's skill. */
export function SkillPage({ slug }: { slug: string }) {
  const lang = useLang();
  const { user, toast } = useApp(), { busy, act } = useAct();
  const countedView = useRef<string | null>(null);
  const countParam = countedView.current === slug ? '&count=0' : '';
  const { data, error, loading, reload } = useData<SkillItem>(`/creator-store/${encodeURIComponent(slug)}?lang=${encodeURIComponent(lang)}${countParam}`);
  useEffect(() => { if (data && countedView.current !== slug) countedView.current = slug; }, [data, slug]);
  const [copied, setCopied] = useState(false);
  // back from checkout: confirm the payment so the skill opens without waiting for the webhook
  useEffect(() => {
    const paid = query().get('paid'); if (!paid) return;
    navigate(`/creator-store/${slug}`, true);
    if (!user) return;
    api('/billing/confirm', { body: { session_id: paid } }).then(() => { toast(t('Purchase complete. The skill is yours.', '购买成功，技能已归你所有。')); void reload(); }, (e) => toast((e as Error).message, true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <div className="wrap page"><Skeleton><SkRows n={6} /></Skeleton></div>;
  const d = data!, g = shown(d.game), s = d.skill;
  const activeLang = d.active_lang || 'en';
  const trMeta = activeLang !== 'en' ? s.i18n?.[activeLang] : undefined;
  const desc = trMeta?.description || s.description || g.tagline;
  const sections = trMeta?.sections?.length ? trMeta.sections : s.sections;
  const chars = trMeta?.characters || s.characters;
  const langs = s.languages?.length ? s.languages : ['en'];
  const counted = () => { void api(`/creator-store/${encodeURIComponent(slug)}/copied`, { method: 'POST' }).catch(() => {}); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(d.skill_md || ''); setCopied(true); setTimeout(() => setCopied(false), 1600); toast(t('Skill copied. Paste it into your agent.', '技能已复制，粘贴到你的智能体中即可。')); counted(); }
    catch { toast(t('Your browser did not allow copying. Use Download instead.', '浏览器不允许复制，请改用下载。'), true); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([d.skill_md || ''], { type: 'text/markdown' }));
    const a = document.createElement('a'); a.href = url; a.download = 'SKILL.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); counted();
  };
  const buy = () => act('buy', async () => { const r = await api<{ url: string }>(`/creator-store/${encodeURIComponent(slug)}/buy`, { method: 'POST' }); location.href = r.url; });

  return (
    <div className="wrap page">
      <Crumbs items={[{ to: '/creator-store', label: t('Creator Store', '创作者商店') }, g.title]} />
      <PageHeader eyebrow={t('Build skill', '构建技能')} title={t('Build a game like {title}', '做一款像 {title} 一样的游戏', { title: g.title })}
        sub={<>{desc} <span className="dim">· {t('by {name}', '作者 {name}', { name: g.by })}</span></>}
        badge={priceTag(s)}
        actions={!d.locked ? <><Button variant="primary" onClick={() => void copy()}>{copied ? t('Copied', '已复制') : t('Copy skill', '复制技能')}</Button><Button onClick={download}>{t('Download SKILL.md', '下载 SKILL.md')}</Button></>
          : d.buy?.sign_in ? <Button variant="primary" to={loginUrl()}>{t('Sign in to buy', '登录后购买')}</Button>
            : <Button variant="primary" onClick={buy} disabled={busy === 'buy'}>{t('Buy skill', '购买技能')} · {usd(s.price_cents)}</Button>} />
      <div className="cols">
        <div className="stack l">
          {!s.in_sync && <Notice tone="info">{t('This skill was written for version {v}; the live game is version {live}. The next release brings it up to date.', '该技能写于第 {v} 版，线上游戏是第 {live} 版。下次发布时会更新。', { v: s.version, live: g.live_version })}</Notice>}
          {s.written_by_platform && <Notice tone="info">{t('The game\'s agent has not written its skill yet, so this one was put together by the platform from facts about the build.', '游戏的智能体尚未编写技能，这份内容由平台根据构建信息整理而成。')}</Notice>}
          {!s.written_by_platform && lang !== 'en' && activeLang === 'en' && <Notice tone="info">{t('This build skill is not yet translated into your language; showing the English original.', '该构建技能尚未翻译为你当前的语言，暂显示英文原版。')}</Notice>}
          {d.locked ? (
            <Card title={t('What is inside', '内容概览')} pad>
              <div className="stack">
                <p className="mute">{t('The full skill shows after purchase. It is written in {n} sections:', '购买后可查看完整技能。共 {n} 个章节：', { n: sections.length })}</p>
                <ol className="skill-outline">{sections.map((h) => <li key={h}>{h}</li>)}</ol>
                <p className="dim fs-sm">{t('Build skills are non-refundable: the full skill shows the moment you pay. Only games can be refunded.', '构建技能不可退款：付款后立即显示完整技能。只有游戏可以退款。')}</p>
                <p className="dim fs-sm">{t('About {n} words. You keep access for good, and it updates with every release of the game.', '约 {n} 词。购买后永久可用，并随游戏每次发布更新。', { n: num(Math.round(chars / 6)) })}</p>
              </div>
            </Card>
          ) : (
            <Card pad className="skill-doc"><SkillMarkdown text={d.skill_md || ''} /></Card>
          )}
        </div>
        <div className="stack l">
          <Card pad>
            <Link to={`/g/${g.slug}`} className="skill-game">
              <div className="thumb" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" loading="lazy" />}</div>
              <div><b>{g.title}</b><div className="mute fs-sm">{g.tagline}</div></div>
            </Link>
            <KeyValue items={[
              [t('Skill', '技能'), <span className="mono">{s.name}</span>],
              [t('Matches', '对应版本'), <span className={s.in_sync ? undefined : 'sig'}>v{s.version}{s.in_sync ? ` · ${t('live', '线上')}` : ''}</span>],
              [t('Languages', '语言'), langs.map(langLabel).join(' · ')],
              [t('Updated', '更新于'), date(s.updated_at)],
              [t('Price', '价格'), s.free ? t('Free', '免费') : usd(s.price_cents)],
              [t('Used by', '使用次数'), t('{n} copies', '{n} 次复制', { n: num(s.copies) }) + (s.free ? '' : ` · ${t('{n} sold', '售出 {n}', { n: num(s.sales) })}`)],
            ]} />
            <Button block to={`/g/${g.slug}`}>{t('Play the game', '试玩游戏')}</Button>
          </Card>
          {d.yours && <Card title={t('Your skill', '你的技能')} pad>
            <StatGrid>
              <Stat label={t('Skill sales', '技能销量')} value={num(d.yours.sales)} />
              <Stat label={t('Copies', '复制次数')} value={num(d.yours.copies)} />
            </StatGrid>
            <KeyValue items={[[t('Page views', '页面浏览'), num(d.yours.views)], d.yours.creator_receives_per_sale != null && [t('You receive per sale', '每笔销售你获得'), usd(d.yours.creator_receives_per_sale), 'good']]} />
            <Button size="sm" to={`/console/p/${g.id}`}>{t('Manage in the console', '在控制台管理')}</Button>
          </Card>}
          <Card title={t('Use it with your agent', '配合你的智能体使用')} pad>
            <Steps items={[
              t('Copy the skill or download SKILL.md.', '复制技能或下载 SKILL.md。'),
              t('Save it as {path} in your agent\'s skills folder, or paste it into the conversation.', '将它保存为智能体技能文件夹中的 {path}，或直接粘贴到对话中。', { path: `${s.name}/SKILL.md` }),
              t('Ask your agent to build your own game with it. Make it yours: the platform refuses copies of other creators\' games.', '让你的智能体用它来做你自己的游戏。请做出自己的特色：平台会拒绝抄袭其他创作者的游戏。'),
            ]} />
            <Ticks items={[t('A build skill holds a game\'s practices, never its code. The platform refuses code in skills and never shares source files or assets.', '构建技能只包含游戏的实践经验，从不包含代码。平台会拒绝技能中的代码，也从不分享源文件或素材。')]} />
          </Card>
        </div>
      </div>
    </div>
  );
}
