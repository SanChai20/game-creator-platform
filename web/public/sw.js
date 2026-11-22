// HearthCade's service worker: offline start-up and push notifications. Kept small on purpose.
//
// Caching. Nothing is precached, so a deploy can never leave players on an old version: pages always come from the
// network first, and only when the network fails does the last copy of the app (or, with none, offline.html) answer.
// The app's hashed files (/assets/…) never change under their name, so they are kept and served from the cache; icons
// and splash screens are served from the cache and refreshed behind it. Fonts are left to the browser's own cache (the
// page preloads them, and a preload is not matched by an answer from a service worker). Never touched: the API, sign-in and
// payment pages, the MCP server, the SDK and kits games load (games run on their own site, which this worker does not
// control), and anything on another site.
const VERSION = 'v2';
const PAGES = 'hc-pages-' + VERSION, FILES = 'hc-files-' + VERSION;
const NEVER = /^\/(api|mcp|oauth|authorize|device|sdk|kits|vendor|guides|templates|lab|cdn-cgi)(\/|$)|^\/sw\.js$/;
const KEPT = /^\/assets\//, REFRESHED = /^\/(icons|splash)\/|^\/(favicon\.svg|manifest\.webmanifest|offline)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(FILES).then((c) => c.addAll(['/offline', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('hc-') && k !== PAGES && k !== FILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (req.mode === 'navigate') { e.respondWith(page(req)); return; }
  if (KEPT.test(url.pathname)) { e.respondWith(kept(req)); return; }
  if (REFRESHED.test(url.pathname)) e.respondWith(refreshed(e, req));
});

// A page: the network, keeping a copy of the home page (the app itself, which works out every route on its own) for
// later; offline, that copy (the app then shows what it can), else offline.html.
async function page(req) {
  try {
    const res = await fetch(req);
    if (res.ok && new URL(req.url).pathname === '/' && (res.headers.get('content-type') || '').includes('text/html')) { const c = await caches.open(PAGES); await c.put('/', res.clone()); }
    return res;
  } catch {
    return (await caches.match('/', { cacheName: PAGES })) || (await caches.match('/offline')) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}
async function kept(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { const c = await caches.open(FILES); await c.put(req, res.clone()); }
  return res;
}
async function refreshed(e, req) {
  const hit = await caches.match(req);
  const net = fetch(req).then(async (res) => { if (res.ok) { const c = await caches.open(FILES); await c.put(req, res.clone()); } return res; });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

// ---- push notifications (src/push.ts sends them) --------------------------------------------------------------------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : '' }; }
  const title = d.title || 'HearthCade';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/' },
  }));
});

// A tap opens the page the notification is about: in a window of the app already open (which handles it without a
// reload, web/src/pwa.ts), else a new one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) { try { await win.focus(); } catch { /* not allowed */ } win.postMessage({ hc: 'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});

// The push service replaced the subscription: hand the new one to the platform under the same sign-in.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const key = (await (await fetch('/api/push/key', { credentials: 'same-origin' })).json()).key;
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/')), app = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) app[i] = raw.charCodeAt(i);
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: app });
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), lang: (self.navigator.language || 'en') }) });
    } catch { /* signed out or refused: the Account page turns them on again */ }
  })());
});
