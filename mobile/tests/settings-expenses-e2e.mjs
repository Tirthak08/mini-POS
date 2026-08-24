/**
 * End-to-end walk of the three things this change added, driven through a real
 * browser against a real API:
 *
 *   1. the add/edit forms are CENTRED dialogs, not bottom sheets;
 *   2. the header's shop-name chip opens Settings, and Settings can rename the
 *      shop, change the language and change the PIN;
 *   3. an expense recorded in the Sales tab lands in the report as a deduction,
 *      turning gross profit into a net figure the shopkeeper can trust.
 *
 * SCOPE, honestly: this proves geometry and wiring on WEB. It cannot speak for
 * Android text metrics (Gujarati measures narrower than it draws) or for native
 * modal animation. Those are checked on the phone.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';
const SHOT = '/tmp/shots';

const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && { body: JSON.stringify(body) }),
})).json();

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 400) : ''}`));
};

/* ------------------------- a shop with real numbers ------------------------- */
const shop = 'Set ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const cat = (await req('/categories', { name: 'Grain' }, token)).category;
const prod = (await req('/products', {
  name: 'Rice 5kg', categoryId: cat._id, price: 500, cost: 300, stock: 40,
}, token)).product;
// 4 x (500 sell / 300 cost) = revenue 2000, cogs 1200, gross profit 800.
await req('/orders', { items: [{ productId: prod._id, qty: 4 }], customerName: 'Anil' }, token);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.evaluate(() => document.body.innerText);
const tap = async (name, { exact = true, nth = 'last' } = {}) => {
  const loc = page.getByRole('button', { name, exact });
  await (nth === 'last' ? loc.last() : loc.first()).click();
};
/**
 * The bottom bar's items carry role="tab" with no aria-label, so they are
 * addressed by their text. The in-screen Sales/Expenses segment deliberately
 * uses role="button" instead -- one of the bottom tabs is also called "Sales",
 * and two "Sales" tabs would make both ambiguous.
 */
/**
 * Some in-screen segments (Stock's Products/Categories) carry no accessibility
 * role at all, so they cannot be reached by role. Clicking their label text is
 * the only handle -- and it is the same handle a person has.
 */
const tapText = async (text) => {
  await page.getByText(text, { exact: false }).last().click();
};
/**
 * Stock's segment labels carry a live count -- "Products (3)" -- which is what
 * makes them addressable at all, since a bare "Products" also matches the
 * "1 Products" caption on every category card.
 */
/**
 * Inputs are addressed through the dialog card or by placeholder, never as
 * `input.first()`. React Navigation keeps the screen underneath MOUNTED, so a
 * bare input selector reaches the hidden search box on the screen behind --
 * which is exactly how this suite first failed.
 */
const CARD = 'div.rounded-3xl.bg-white.overflow-hidden';
const cardInput = (n) => page.locator(`${CARD} input`).nth(n);

const tapSegment = async (label) => {
  await page.getByText(new RegExp(`^${label} \\(\\d+\\)$`)).last().click();
};

/**
 * Settings sits ABOVE the tab navigator, so while it is open the tab bar is
 * present in the DOM but not visible. Walking back out before tapping a tab
 * makes the suite immune to a Back tap that landed a frame early -- which is
 * what made it fail intermittently rather than repeatably.
 */
const returnToTabs = async () => {
  for (let i = 0; i < 4; i += 1) {
    if (await page.locator('[role="tab"]').first().isVisible().catch(() => false)) return;
    await page.getByRole('button', { name: /^(Back|वापस|પાછા)$/ }).last().click().catch(() => {});
    await page.waitForTimeout(1100);
  }
};

const tapTab = async (name) => {
  await returnToTabs();
  // Substring, not an anchored regex: the icon font renders as a private-use
  // glyph inside the same element, so the text is never just the label.
  await page.locator('[role="tab"]').filter({ hasText: name }).last().click();
};

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3200);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

