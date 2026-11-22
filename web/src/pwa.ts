// HearthCade as an installed app, in the browser: the service worker (web/public/sw.js: offline start-up, push
// notifications), turning notifications on and off on this device, and opening what a notification points at.
// The server side is src/push.ts and src/routes/push.ts; who can install and how is install.ts.
import { api, getLang, navigate, t } from './lib';
import { isIOSDevice, thisDevice } from './install';
import { openLinked } from './social';

const swOk = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext && window.top === window;

/** Registers the service worker once the page has loaded, and handles notification taps in an open window. */
export function startPwa() {
  if (!swOk()) return;
  const go = () => { void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('service worker', e)); };
  if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data as { hc?: string; url?: string } | null;
    if (d?.hc === 'open' && typeof d.url === 'string' && d.url.startsWith('/')) openUrl(d.url);
  });
  // a notification that opened a new window: its link says what to show
  const q = new URLSearchParams(location.search), friends = q.get('friends'), chat = q.get('chat');
  if (friends || chat) {
    q.delete('friends'); q.delete('chat');
    history.replaceState(history.state, '', location.pathname + (q.size ? '?' + q : '') + location.hash);
    openLinked(friends, chat);
  }
}
function openUrl(url: string) {
  const u = new URL(url, location.origin), friends = u.searchParams.get('friends'), chat = u.searchParams.get('chat');
  if (friends || chat) { openLinked(friends, chat); return; }
  navigate(u.pathname + u.search);
}

// ---- notifications on this device ------------------------------------------------------------------------------------
/**
 * Where this device stands:
 * - unsupported: the browser has no push (older browsers, in-app browsers)
 * - needs-install: iPhone and iPad, which only allow it in the Home Screen app
 * - blocked: the player said no in the browser, which only the browser's site settings undo
 * - off / on: whether this browser gets the account's notifications
 */
export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on';
export const pushSupported = () => swOk() && 'PushManager' in window && 'Notification' in window;

async function registration() { return navigator.serviceWorker.ready; }
async function current(): Promise<PushSubscription | null> {
  try { return await (await registration()).pushManager.getSubscription(); } catch { return null; }
}

export async function pushState(): Promise<{ state: PushState; off: string[] }> {
  const d = thisDevice();
  if (!pushSupported()) return { state: isIOSDevice(d) && !d.installed ? 'needs-install' : 'unsupported', off: [] };
  if (Notification.permission === 'denied') return { state: 'blocked', off: [] };
  const sub = Notification.permission === 'granted' ? await current() : null;
  const r = await api<{ subscribed: boolean; off: string[] }>('/push/state', { body: { endpoint: sub?.endpoint || null } });
  return { state: sub && r.subscribed ? 'on' : 'off', off: r.off };
}

const keyBytes = (b64: string) => {
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/')), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** Asks the browser (it must follow a tap: iOS refuses otherwise), subscribes and tells the platform. */
export async function turnPushOn(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off';
  const { key } = await api<{ key: string }>('/push/key');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with another key (keys renewed) cannot be used: start over
  if (sub && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== key) { await sub.unsubscribe(); sub = null; }
  // a browser that cannot reach its push service never answers: give up after 20 seconds and say so
  sub = sub || await Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }),
    new Promise<never>((_, no) => setTimeout(() => no(new Error(t('This browser could not reach its notification service. Try again later.', '此浏览器无法连接到它的通知服务，请稍后再试。'))), 20000)),
  ]);
  await api('/push/subscribe', { body: { subscription: sub.toJSON(), lang: getLang() } });
  return 'on';
}
export async function turnPushOff(): Promise<PushState> {
  const sub = await current();
  if (sub) { await api('/push/unsubscribe', { body: { endpoint: sub.endpoint } }); await sub.unsubscribe().catch(() => false); }
  return 'off';
}
export async function setPushKinds(off: string[]): Promise<string[]> {
  return (await api<{ off: string[] }>('/push/prefs', { method: 'PUT', body: { off } })).off;
}
export async function testPush(): Promise<boolean> {
  const sub = await current();
  return !!sub && (await api<{ sent: boolean }>('/push/test', { body: { endpoint: sub.endpoint } })).sent;
}
/** The language changed: this browser's notifications follow it. */
export async function pushLanguage() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await current();
  if (sub) await api('/push/subscribe', { body: { subscription: sub.toJSON(), lang: getLang() } }).catch(() => {});
}
