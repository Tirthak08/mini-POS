/**
 * AUDIT 4 — settings, language, and the lock on the door.
 *
 * Everything here is either rarely used or used once and then relied on
 * forever, which is exactly the combination that hides bugs. A language switch
 * that changes a label but not the screen, a PIN change that reports success
 * without taking effect, a sign-out that leaves the token behind -- none of
 * these would be noticed during a day's selling, and all of them matter the
 * morning somebody needs them.
 *
 * The PIN section deliberately ends by signing out and back in with the NEW
 * pin, and by proving the OLD one no longer works. A "PIN updated" toast is not
 * evidence that the lock changed.
 *
 * Needs the API on :5000 and `npx expo export --platform web` served on :8099.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';

const req = async (p, body, t, m = 'POST') => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
    ...(body && m !== 'GET' && { body: JSON.stringify(body) }),
  });
  return { status: r.status, ...(await r.json()) };
};
const get = (p, t) => req(p, null, t, 'GET');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 320) : ''}`));
};

/* ---------------------------- a shop to fiddle with ---------------------------- */
const shop = 'Audit4 ' + crypto.randomBytes(3).toString('hex');
const PIN = '1234';
const NEW_PIN = '987654';
const token = (await req('/auth/register', { businessName: shop, pin: PIN })).token;
const cat = (await req('/categories', { name: 'Grain' }, token)).category;
const rice = (await req('/products', { name: 'Rice', categoryId: cat._id, price: 100, cost: 60, stock: 50 }, token)).product;
await req('/orders', { items: [{ productId: rice._id, qty: 2 }] }, token);

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.evaluate(() => document.body.innerText);
const tap = async (name, { exact = true } = {}) =>
  page.getByRole('button', { name, exact }).last().click();
const tapTab = async (name) =>
  page.locator('[role="tab"]').filter({ hasText: name }).last().click();

const waitForText = async (re, ms = 12000) => {
  const until = Date.now() + ms;
  let seen = '';
  while (Date.now() < until) {
    seen = await body();
    if (re.test(seen)) return { ok: true, seen };
    await page.waitForTimeout(200);
  }
  return { ok: false, seen };
};

const signIn = async (name, pin) => {
  await page.locator('[placeholder="Sharma Kirana"]').first().fill(name);
  await page.locator('[placeholder="••••"]').first().fill(pin);
  await tap('Sign in');
};