/* ======================= 1. the centred modal ======================= */
console.log('\n=== the new-category and new-product forms are centred dialogs ===');
await tapTab('Stock');
await page.waitForTimeout(1600);
await tapSegment('Categories');
await page.waitForTimeout(700);
await tap('New category', { exact: false });
await page.waitForTimeout(900);

/**
 * The claim is geometric, so it is measured rather than eyeballed. A dialog is
 * centred when the gap above it and the gap below it agree; the old bottom
 * sheet had a bottom gap of zero, which is what this catches.
 *
 * The card is found by the class it is built with rather than by walking up
 * from its title -- the title text also appears on the button that opened it,
 * and climbing from the wrong one found the tab bar.
 */
const measureCard = () => page.evaluate((sel) => {
  const card = [...document.querySelectorAll(sel)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 240 && r.height > 100)
    .pop();
  if (!card) return null;
  const { r } = card;
  return {
    top: Math.round(r.top),
    bottom: Math.round(window.innerHeight - r.bottom),
    left: Math.round(r.left),
    right: Math.round(window.innerWidth - r.right),
    height: Math.round(r.height),
    viewport: window.innerHeight,
  };
}, CARD);

const geometry = await measureCard();
check('the dialog card was found and measured', Boolean(geometry), geometry);
if (geometry) {
  check('it is vertically centred, not anchored to the bottom edge',
    geometry.bottom > 60 && Math.abs(geometry.top - geometry.bottom) <= 8, geometry);
  check('and horizontally centred', Math.abs(geometry.left - geometry.right) <= 4, geometry);
  check('a short form stays short -- the cap does not stretch or clip it',
    geometry.height < geometry.viewport * 0.7, geometry);
}
await page.screenshot({ path: `${SHOT}/modal-category-centred.png` });

// Fill it in, so the dialog is proven usable and not merely well positioned.
// The dialog's own field, by the placeholder the form gives it -- not
// `input.first()`, which is the product search box behind the backdrop.
await page.locator('[placeholder="Beverages"]').last().fill('Oil');
await page.waitForTimeout(300);
await tap('Save', { exact: false });
await page.waitForTimeout(1800);
check('the centred dialog still saves', /Oil/.test(await body()), (await body()).slice(0, 200));

// The product form is the tall one -- a photo tile plus six fields.
await tapSegment('Products');
await page.waitForTimeout(800);
await tap('New product', { exact: false });
await page.waitForTimeout(1000);
const prodGeom = await measureCard();
check('the taller product dialog is centred too and does not overflow',
  prodGeom && prodGeom.top > 8 && Math.abs(prodGeom.top - prodGeom.bottom) <= 8
    && prodGeom.height <= prodGeom.viewport * 0.87,
  prodGeom);
check('and it IS taller than the one-field category dialog',
  prodGeom && geometry && prodGeom.height > geometry.height,
  { product: prodGeom?.height, category: geometry?.height });
await page.screenshot({ path: `${SHOT}/modal-product-centred.png` });
await tap('Cancel', { exact: false });
await page.waitForTimeout(700);

/* ================= 2. the header chip and the Settings screen ================= */
console.log('\n=== the shop name in the header opens Settings ===');
const headerHasLanguagePicker = await page.evaluate(() =>
  [...document.querySelectorAll('div,span')].some((el) =>
    el.childElementCount === 0 && /^(EN|HI|GU)$/.test(el.textContent.trim())));
check('the EN/HI/GU control is gone from the header', !headerHasLanguagePicker);

const chipShowsShop = await page.evaluate((name) => {
  const el = [...document.querySelectorAll('div,span')]
    .find((n) => n.childElementCount === 0 && n.textContent.trim() === name);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Right half of the screen, in the header band.
  return { right: r.right > window.innerWidth * 0.5, top: r.top < 120 };
}, shop);
check('the shop name sits on the RIGHT of the header', chipShowsShop?.right === true, chipShowsShop);
check('and inside the header band', chipShowsShop?.top === true, chipShowsShop);
await page.screenshot({ path: `${SHOT}/header-shop-chip.png` });

