/**
 * Cold start: an already-signed-in shop must never see the sign-in screen.
 *
 * The session and the chosen language both live in AsyncStorage, which is
 * asynchronous. The navigator decides purely on `token`, so for the first few
 * frames of every launch `token` is null and it renders the SIGN-IN screen --
 * then hydration lands and the POS replaces it. A shopkeeper opening the app
 * sees the login screen flash past, and a Gujarati shop sees a flash of
 * English. Holding the splash until the stores have rehydrated closes that
 * window.
 *
 * SCOPE, honestly: the flash itself is NOT verifiable here. On web AsyncStorage
 * is backed by synchronous localStorage, so hydration finishes before the first
 * paint and the symptom cannot occur -- proved by disabling the fix and watching
 * this suite pass unchanged. The frame-by-frame assertion below is kept because
 * it would catch a REGRESSION that broke startup on web (a splash that never
 * lifts, a navigator that lands on the wrong screen), but the flash logic itself
 * is covered by tests/hydration-gate-test.mjs, which can actually fail.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';
const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m, headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && { body: JSON.stringify(body) }),
})).json();

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`));
};

const shop = 'Boot ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const cat = (await req('/categories', { name: 'Rings' }, token)).category;
await req('/products', { name: 'Gold Ring', categoryId: cat._id, price: 500, cost: 300, stock: 5 }, token);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.evaluate(() => document.body.innerText);

/**
 * Sample every 60ms so a brief flash cannot hide between checks.
 *
 * `authMounted` is a DOM probe, not a text match: the sign-in screen is
 * identified by its shop-name placeholder, and a placeholder lives in an
 * ATTRIBUTE that innerText never contains. Matching on text would have made
 * this assertion pass whether or not the flash was there -- a test with no
 * teeth, which is how the bug survived in the first place. The placeholder is
 * also a hardcoded literal rather than a translated string, so the probe works
 * in every language.
 */
const sample = async (ms) => {
  const frames = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    frames.push(await page.evaluate(() => ({
      text: document.body.innerText,
      authMounted: !!document.querySelector('[placeholder="Sharma Kirana"]'),
    })).catch(() => ({ text: '', authMounted: false })));
    await page.waitForTimeout(60);
  }
  return frames;
};

/* ---------------------- sign in, then switch language ---------------------- */
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
await page.waitForTimeout(3600);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 140));

/**
 * Pick Gujarati so the language flash is observable too.
 *
 * The switcher lives in Settings now, not the header, so this is three taps:
 * the shop-name chip, the Language row, then the radio. The chip is addressed
 * by the shop name because "Settings" itself is translated. Two Back taps
 * return to the POS -- in Gujarati by then, hence the translated label.
 */
await page.getByRole('button', { name: new RegExp(shop) }).last().click();
await page.waitForTimeout(1400);
await page.getByRole('button', { name: /^Language/ }).last().click();
await page.waitForTimeout(1200);
await page.getByRole('radio', { name: 'ગુજરાતી', exact: true }).last().click();
await page.waitForTimeout(1500);
for (let i = 0; i < 2; i += 1) {
  await page.getByRole('button', { name: 'પાછા', exact: true }).last().click();
  await page.waitForTimeout(1100);
}
const gujaratiTitle = 'વેચાણ કાઉન્ટર';
check('switched to Gujarati', (await body()).includes(gujaratiTitle), (await body()).slice(0, 140));

const stored = await page.evaluate(() => ({
  auth: !!localStorage.getItem('minipos-auth'),
  settings: !!localStorage.getItem('minipos-settings'),
}));
check('session and language were persisted', stored.auth && stored.settings, stored);

/* ============ the cold start: watch every frame from load ============ */
console.log('\n=== reload, sampling every frame from the first paint ===');
await page.reload({ waitUntil: 'domcontentloaded' });
const frames = await sample(6000);
const painted = frames.filter((f) => f.text.trim().length > 0 || f.authMounted);

check('the app did reach a signed-in state', frames.some((f) => f.text.includes(gujaratiTitle)),
  { frames: frames.length, painted: painted.length });

// NOTE: on web this cannot fail (see the scope note above) -- it stands guard
// against a web-side startup regression, not as evidence about the flash.
const loginFrames = frames.filter((f) => f.authMounted);
check('startup lands signed in and never on the sign-in screen [web-only guard]',
  loginFrames.length === 0, { mountedInFrames: loginFrames.length, of: frames.length });

// English would only show if the UI painted before the language rehydrated.
const englishFrames = frames.filter((f) => /Point of Sale/.test(f.text));
check('the restored language is Gujarati throughout [web-only guard]',
  englishFrames.length === 0, { flashedInFrames: englishFrames.length });

check('the splash always lifts -- the app never stays blank',
  frames.slice(-8).some((f) => f.text.trim().length > 0),
  'a splash that never hides would leave every late frame empty');

/* ================= the failsafe: storage that never answers ================= */
console.log('\n=== a broken storage read must not strand the app on the splash ===');
const stuck = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p2 = await stuck.newPage();
// Make every persisted read hang. `useAppReady` bounds its wait at 3s and then
// gives up, so the app must still become usable -- an app stuck forever on a
// logo is far worse than a flash of the login screen.
await p2.addInitScript(() => {
  const real = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) {
    if (String(k).startsWith('minipos-')) return null;
    return real.call(this, k);
  };
});
await p2.goto(APP, { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(7000);
const stuckState = await p2.evaluate(() => ({
  text: document.body.innerText,
  authMounted: !!document.querySelector('[placeholder="Sharma Kirana"]'),
}));
check('the app still becomes usable within the failsafe window',
  stuckState.text.trim().length > 0, stuckState.text.slice(0, 160));
check('and lands on the sign-in screen, since there was no session to restore',
  stuckState.authMounted, stuckState.text.slice(0, 200));
await p2.screenshot({ path: '/tmp/startup-failsafe.png' });

console.log(`\n${pass} passed, ${fail} failed | page errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log('  -', e.slice(0, 160)));
await browser.close();
process.exit(fail ? 1 : 0);
