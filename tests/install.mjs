// HearthCade on iPhone and iPad (web/src/install.ts): no Safari fullscreen there, and who gets the Add to Home Screen tip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementFullscreen, isIOSDevice, isIPad, isIOSSafari, showInstallTip } from '../web/src/install.ts';

const UA = {
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1',
  iphoneInsta: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 380.0',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36',
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

test('the Add to Home Screen tip: Safari on iPhone and iPad, once, never in the installed app', () => {
  assert.equal(showInstallTip(dev('ipad'), false), true);
  assert.equal(showInstallTip(dev('iphone'), false), true);
  assert.equal(showInstallTip(dev('iphone'), true), false, 'dismissed');
  assert.equal(showInstallTip(dev('ipad', 5, true), false), false, 'installed');
  assert.equal(showInstallTip(dev('iphoneChrome'), false), false);
  assert.equal(showInstallTip(dev('iphoneInsta'), false), false);
  assert.equal(showInstallTip(dev('mac', 0), false), false);
  assert.equal(showInstallTip(dev('android'), false), false);
  assert.equal(isIOSSafari(dev('ipadOld')), true);
});