// The name pill is labelled with the shop name alone now; the gear beside it
// is the one labelled "Settings". Either opens Settings.
await page.getByRole('button', { name: shop, exact: true }).last().click();
await page.waitForTimeout(1400);
const settingsText = await body();
check('Settings opened', /Settings/.test(settingsText), settingsText.slice(0, 200));
for (const label of ['Business information', 'Security & login', 'Language', 'Version', 'Log out']) {
  check(`Settings lists "${label}"`, settingsText.includes(label));
}
await page.screenshot({ path: `${SHOT}/settings-list.png` });

/* --- rename the shop --- */
console.log('\n=== renaming the shop through Settings ===');
await tap('Business information', { exact: false });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOT}/settings-business.png` });
const shopIdShown = await body();
check('the business screen shows the opaque shop id',
  /biz_[0-9a-f]{6}/.test(shopIdShown), shopIdShown.slice(0, 400));

const renamed = `${shop} Stores`;
// By placeholder, and `.last()`: the POS search box is still mounted behind.
await page.locator('[placeholder="Sharma Kirana"]').last().fill(renamed);
await page.waitForTimeout(400);
await tap('Save', { exact: false });
await page.waitForTimeout(2200);
check('the rename went back to Settings', /Business information/.test(await body()));
const afterRename = await body();
check('and the new name is on screen', afterRename.includes(renamed), afterRename.slice(0, 240));

// The server is the authority on the name, not the local store.
const meAfter = await req('/auth/me', null, token, 'GET');
check('the server really holds the new name', meAfter.business?.name === renamed, meAfter.business);

/* --- the language radio list --- */
console.log('\n=== the language list ===');
await tap('Language', { exact: false });
await page.waitForTimeout(1100);
const langText = await body();
check('all three languages are offered in their own script',
  langText.includes('English') && langText.includes('हिन्दी') && langText.includes('ગુજરાતી'),
  langText.slice(0, 240));
await page.screenshot({ path: `${SHOT}/settings-language.png` });

await page.getByRole('radio', { name: 'ગુજરાતી', exact: true }).last().click();
await page.waitForTimeout(1300);
check('picking Gujarati translates this very screen', (await body()).includes('ભાષા'), (await body()).slice(0, 200));
await page.screenshot({ path: `${SHOT}/settings-language-gu.png` });

// Back to English so the rest of the walk reads.
await page.getByRole('radio', { name: 'English', exact: true }).last().click();
await page.waitForTimeout(1200);
check('and switching back works', (await body()).includes('Language'));

await tap('Back', { exact: false });
await page.waitForTimeout(1000);

/* --- change the PIN --- */
console.log('\n=== changing the PIN ===');
await tap('Security & login', { exact: false });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOT}/settings-security.png` });

const pins = page.locator('[placeholder="••••"]');
await pins.nth(0).fill('1234');
await pins.nth(1).fill('9999');
await pins.nth(2).fill('9998');
await page.waitForTimeout(400);
check('a mismatched confirmation is called out', (await body()).includes('do not match'), (await body()).slice(0, 300));

// A wrong current PIN must fail on the SERVER's word, and must not read as an
// expired session -- the 401 here means "wrong PIN", not "sign in again".
await pins.nth(2).fill('9999');
await pins.nth(0).fill('4321');
await page.waitForTimeout(300);
await tap('Change PIN', { exact: false });
await page.waitForTimeout(2200);
const wrongPinText = await body();
check('a wrong current PIN is refused without signing the shop out',
  /not your current PIN/i.test(wrongPinText) && !/Sign in$/m.test(wrongPinText),
  wrongPinText.slice(0, 300));

await pins.nth(0).fill('1234');
await page.waitForTimeout(300);
await tap('Change PIN', { exact: false });
await page.waitForTimeout(2400);
check('the real change succeeds and returns to Settings', /Business information/.test(await body()));

// Prove it at the API, and prove the old PIN is dead.
const oldPin = await req('/auth/login', { businessName: renamed, pin: '1234' });
const newPin = await req('/auth/login', { businessName: renamed, pin: '9999' });
check('the old PIN no longer signs in', !oldPin.token, oldPin);
check('the new PIN does', Boolean(newPin.token));

