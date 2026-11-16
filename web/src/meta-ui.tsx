// The store page's game metadata: the At a glance panel (genre, tags, age rating, players, session, progress, accessibility),
// the Languages table and the "in your language" check. The rules live in web/src/gamemeta.ts and web/src/languages.ts.
import type { ReactNode } from 'react';
import type { Access, Content, Mode, Players, Progress } from './gamemeta';
import { genresOf, sessionBucket } from './gamemeta';
import { tagsOnly } from './tags';
import { inYourLanguage, languageName, languageRows, type Languages } from './languages';
import { genreName, getLang, LANGS, Link, t, type Lang } from './lib';

/** What the game page receives about the live version's build (see GET /api/games/:slug). */
export interface GameMeta {
  players: Players | null; session_minutes: number | null; progress: Progress; accessibility: Access[] | null; content: Content | null;
  rating: { age: number; reasons: string[] } | null; languages: Languages; languages_declared: boolean; declared: string[]; multiplayer: boolean;
}

const platformName = (l: Lang) => LANGS.find((x) => x.code === l)!.name;
const modeName = (m: Mode | string) => ({ single: t('Single player', '单人'), 'coop-local': t('Co-op on one device', '同屏合作'), 'coop-online': t('Online co-op', '在线合作'), 'pvp-local': t('Versus on one device', '同屏对战'), 'pvp-online': t('Online versus', '在线对战') } as Record<string, string>)[m] ?? m;
const accessName = (a: Access | string) => ({
  'remappable-controls': t('Remappable controls', '可自定义按键'), 'colorblind-modes': t('Colour-blind modes', '色盲模式'), 'subtitles': t('Subtitles', '字幕'),
  'adjustable-difficulty': t('Adjustable difficulty', '可调难度'), 'reduced-motion': t('Reduced motion', '减少动态效果'), 'scalable-text': t('Scalable text', '可调文字大小'),
  'one-handed': t('Playable with one hand', '单手可玩'), 'pause-anytime': t('Pause any time', '随时暂停'), 'no-time-pressure': t('No time pressure', '无时间压力'), 'visual-sound-cues': t('Visual cues for sounds', '声音的视觉提示'),
} as Record<string, string>)[a] ?? a;
const reasonName = (r: string) => ({
  'violence:cartoon': t('Cartoon violence', '卡通暴力'), 'violence:fantasy': t('Fantasy violence', '奇幻暴力'), 'violence:realistic': t('Realistic violence', '写实暴力'), 'violence:graphic': t('Graphic violence', '血腥暴力'), 'blood': t('Blood', '血腥'),
  'language:mild': t('Mild language', '轻度粗口'), 'language:strong': t('Strong language', '强烈粗口'), 'fear:mild': t('Mildly scary', '轻度惊吓'), 'fear:intense': t('Intense horror', '强烈恐怖'),
  'sexual:suggestive': t('Suggestive themes', '性暗示'), 'sexual:nudity': t('Nudity', '裸露'), 'sexual:explicit': t('Explicit sexual content', '露骨性内容'), 'adult_themes': t('Mature themes', '成人主题'), 'drugs': t('Drug references', '涉及药物'), 'gambling:simulated': t('Simulated gambling', '模拟赌博'),
} as Record<string, string>)[r] ?? r;
const sessionName = (m: number) => ({ '<5': t('Under 5 min', '5 分钟以内'), '5-15': t('5 to 15 min', '5 到 15 分钟'), '15-30': t('15 to 30 min', '15 到 30 分钟'), '30-60': t('30 to 60 min', '30 到 60 分钟'), '60+': t('Over an hour', '1 小时以上') } as Record<string, string>)[sessionBucket(m)];
const notStated = () => <span className="dim">{t('Not stated', '未注明')}</span>;

export const ageLabel = (age: number) => (age >= 18 ? t('Adults only', '仅限成人') : age <= 3 ? t('Everyone', '所有人') : t('Ages {n} and up', '{n} 岁及以上', { n: age }));
export function AgeBadge({ age, sm }: { age: number; sm?: boolean }) {
  return <span className={`age a${age}` + (sm ? ' sm' : '')} title={ageLabel(age)}>{age}+</span>;
}
export const playersText = (p: Players) => p.min === p.max ? (p.max === 1 ? t('1 player', '1 名玩家') : t('{n} players', '{n} 名玩家', { n: p.max })) : t('{min} to {max} players', '{min} 到 {max} 名玩家', { min: p.min, max: p.max });

/** Whether the game can be played in the viewer's platform language. */
export function LangPill({ l }: { l: Languages }) {
  const lang = getLang(), fit = inYourLanguage(l, lang), name = platformName(lang);
  const other = l.supported.filter((g) => g.interface).slice(0, 2).map((g) => languageName(g.code)[1]).join(' · ');
  if (fit.ok) return <span className="cpill c-ok"><i aria-hidden="true">✓</i>{l.follows_platform ? t('Opens in {lang}', '以{lang}打开', { lang: name }) : t('Playable in {lang}', '支持{lang}', { lang: name })}</span>;
  if (fit.partial) return <span className="cpill c-maybe"><i aria-hidden="true">!</i>{t('Only voice or subtitles in {lang}', '{lang}仅有语音或字幕', { lang: name })}</span>;
  return <span className="cpill c-maybe"><i aria-hidden="true">!</i>{t('Not in {lang}', '不支持{lang}', { lang: name })}<span className="cpill-why"> · {other}</span></span>;
}

