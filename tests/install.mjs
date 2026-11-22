// HearthCade on phones and tablets (web/src/install.ts): no Safari fullscreen on iPhone and iPad, and who gets the install
// popup, with which steps, and when it comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidPromptNeeded, desktopKind, promptNeeded, elementFullscreen, installKind, isIOSDevice, isIPad, isIOSSafari, MAX_DISMISSALS, promptDue, putAway, readPromptState, SNOOZE_MS, GOT_IT_MS } from '../web/src/install.ts';

const UA = {
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1',
  iphoneInsta: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 380.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
  androidWeChat: 'Mozilla/5.0 (Linux; Android 14; V2307A Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 XWEB/1300 MMWEBSDK/20240404 MicroMessenger/8.0.49',
  iphoneWeChat: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323c) NetType/WIFI Language/zh_CN',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36 Edg/138.0',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36',
  macOldSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36',
};
const dev = (ua, touch = 5, installed = false) => ({ userAgent: UA[ua], maxTouchPoints: touch, installed });

test('an iPad that calls itself a Mac is told apart by its touch screen', () => {
  assert.equal(isIOSDevice(dev('ipad')), true);
  assert.equal(isIPad(dev('ipad')), true);
  assert.equal(isIPad(dev('ipadOld')), true);
  assert.equal(isIOSDevice(dev('mac', 0)), false);
  assert.equal(isIPad(dev('iphone')), false);
});

test('iPhone and iPad never ask Safari for element fullscreen (no swipe-down hint); other browsers do', () => {
  assert.equal(elementFullscreen(dev('ipad'), true), false);
  assert.equal(elementFullscreen(dev('ipadOld'), true), false);
  assert.equal(elementFullscreen(dev('iphone'), false), false);
  assert.equal(elementFullscreen(dev('ipad', 5, true), true), false);
  assert.equal(elementFullscreen(dev('android'), true), true);
  assert.equal(elementFullscreen(dev('mac', 0), true), true);
  assert.equal(elementFullscreen(dev('android'), false), false);
});

test('the install popup: which phones and tablets, with which steps, never in the installed app or on a computer', () => {
  assert.equal(installKind(dev('ipad')), 'ios-safari');
  assert.equal(installKind(dev('ipadOld')), 'ios-safari');
  assert.equal(installKind(dev('iphone')), 'ios-safari');
  assert.equal(installKind(dev('iphoneChrome')), 'ios-browser');
  assert.equal(installKind(dev('iphoneInsta')), 'in-app');
  assert.equal(installKind(dev('iphoneWeChat')), 'in-app');
  assert.equal(installKind(dev('androidWeChat')), 'in-app');
  assert.equal(installKind(dev('android')), 'android');
  assert.equal(installKind(dev('androidFirefox')), 'android');
  assert.equal(installKind(dev('ipad', 5, true)), null, 'installed');
  assert.equal(installKind(dev('android', 5, true)), null, 'installed');
  assert.equal(installKind(dev('mac', 0)), 'mac-safari', 'Safari on a Mac: File, Add to Dock');
  assert.equal(installKind(dev('windows', 0)), 'desktop', 'Chrome on Windows: the install prompt');
  assert.equal(installKind(dev('windows', 0, true)), null, 'installed');
  assert.equal(isIOSSafari(dev('ipadOld')), true);
  // Chrome waits for its own install prompt (none means installed already or not installable); Firefox shows the steps
  assert.equal(androidPromptNeeded(dev('android')), true);
  assert.equal(androidPromptNeeded(dev('androidFirefox')), false);
});

test('the install popup does not nag: a week after Not now, a month after Got it, gone after the third time or an install', () => {
  const now = 1_800_000_000_000;
  let st = readPromptState(null);
  assert.equal(promptDue(st, now), true);
  st = putAway(st, now, 'later');
  assert.equal(promptDue(st, now + SNOOZE_MS - 1), false);
  assert.equal(promptDue(st, now + SNOOZE_MS), true);
  st = putAway(st, now, 'got-it');
  assert.equal(promptDue(st, now + SNOOZE_MS), false);
  assert.equal(promptDue(st, now + GOT_IT_MS), true);
  for (let i = st.n; i < MAX_DISMISSALS; i++) st = putAway(st, now, 'later');
  assert.equal(promptDue(st, now + 10 * GOT_IT_MS), false, 'third time');
  assert.equal(promptDue(putAway(readPromptState(null), now, 'installed'), now), false, 'installed');
  assert.deepEqual(readPromptState(JSON.stringify(putAway(readPromptState(null), now, 'later'))), { n: 1, until: now + SNOOZE_MS, done: false });
  assert.deepEqual(readPromptState('done'), { n: 0, until: 0 }, 'the old tip key and broken values start fresh');
});

test('computers: Chrome and Edge install through their prompt, Safari on a Mac through Add to Dock, and the popup never opens by itself there', () => {
  for (const ua of ['windows', 'edge', 'macChrome', 'linuxChrome']) assert.equal(installKind(dev(ua, 0)), 'desktop', ua);
  assert.equal(installKind(dev('macOldSafari', 0)), null, 'Safari before 17 has no Add to Dock');
  assert.equal(installKind(dev('winFirefox', 0)), null, 'Firefox on a computer cannot install');
  assert.equal(promptNeeded('desktop', dev('windows', 0)), true);
  assert.equal(promptNeeded('mac-safari', dev('mac', 0)), false);
  assert.equal(promptNeeded('android', dev('androidFirefox')), false);
  assert.equal(desktopKind('desktop'), true);
  assert.equal(desktopKind('mac-safari'), true);
  assert.equal(desktopKind('android'), false);
  assert.equal(desktopKind(null), false);
});