await tap('Back', { exact: false });
await page.waitForTimeout(1200);

/* ================= 3. expenses, and what they do to profit ================= */
console.log('\n=== recording an expense in the Sales tab ===');
await tapTab('Sales');
await page.waitForTimeout(1800);
const salesText = await body();
check('the Sales tab offers a Sales / Expenses segment',
  salesText.includes('Expenses') && salesText.includes('Sales'), salesText.slice(0, 240));

await tap('Expenses');
await page.waitForTimeout(1600);
check('the empty state explains what an expense is',
  /No expenses yet/.test(await body()), (await body()).slice(0, 240));
await page.screenshot({ path: `${SHOT}/expenses-empty.png` });

await tap('Add expense', { exact: false });
await page.waitForTimeout(1100);
await page.screenshot({ path: `${SHOT}/expenses-form.png` });

// Both guards, before the happy path.
await tap('Save', { exact: false });
await page.waitForTimeout(700);
check('saving with nothing filled in asks for an amount',
  /Enter an amount/.test(await body()), (await body()).slice(0, 260));

await cardInput(0).fill('2500');
await page.waitForTimeout(200);
await tap('Save', { exact: false });
await page.waitForTimeout(700);
check('an amount with no note is refused too',
  /Say what the money was spent on/.test(await body()), (await body()).slice(0, 260));

await cardInput(1).fill('Shop rent');
await page.waitForTimeout(300);
await tap('Save', { exact: false });
await page.waitForTimeout(2400);
const afterExpense = await body();
check('the expense is listed', afterExpense.includes('Shop rent'), afterExpense.slice(0, 300));
check('and totalled', /2,500/.test(afterExpense), afterExpense.slice(0, 300));
await page.screenshot({ path: `${SHOT}/expenses-list.png` });

// Editing reopens the same centred dialog with the values in it.
// Anchored: the row's own label is "Shop rent, ₹2,500" while the trash icon
// beside it is labelled "Delete Shop rent" -- an unanchored match, taken last,
// hit the delete button and opened a confirmation instead of the editor.
await page.getByRole('button', { name: /^Shop rent,/ }).last().click();
await page.waitForTimeout(1100);
const editValue = await cardInput(0).inputValue();
check('tapping an expense opens it for editing, pre-filled', editValue === '2500', editValue);
await cardInput(0).fill('3000');
await page.waitForTimeout(300);
await tap('Save', { exact: false });
await page.waitForTimeout(2200);
check('the edit is applied', /3,000/.test(await body()), (await body()).slice(0, 300));

/* --- back-dating, which is the only reason spentAt exists --- */
console.log('\n=== an expense can be dated to the day it was actually paid ===');
await tap('Add expense', { exact: false });
await page.waitForTimeout(1000);
await cardInput(0).fill('120');
await cardInput(1).fill('Tea for the shop');

// Yesterday, by the one-tap chip.
await tap('Yesterday', { exact: false });
await page.waitForTimeout(500);

// Then the calendar, to prove the shared month grid drives a single date and
// refuses the future -- a shopkeeper cannot have spent money they have not spent.
await tap('Pick a date', { exact: false });
await page.waitForTimeout(1100);
await page.screenshot({ path: `${SHOT}/expenses-datepicker.png` });

const calendar = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('[role="button"]')]
    .filter((el) => /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(el.getAttribute('aria-label') ?? ''));
  return {
    count: cells.length,
    disabled: cells.filter((el) => el.getAttribute('aria-disabled') === 'true'
      || el.disabled === true).length,
    labels: cells.map((el) => el.getAttribute('aria-label')),
  };
});
check('the calendar rendered a month of days', calendar.count >= 28, calendar.count);
check('and days after today are not selectable',
  calendar.disabled > 0, { count: calendar.count, disabled: calendar.disabled });