const openSettings = async () => {
  await page.getByRole('button', { name: /Settings|^Audit4 /, exact: false }).first().click();
  await page.waitForTimeout(2200);
};

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await signIn(shop, PIN);
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  /* ==================== 1. the settings screen itself ==================== */
  console.log('\n=== what settings actually knows about the shop ===');
  await openSettings();
  let text = await body();
  check('settings opens', /Settings/.test(text), text.slice(0, 400));
  check('  and names the shop', text.includes(shop), text.slice(0, 500));
  check('  says when it was opened', /Since /.test(text), text.slice(0, 700));
  /* The counts are quoted by a shopkeeper when something has gone wrong, so
     they have to be the server's, not a stale local guess. */
  const counts = (await get('/auth/me', token)).counts ?? {};
  check(`  counts ${counts.products} products, from the server`,
    new RegExp(`Products\\s*\\n?\\s*${counts.products}\\b`).test(text), { counts, text: text.slice(0, 1200) });
  /* The row is labelled "Sales", not "Orders" -- this screen speaks the
     shopkeeper's word for it. */
  check(`  and ${counts.orders} sales`,
    new RegExp(`Sales\\s*\\n?\\s*${counts.orders}\\b`).test(text), { counts, text: text.slice(0, 1200) });
  check('  a backup has never been taken', /Never/i.test(text), text.slice(0, 1200));
  check('  and it offers a way out', /Log out/.test(text), text.slice(0, 1200));

  /* ==================== 2. renaming the shop ==================== */
  console.log('\n=== renaming the shop ===');
  await tap('Business information', { exact: false });
  await page.waitForTimeout(1800);
  text = await body();
  check('the shop details screen opens', /Shop name/.test(text), text.slice(0, 600));

  const nameBox = page.getByLabel('Shop name', { exact: false }).last();
  const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).last();

  /* A shop with no name cannot be signed into, so Save is not merely rejected
     on submit -- it is unavailable until there is something to save. */
  await nameBox.fill('   ');
  await page.waitForTimeout(500);
  check('a blank name cannot even be submitted', await saveBtn.isDisabled(), await saveBtn.isDisabled());
  check('  and nothing reached the server', (await get('/auth/me', token)).business.name === shop);

  const renamed = shop + ' Stores';
  await nameBox.fill(renamed);
  await page.waitForTimeout(500);
  await saveBtn.click();
  await page.waitForTimeout(2800);
  const after = (await get('/auth/me', token)).business.name;
  check('the new name is saved on the server', after === renamed, after);
  /* Saving returns to Settings on its own -- the job had a beginning and an
     end, so the screen closes behind it. */
  text = await body();
  check('  and the screen goes back to settings, showing it',
    /Settings/.test(text) && text.includes(renamed), text.slice(0, 500));

  /* ==================== 3. language ==================== */
  console.log('\n=== switching language actually switches the app ===');
  await tap('Language', { exact: false });
  await page.waitForTimeout(1600);
  text = await body();
  check('all three languages are offered, each in its own script',
    /English/.test(text) && /हिन्दी/.test(text) && /ગુજરાતી/.test(text), text.slice(0, 600));

  /**
   * react-native-web drops `accessibilityState` from a Pressable, so a radio
   * that reports its selection only that way tells a screen reader nothing.
   * `aria-checked` is what actually reaches the DOM.
   */
  const checkedAttr = async () => page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="radio"]'))
      .map((n) => [n.innerText.split('\n')[0], n.getAttribute('aria-checked')]));
  let radios = await checkedAttr();
  check('the current language is announced as selected',
    radios.some(([, c]) => c === 'true'), radios);

  await page.getByRole('radio', { name: 'हिन्दी', exact: false }).last().click();
  await page.waitForTimeout(1800);
  text = await body();
  /* The screen you are standing on is the proof: its own title, the hint under
     the list -- not just the row you tapped, which was already in Hindi. */
  check('picking Hindi translates the screen, not just the row',
    /भाषा/.test(text) && /पूरे ऐप में/.test(text), text.slice(0, 600));
  radios = await checkedAttr();
  check('  and Hindi is now the announced selection',
    radios.some(([l, c]) => /हिन्दी/.test(l) && c === 'true'), radios);

  await page.getByRole('radio', { name: 'ગુજરાતી', exact: false }).last().click();
  await page.waitForTimeout(1600);
  const guText = await body();
  check('Gujarati too', /ભાષા/.test(guText) && /આખી એપમાં/.test(guText), guText.slice(0, 400));

  /* The choice is persisted, not just held in memory: an operator who cannot
     read English must not have to find this screen again after every restart. */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5200);
  const afterReload = await body();
  check('the choice survives a restart',
    /વેચાણ કાઉન્ટર/.test(afterReload), afterReload.slice(0, 400));

  await openSettings();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /ભાષા|भाषा|Language/, exact: false }).last().click();
  await page.waitForTimeout(1600);
  await page.getByRole('radio', { name: 'English', exact: false }).last().click();
  await page.waitForTimeout(1600);
  const enText = await body();
  check('and back to English',
    /Language/.test(enText) && /Applies to the whole app/.test(enText), enText.slice(0, 400));
  await tap('Back');
  await page.waitForTimeout(1600);
  check('  which leaves the rest of the app in English too',
    /Settings/.test(await body()), (await body()).slice(0, 400));

  /* ==================== 4. changing the PIN ==================== */
  console.log('\n=== the lock on the door ===');
  await tap('Security & login', { exact: false });
  await page.waitForTimeout(1800);
  text = await body();
  check('the security screen opens', /Change PIN/.test(text), text.slice(0, 600));

  const cur = page.getByLabel('Current PIN', { exact: false }).last();
  const nw = page.getByLabel('New PIN', { exact: false }).last();
  const conf = page.getByLabel('Confirm PIN', { exact: false }).last();

  const changeBtn = page.getByRole('button', { name: 'Change PIN', exact: true }).last();
  check('the button starts out disabled', await changeBtn.isDisabled(), await changeBtn.isDisabled());

  await cur.fill(PIN);
  await nw.fill(NEW_PIN);
  await conf.fill('999999');
  await page.waitForTimeout(700);
  text = await body();
  check('two different PINs are called out', /do not match/i.test(text), text.slice(0, 700));
  check('  and the button stays disabled', await changeBtn.isDisabled(), await changeBtn.isDisabled());

  // Re-using the current PIN is refused before it ever reaches the server.
  await nw.fill(PIN);
  await conf.fill(PIN);
  await page.waitForTimeout(500);
  await changeBtn.click();
  await page.waitForTimeout(1400);
  check('the same PIN again is refused', /same as the old one/i.test(await body()), (await body()).slice(0, 700));

  /**
   * A wrong current PIN must NOT sign the shop out. The API client treats any
   * 401 as an expired session, so the server answers this one with a 400 on
   * purpose; if that ever regressed, one mistyped digit would throw the
   * operator back to the login screen mid-shift.
   */
  await cur.fill('1111');
  await nw.fill(NEW_PIN);
  await conf.fill(NEW_PIN);
  await page.waitForTimeout(500);
  await changeBtn.click();
  await page.waitForTimeout(2200);
  text = await body();
  check('a wrong current PIN says so', /not your current PIN/i.test(text), text.slice(0, 700));
  check('  and does NOT sign the shop out', !/Sign in/.test(text) && /Change PIN/.test(text), text.slice(0, 700));

  await cur.fill(PIN);
  await page.waitForTimeout(400);
  await changeBtn.click();
  const changed = await waitForText(/PIN updated/, 15000);
  check('the right current PIN changes it', changed.ok, changed.seen.slice(0, 500));

  /* ==================== 5. sign out, and the new lock ==================== */
  console.log('\n=== signing out, and proving the new PIN is the real one ===');
  await page.waitForTimeout(2200);
  await tap('Log out', { exact: false });
  await page.waitForTimeout(1500);
  text = await body();
  check('signing out asks first', /sign back in/i.test(text), text.slice(0, 700));
  await tap('Cancel');
  await page.waitForTimeout(1500);
  check('  backing out stays signed in', /Settings/.test(await body()), (await body()).slice(0, 400));

  await tap('Log out', { exact: false });
  await page.waitForTimeout(1400);
  await tap('Log out', { exact: false });
  const out = await waitForText(/Sign in/, 15000);
  check('confirming signs out', out.ok, out.seen.slice(0, 400));

  await page.waitForTimeout(1500);
  await signIn(renamed, PIN);
  await page.waitForTimeout(3200);
  text = await body();
  check('the OLD pin no longer works',
    !/Point of Sale/.test(text), text.slice(0, 500));
  check('  and says why, without saying which half was wrong',
    /Incorrect name or PIN/i.test(text), text.slice(0, 600));

  await page.locator('[placeholder="••••"]').first().fill(NEW_PIN);
  await tap('Sign in');
  const back = await waitForText(/Point of Sale/, 15000);
  check('the NEW pin does', back.ok, back.seen.slice(0, 400));

  /* ============ 6. controls that are on say that they are on ============ */
  console.log('\n=== a control that is switched on says so ===');
  /**
   * react-native-web drops `accessibilityState` from a Pressable, so every
   * toggle in this app that reported its state only that way was, to a screen
   * reader, a button with no indication of whether it was doing anything. The
   * `aria-` mirror is what actually reaches the DOM, so that is what is checked.
   */
  const ariaOf = (sel) => page.evaluate((s) => Array.from(document.querySelectorAll(s))
    .filter((n) => n.offsetParent !== null)
    .map((n) => [ (n.getAttribute('aria-label') || n.innerText || '').split('\n')[0].slice(0, 24),
      n.getAttribute('aria-selected'), n.getAttribute('aria-pressed') ]), sel);

  await tapTab('Stock');
  await page.waitForTimeout(2600);
  let states = await ariaOf('[role="button"]');
  check('the Products / Categories segment says which half you are on',
    states.some(([l, sel]) => /Products/i.test(l) && sel === 'true')
    && states.some(([l, sel]) => /Categories/i.test(l) && sel === 'false'), states.slice(0, 12));
  check('  and the low-stock filter says it is off',
    states.some(([, , pressed]) => pressed === 'false'), states.slice(0, 14));

  await tapTab('Reports');
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Period', exact: false }).last().click();
  await page.waitForTimeout(1300);
  states = await ariaOf('[role="button"]');
  /* Matched on the period options BY NAME. Counting "any control with
     aria-selected=true" passed even when the period list had none, because the
     Stock segment is still mounted behind this screen and had one. */
  const periodStates = states.filter(([l]) =>
    /^(Today|Yesterday|This week|Last week|This month|Last month|This year|Last year|All time)$/.test(l));
  check('every period is offered', periodStates.length >= 8, periodStates);
  check('  and the list marks the one you are in',
    periodStates.filter(([, sel]) => sel === 'true').length === 1, periodStates);
  await tap('Today');
  await page.waitForTimeout(2200);

  /* ==================== 7. nothing was lost in the process ==================== */
  console.log('\n=== the shop is still the same shop ===');
  await tapTab('Stock');
  await page.waitForTimeout(2600);
  check('the stock is still there', /Rice/.test(await body()), (await body()).slice(0, 600));
  await tapTab('Sales');
  await page.waitForTimeout(2600);
  check('  and so is the sale made before the PIN changed',
    /INV-/.test(await body()), (await body()).slice(0, 600));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