/** The At a glance panel: what kind of game this is, for whom, and how it plays. */
export function Glance({ meta, tags }: { meta: GameMeta; tags: string[] }) {
  const m = meta, items: [string, ReactNode, string][] = [];
  const g = genresOf(tags), genres: string[] = g.primary ? [g.primary, ...g.secondary] : [], rest = tagsOnly(tags);
  items.push([t('Genre', '类型'), genres.length ? <span className="glance-genres">{genres.map((x, i) => <Link key={x} to={`/c/${encodeURIComponent(x)}`} className={i ? 'dim' : ''}>{genreName(x)}</Link>)}</span> : notStated(), 'genre']);
  if (rest.length) items.push([t('Tags', '标签'), <span className="glance-chips">{rest.map((x) => <Link key={x} to={`/c/${encodeURIComponent(x)}`}><i>{genreName(x)}</i></Link>)}</span>, 'tags']);
  items.push([t('Age rating', '年龄分级'), m.rating ? <span className="glance-age"><AgeBadge age={m.rating.age} /><span><b>{ageLabel(m.rating.age)}</b>{m.rating.reasons.length ? <small>{m.rating.reasons.map(reasonName).join(' · ')}</small> : <small>{t('No content of concern', '无需注意的内容')}</small>}</span></span> : notStated(), 'age']);
  items.push([t('Players', '玩家'), m.players ? <span><b>{playersText(m.players)}</b><small>{m.players.modes.map(modeName).join(' · ')}</small></span> : m.multiplayer ? <span><b>{t('Multiplayer', '多人')}</b><small>{t('Online rooms', '在线房间')}</small></span> : notStated(), 'players']);
  items.push([t('Session', '单局时长'), m.session_minutes ? <b>{sessionName(m.session_minutes)}</b> : notStated(), 'session']);
  items.push([t('Progress', '进度'), <span className="glance-chips">{m.progress.cloud_saves && <i>{t('Cloud saves', '云存档')}</i>}{m.progress.leaderboards && <i>{t('Leaderboards', '排行榜')}</i>}{m.progress.offline && <i>{t('Plays offline once loaded', '加载后可离线游玩')}</i>}{!m.progress.cloud_saves && !m.progress.leaderboards && !m.progress.offline && <span className="dim">{t('Nothing kept between sessions', '不保留进度')}</span>}</span>, 'progress']);
  items.push([t('Accessibility', '无障碍'), m.accessibility ? (m.accessibility.length ? <span className="glance-chips">{m.accessibility.map((a) => <i key={a}>{accessName(a)}</i>)}</span> : <span className="dim">{t('No specific features', '暂无专门功能')}</span>) : notStated(), 'access']);
  const warn = m.content?.flashing_lights, chat = m.content?.player_chat;
  return (
    <section className="stack l glance" id="at-a-glance">
      <h2 className="compat-title">{t('At a glance', '速览')}</h2>
      {warn && <p className="glance-warn" role="note"><b>⚠ {t('Photosensitivity warning', '光敏性癫痫警告')}</b> {t('This game has flashing lights or patterns.', '本游戏含有闪烁的光线或图案。')}</p>}
      <dl className="glance-grid">{items.map(([k, v, id]) => <div key={id} className={'g-' + id}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {chat && <p className="dim fs-sm">{t('Players can send each other messages in this game.', '玩家可以在游戏中互相发送消息。')}</p>}
    </section>
  );
}

/** The Languages table: interface, voice and subtitles per language, and whether this store page is translated into it. */
export function LanguagesSection({ l, declared, listings }: { l: Languages; declared: boolean; listings: Lang[] }) {
  const lang = getLang(), rows = languageRows(l, listings), mark = (on: boolean) => <span className={on ? 'lmark on' : 'lmark'} aria-label={on ? t('Yes', '是') : t('No', '否')}>{on ? '✓' : '—'}</span>;
  return (
    <section className="stack l langs" id="languages">
      <div className="compat-head"><h2 className="compat-title">{t('Languages', '语言')}</h2><LangPill l={l} /></div>
      <div className="tbl-wrap"><table className="tbl ltbl">
        <thead><tr><th>{t('Language', '语言')}</th><th>{t('Interface', '界面')}</th><th>{t('Voice', '语音')}</th><th>{t('Subtitles', '字幕')}</th><th>{t('Store page', '商店页面')}</th></tr></thead>
        <tbody>{rows.map((r) => { const [en, native] = languageName(r.code); return (
          <tr key={r.code} className={r.platform === lang ? 'you' : ''}>
            <td><b>{native}</b>{native !== en && <span className="dim"> · {en}</span>}{r.isDefault && <span className="ltag">{t('Default', '默认')}</span>}{r.platform === lang && <span className="ltag you">{t('Your language', '你的语言')}</span>}</td>
            <td>{mark(r.interface)}</td><td>{mark(r.audio)}</td><td>{mark(r.subtitles)}</td><td>{mark(r.store || r.isDefault)}</td>
          </tr>
        ); })}</tbody>
      </table></div>
      {l.follows_platform && <p className="mute fs-sm">{t('The game opens in your platform language when it has it. Change it from the language menu at the top of the page.', '若游戏支持你的平台语言，将以该语言打开。可在页面顶部的语言菜单中更改。')}</p>}
      {l.notes && <p className="compat-notes"><span className="eyebrow">{t('From the creator', '来自作者')}</span> {l.notes}</p>}
      <p className="dim fs-sm">{declared ? t('Languages listed by the creator.', '语言由作者列出。') : t('Languages detected by the platform from the game\'s files; the creator has not listed them yet.', '语言由平台根据游戏文件检测得出，作者尚未列出。')}</p>
    </section>
  );
}