// Pick the 2nd of this month -- unambiguously past, and not the day the chips
// already offer, so the assertion cannot pass by accident.
const target = calendar.labels.find((l) => l.startsWith('02 '));
check('a past day is on the grid', Boolean(target), { target, sample: calendar.labels.slice(0, 4) });
if (!target) throw new Error('no 2nd-of-the-month cell found; the calendar labels changed shape');
await page.getByRole('button', { name: target, exact: true }).last().click();
await page.waitForTimeout(900);
check('the chip now shows the chosen date', (await body()).includes(target), (await body()).slice(0, 400));

await tap('Save', { exact: false });
await page.waitForTimeout(2300);
const dated = await body();
check('the back-dated expense is listed', dated.includes('Tea for the shop'), dated.slice(0, 400));
check('under the date it was paid, not today', dated.includes(target), dated.slice(0, 400));

// And the server agrees -- the day must not have drifted backwards through UTC.
const monthStart = new Date();
monthStart.setDate(1);
const iso = (d) => d.toISOString().slice(0, 10);
const listed = await req(`/expenses?from=${iso(monthStart)}&to=${iso(new Date())}`, null, token, 'GET');
const teaRow = (listed.expenses ?? []).find((e) => e.note === 'Tea for the shop');
check('the server stored it on that same calendar day',
  teaRow && new Date(teaRow.spentAt).getDate() === 2, teaRow);

// Remove it again so the report arithmetic below stays the clean 3000.
await page.getByRole('button', { name: /^Delete Tea for the shop$/ }).last().click();
await page.waitForTimeout(900);
await tap('Delete', { exact: true });
await page.waitForTimeout(2100);
check('deleting it takes it back out of the total',
  !(await body()).includes('Tea for the shop'), (await body()).slice(0, 300));

/* --- the report --- */
console.log('\n=== the report now separates gross from net ===');
await tapTab('Reports');
await page.waitForTimeout(3200);
const rep = await body();
await page.screenshot({ path: `${SHOT}/reports-net-profit.png`, fullPage: true });

check('revenue is the 2,000 that was rung up', /2,000/.test(rep), rep.slice(0, 500));
check('the profit tile is labelled GROSS, not just "Profit"', rep.includes('Gross profit'), rep.slice(0, 500));
check('gross profit is 800 (2000 - 1200 cost)', /800/.test(rep), rep.slice(0, 500));
check('expenses appear as their own figure', rep.includes('Expenses'), rep.slice(0, 500));
check('the 3,000 of rent is shown', /3,000/.test(rep), rep.slice(0, 500));
// 800 gross - 3000 rent = -2200. The whole point: a loss reads as a loss.
check('and the bottom line is reported as a NET LOSS, not a floor of zero',
  rep.includes('Net loss') && /2,200/.test(rep), rep.slice(0, 600));

// Confirm against the API rather than trusting the rendered text alone.
const summary = await req(`/reports/summary?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`, null, token, 'GET');
const s = summary.sales;
check('API: profit still means gross, so nothing reading it changed', s?.profit === s?.grossProfit, s);
check('API: netProfit is gross minus expenses, and negative', s?.netProfit === -2200, s);

/* ============ 4. the header has to hold both, in every language ============ */
console.log('\n=== the screen title and the shop chip must not collide ===');
/**
 * The reason to check this at all: the shop name only just fits. The title is
 * the longest string on the screen in Hindi and Gujarati ("વેચાણ કાઉન્ટર" against
 * "Point of Sale"), and the chip is a fixed pill on the same line. If the two
 * ever overlap, the operator loses the one label that says where they are.
 *
 * Overlap is measured as real geometry, not read off a screenshot. Android text
 * metrics still differ from the browser's, so this bounds the layout, not the
 * glyphs.
 */
const LANGS = [
  { code: 'EN', radio: 'English', back: 'Back', title: 'Point of Sale', sellTab: 'Sell' },
  { code: 'HI', radio: 'हिन्दी', back: 'वापस', title: 'बिक्री काउंटर', sellTab: 'बेचें' },
  { code: 'GU', radio: 'ગુજરાતી', back: 'પાછા', title: 'વેચાણ કાઉન્ટર', sellTab: 'વેચો' },
];

