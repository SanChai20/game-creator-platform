// The site's three areas, kept apart so every kind of user knows where they are: Play (the store and everything a player
// uses), Create (the creator console, the Creator Store and the docs, for developers) and Admin (running the platform).
// Each area has its own colour (play: the accent, create: --info, admin: --warn), set on <html data-area> so the header's
// edge, the area switch and the area bar all show it. The header carries the area switch; under it, Create and Admin show
// their own bar of pages, as the store shows its bar of shelves.
import { useEffect } from 'react';
import { Link, t, useLocation, type Me } from './lib';
import { Icon } from './ui/icons';
import './areas.css';

export type Area = 'play' | 'create' | 'admin';

const CREATE = /^\/(console|create|creator-store|docs|team|license|workbench)(\/|$)/;
/** Which area a page belongs to. Account settings and sign-in stay with the player side, where every account starts. */
export function areaOf(path: string): Area {
  if (/^\/(admin|claim-admin)(\/|$)/.test(path)) return 'admin';
  if (CREATE.test(path)) return 'create';
  return 'play';
}

/** Keeps <html data-area> in step with the page. */
export function useArea(path: string): Area {
  const area = areaOf(path);
  useEffect(() => { document.documentElement.dataset.area = area; }, [area]);
  return area;
}

/** Where each area opens: a creator lands in the console, anyone else on the page about creating. */
export const areaHome = (a: Area, user: Me | null) => (a === 'admin' ? '/admin' : a === 'create' ? (user?.makes_games ? '/console' : '/create') : '/');
export const areaName = (a: Area) => (a === 'admin' ? t('Admin', '管理') : a === 'create' ? t('Create', '创作') : t('Play', '游玩'));
const areaWho = (a: Area) => (a === 'admin' ? t('Running the platform', '平台管理') : a === 'create' ? t('For developers', '面向开发者') : t('For players', '面向玩家'));

/** The switch in the header: Play, Create, and Admin for admins. The current area is filled with its colour. */
export function AreaSwitch({ area, user }: { area: Area; user: Me | null }) {
  const areas: Area[] = ['play', 'create', ...(user?.role === 'admin' ? ['admin' as Area] : [])];
  return (
    <nav className="area-sw" aria-label={t('Areas', '区域')}>
      {areas.map((a) => (
        <Link key={a} to={areaHome(a, user)} className={'area-sw-a is-' + a + (a === area ? ' on' : '')} aria-current={a === area ? 'true' : undefined} title={areaWho(a)}>
          <Icon kind={a === 'admin' ? 'shield' : a === 'create' ? 'wand' : 'pad'} />{areaName(a)}
        </Link>
      ))}
    </nav>
  );
}

type Place = { to: string; label: string; on: boolean };

/** The pages of the Create area, as the bar under the header lists them. */
function createPlaces(path: string, user: Me | null): Place[] {
  const maker = !!user?.makes_games;
  return [
    ...(maker ? [
      { to: '/console', label: t('Your games', '我的游戏'), on: path === '/console' || path.startsWith('/console/p') || path.startsWith('/console/projects') },
      { to: '/console/workbench', label: t('Workbench', '工作台'), on: path === '/console/workbench' },
      { to: '/console/earnings', label: t('Earnings', '收益'), on: path === '/console/earnings' },
    ] : [{ to: '/create', label: t('Start creating', '开始创作'), on: path === '/create' }]),
    ...(user ? [{ to: '/team', label: t('Team projects', '团队项目'), on: path === '/team' || path.startsWith('/team/') }] : []),
    { to: '/creator-store', label: t('Creator Store', '创作者商店'), on: path.startsWith('/creator-store') },
    { to: '/docs', label: t('Docs', '文档'), on: path.startsWith('/docs') },
    ...(maker ? [{ to: '/create', label: t('About creating', '关于创作'), on: path === '/create' }] : []),
    ...(user ? [{ to: '/license', label: t('Creator license', '创作者许可证'), on: path === '/license' }] : []),
  ];
}

/** The pages of the Admin area (the tabs of src/pages/Admin.tsx). */
export const adminTabs = (): [string, string][] => [['overview', t('Overview', '概览')], ['settings', t('Settings', '参数设置')], ['users', t('Users', '用户')], ['games', t('Games', '游戏')], ['money', t('Money', '资金')], ['reports', t('Reports', '举报')]];
function adminPlaces(path: string): Place[] {
  const tab = path.match(/^\/admin\/([a-z]+)/)?.[1] || 'overview';
  return adminTabs().map(([k, label]) => ({ to: k === 'overview' ? '/admin' : `/admin/${k}`, label, on: path.startsWith('/admin') && tab === k }));
}

/** The bar under the header in the Create and Admin areas: the area's name, who it is for, and its pages. */
export function AreaBar({ area, user }: { area: Area; user: Me | null }) {
  const path = useLocation().split('?')[0];
  if (area === 'play') return null;
  const places = area === 'admin' ? adminPlaces(path) : createPlaces(path, user);
  return (
    <div className={'abar is-' + area}>
      <div className="wrap abar-in">
        <span className="abar-tag"><b>{areaName(area)}</b><small>{areaWho(area)}</small></span>
        <nav className="abar-links" aria-label={area === 'admin' ? t('Admin pages', '管理页面') : t('Creator pages', '创作者页面')}>
          {places.map((p) => <Link key={p.to + p.label} to={p.to} className={'abar-a' + (p.on ? ' on' : '')} aria-current={p.on ? 'page' : undefined}>{p.label}</Link>)}
        </nav>
      </div>
    </div>
  );
}