const headerBoxes = (titleText, shopText) => page.evaluate(([tt, st]) => {
  const leaf = (needle) => [...document.querySelectorAll('div,span')]
    .filter((el) => el.childElementCount === 0 && el.textContent.trim() === needle)
    .filter((el) => el.getBoundingClientRect().top < 140
      && el.getBoundingClientRect().height > 0)
    .pop();
  const titleEl = leaf(tt), chipEl = leaf(st);
  if (!titleEl || !chipEl) {
    return { found: false, title: Boolean(titleEl), chip: Boolean(chipEl) };
  }
  const t = titleEl.getBoundingClientRect();
  const c = chipEl.getBoundingClientRect();

  /**
   * The assertion that matters. `numberOfLines={1}` does not shrink the title
   * when it runs out of room -- it ELLIPSISES it, so the box stays exactly as
   * wide as its container while the words are cut. Measuring the box therefore
   * proves nothing at all, which is why the earlier check ("not squeezed to
   * nothing") passed while the real question went unasked.
   *
   * scrollWidth is the width the text WANTS; clientWidth is what it got. A gap
   * between them is text the operator cannot read.
   */
  const overflow = titleEl.scrollWidth - titleEl.clientWidth;

  // The gear is the last header control; it fixes the true right margin.
  const gear = [...document.querySelectorAll('[role="button"]')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.top < 140 && r.width > 20 && r.width < 60)
    .pop();

  return {
    found: true,
    titleRight: Math.round(t.right),
    chipLeft: Math.round(c.left),
    titleClipped: t.width < 8,
    titleOverflow: overflow,
    titleWanted: titleEl.scrollWidth,
    titleGot: titleEl.clientWidth,
    // Gap between the name pill's text and the title's right edge.
    gapToTitle: Math.round(c.left - t.right),
    chipRight: Math.round(window.innerWidth - c.right),
    gearRight: gear ? Math.round(window.innerWidth - gear.r.right) : null,
    gearSize: gear ? Math.round(gear.r.width) : null,
    // The two must be visibly apart, which is the whole point of splitting them.
    gearGapFromName: gear ? Math.round(gear.r.left - c.right) : null,
  };
}, [titleText, shopText]);

// The bottom tabs are translated too, so the label to tap depends on the
// language the previous iteration left the app in.
let sellTab = 'Sell';
for (const lang of LANGS) {
  await tapTab(sellTab);
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: new RegExp(renamed) }).last().click();
  await page.waitForTimeout(1300);
  await page.getByRole('button', { name: /^(Language|भाषा|ભાષા)/ }).last().click();
  await page.waitForTimeout(1100);
  await page.getByRole('radio', { name: lang.radio, exact: true }).last().click();
  await page.waitForTimeout(1400);
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole('button', { name: lang.back, exact: true }).last().click();
    await page.waitForTimeout(1000);
  }
  sellTab = lang.sellTab;

  const box = await headerBoxes(lang.title, renamed);
  check(`${lang.code}: both the title and the shop chip are in the header`, box.found === true, box);
  if (box.found) {
    check(`${lang.code}: they do not overlap`, box.chipLeft >= box.titleRight, box);
    check(`${lang.code}: the title is not squeezed to nothing`, !box.titleClipped, box);
    // The one that actually catches a cut-off title.
    check(`${lang.code}: the screen title is not ellipsised`, box.titleOverflow <= 1, box);
    check(`${lang.code}: the gear is a real 36px target, not a 15px glyph`,
      box.gearSize >= 34, box);
    check(`${lang.code}: the name and the gear are visibly separate`,
      box.gearGapFromName >= 8, box);
    check(`${lang.code}: the gear sits against the right edge`, box.gearRight <= 20, box);
  }
  await page.screenshot({ path: `${SHOT}/header-${lang.code}.png` });
}

console.log(`\n${pass} passed, ${fail} failed | page errors: ${errors.length}`);
errors.slice(0, 6).forEach((e) => console.log('  -', e.slice(0, 200)));
await browser.close();
process.exit(fail ? 1 : 0);
