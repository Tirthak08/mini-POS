/**
 * The filter dropdowns, in all three languages.
 *
 * The reported bug had two halves. Labels: on a real device the Gujarati chip
 * for "ગયા મહિને" rendered as "ગયા" -- Android wrapped the label at the space
 * because the chip was measured narrower than the text drew, then clipped the
 * second line. Discoverability: options past the fourth scrolled off the right
 * edge with nothing to say they were there.
 *
 * Dropdowns fix the cause, so the invariants asserted here are structural:
 *
 *   - every option's rendered string is the WHOLE translated label
 *   - no option's text is clipped horizontally or vertically
 *   - every option is reachable without horizontal scrolling
 *   - picking one changes both the trigger and the data fetched
 *   - and no two bottom tabs read the same
 */
import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';
const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m, headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && { body: JSON.stringify(body) }),
})).json();

const [en, hi, gu] = await Promise.all(
  ['en', 'hi', 'gu'].map((l) => import(`../src/i18n/${l}.js`).then((m) => m.default))
);
const LOCALES = { EN: en, HI: hi, GU: gu };

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`));
};

/* ---------------------------- seed ---------------------------- */
const shop = 'Drop ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
// Nine categories: more than a chip row could ever show, and one deliberately
// long name of the kind that used to be clipped mid-word.
const CAT_NAMES = ['Clothes', 'Rings', 'Shoes', 'These are test categories',
                   'Bangles', 'Necklaces', 'Earrings', 'Watches', 'Anklets'];
const cats = {};
for (const name of CAT_NAMES) cats[name] = (await req('/categories', { name }, token)).category;
await req('/products', { name: 'Diamond ring', categoryId: cats.Rings._id, price: 150, cost: 30, stock: 13 }, token);
await req('/products', { name: 'Shirt test', categoryId: cats.Clothes._id, price: 50, cost: 10, stock: 50 }, token);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const summaryCalls = [];
page.on('request', (r) => { if (r.url().includes('/reports/summary')) summaryCalls.push(r.url()); });

const tapTab = async (route, wait = 2400) => {
  await page.locator(`[role="tab"][href$="/${route}"]`).first().click();
  await page.waitForTimeout(wait);
};
/** Focused screen only: background tabs stay mounted and poison page-wide text. */
const frontText = () => page.evaluate(() => {
  const roots = [...document.querySelectorAll('div')].filter((d) => {
    const cls = (d.className || '').toString();
    return cls.includes('flex-1 bg-slate-50') && getComputedStyle(d).pointerEvents === 'auto';
  });
  if (!roots.length) throw new Error('no focused screen container');
  return roots[roots.length - 1].innerText;
});

/** Geometry of every option row currently rendered in an open sheet. */
const measureOptions = (labels) => page.evaluate((wanted) => {
  const out = {};
  for (const label of wanted) {
    const row = [...document.querySelectorAll('[role="button"]')]
      .filter((b) => b.getAttribute('aria-label') === label)
      .pop();
    if (!row) { out[label] = null; continue; }
    const leaves = [...row.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && e.textContent.trim());
    // The row can carry a sub-line ("1 products"); measure the label itself.
    const leaf = leaves.find((e) => e.textContent.trim() === label.trim()) ?? leaves[0] ?? row;
    const rr = row.getBoundingClientRect();
    out[label] = {
      shown: leaf.textContent,
      rowH: Math.round(rr.height),
      right: Math.round(rr.right),
      clientW: leaf.clientWidth, scrollW: leaf.scrollWidth,
      clientH: leaf.clientHeight, scrollH: leaf.scrollHeight,
    };
  }
  return out;
}, labels);

const assertOptions = (name, labels, geo, viewportW = 390) => {
  for (const label of labels) {
    const g = geo[label];
    if (!g) { check(`${name}: option "${label}" is rendered`, false, 'missing'); continue; }
    check(`${name}: "${label}" reads in full, not as a fragment`,
      g.shown.trim() === label.trim(), { shown: g.shown, want: label });
    check(`${name}: "${label}" is not clipped horizontally`,
      g.scrollW <= g.clientW + 1, { scrollW: g.scrollW, clientW: g.clientW });
    check(`${name}: "${label}" is not clipped vertically`,
      g.scrollH <= g.clientH + 1, { scrollH: g.scrollH, clientH: g.clientH });
    check(`${name}: "${label}" sits inside the screen, no sideways scrolling`,
      g.right <= viewportW + 1, { right: g.right });
  }
};

const openSelect = async (triggerLabel, wait = 900) => {
  const trigger = page.getByRole('button', { name: triggerLabel, exact: false }).last();
  await trigger.waitFor({ state: 'visible', timeout: 10000 });
  await trigger.click();
  await page.waitForTimeout(wait);
};
const closeSheet = async (closeLabel) => {
  await page.getByRole('button', { name: closeLabel, exact: true }).last().click();
  await page.waitForTimeout(700);
};
const pickOption = async (label, wait = 2400) => {
  await page.getByRole('button', { name: label, exact: true }).last().click();
  await page.waitForTimeout(wait);
};

/* ---------------------------- sign in ---------------------------- */
await page.goto(APP, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
await page.waitForTimeout(3200);

/** The switcher's buttons are named for the language, not its two-letter code. */
const LANG_BUTTON = { EN: 'English', HI: 'हिन्दी', GU: 'ગુજરાતી' };
const setLang = async (code) => {
  const btn = page.getByRole('button', { name: LANG_BUTTON[code], exact: true }).last();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
  await page.waitForTimeout(1700);
};

for (const [code, dict] of Object.entries(LOCALES)) {
  await tapTab('Reports', 3000);
  await setLang(code);

  console.log(`\n===== ${code}: the period dropdown on Reports =====`);
  const rangeKeys = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth',
                     'thisYear', 'lastYear', 'all', 'custom'];
  const rangeLabels = rangeKeys.map((k) => dict.range[k]);

  const front = await frontText();
  check(`${code}: the period field is labelled`, front.includes(dict.range.period), front.slice(0, 200));
  check(`${code}: the current choice is on the closed field`,
    front.includes(dict.range.thisMonth), front.slice(0, 200));

  // Counted as a delta, not an absolute: the Sell and Stock tabs stay mounted
  // behind this one and each has its own "Search" field.
  const searchBoxesBefore = await page.getByPlaceholder(dict.common.search).count();
  await openSelect(dict.range.period);
  check(`${code}: the period sheet adds no search box -- ten fixed presets are read, not searched`,
    (await page.getByPlaceholder(dict.common.search).count()) === searchBoxesBefore,
    { before: searchBoxesBefore, after: await page.getByPlaceholder(dict.common.search).count() });
  check(`${code}: all ten presets fit without scrolling, Custom included`,
    await page.getByRole('button', { name: dict.range.custom, exact: true }).last().isVisible());
  assertOptions(`${code} period`, rangeLabels, await measureOptions(rangeLabels));
  const listed = await Promise.all(rangeLabels.map((l) => page.getByRole('button', { name: l, exact: true }).count()));
  check(`${code}: all ten presets are listed at once`, listed.every((n) => n >= 1),
    Object.fromEntries(rangeLabels.map((l, i) => [l, listed[i]])));
  await page.screenshot({ path: `/tmp/drop-${code}-period.png` });
  await closeSheet(dict.common.close);

  console.log(`\n===== ${code}: picking a preset changes the query =====`);
  const before = summaryCalls.length;
  await openSelect(dict.range.period);
  await pickOption(dict.range.today, 3000);
  check(`${code}: choosing a preset refetches`, summaryCalls.length > before, { before, after: summaryCalls.length });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  check(`${code}: it asked for today`, (summaryCalls.at(-1) ?? '').includes(`from=${iso(new Date())}`), summaryCalls.at(-1));
  check(`${code}: the closed field now shows the new choice`,
    (await frontText()).includes(dict.range.today), (await frontText()).slice(0, 200));

  console.log(`\n===== ${code}: the week presets query a real week =====`);
  const isoD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sunday = new Date();
  sunday.setDate(sunday.getDate() - sunday.getDay());
  await openSelect(dict.range.period);
  await pickOption(dict.range.thisWeek, 3000);
  check(`${code}: This week starts on the most recent Sunday`,
    (summaryCalls.at(-1) ?? '').includes(`from=${isoD(sunday)}`), { url: summaryCalls.at(-1), want: isoD(sunday) });
  check(`${code}: This week ends today`,
    (summaryCalls.at(-1) ?? '').includes(`to=${isoD(new Date())}`), summaryCalls.at(-1));

  const prevSun = new Date(sunday); prevSun.setDate(prevSun.getDate() - 7);
  const prevSat = new Date(sunday); prevSat.setDate(prevSat.getDate() - 1);
  await openSelect(dict.range.period);
  await pickOption(dict.range.lastWeek, 3000);
  check(`${code}: Last week is the seven days Sunday to Saturday before it`,
    (summaryCalls.at(-1) ?? '').includes(`from=${isoD(prevSun)}`)
    && (summaryCalls.at(-1) ?? '').includes(`to=${isoD(prevSat)}`),
    { url: summaryCalls.at(-1), want: `${isoD(prevSun)}..${isoD(prevSat)}` });
  check(`${code}: the field shows the week choice`,
    (await frontText()).includes(dict.range.lastWeek), (await frontText()).slice(0, 200));

  console.log(`\n===== ${code}: Custom still opens the calendar =====`);
  await openSelect(dict.range.period);
  await pickOption(dict.range.custom, 1600);
  const body = await page.evaluate(() => document.body.innerText);
  check(`${code}: the calendar sheet opened`, body.includes(dict.range.customTitle), body.slice(0, 300));
  await page.getByRole('button', { name: dict.common.cancel, exact: true }).last().click();
  await page.waitForTimeout(1000);

  console.log(`\n===== ${code}: the category dropdown on Stock =====`);
  await tapTab('Inventory', 2800);
  const catLabels = [dict.pos.allItems, ...CAT_NAMES];
  const catSearchBefore = await page.getByPlaceholder(dict.common.search).count();
  await openSelect(dict.inventory.category);
  const catGeo = await measureOptions(catLabels);
  // Ten options cannot all be on screen at once, so only assert geometry for
  // the ones actually laid out; every label must still be findable.
  assertOptions(`${code} Stock category`, catLabels.filter((l) => catGeo[l]), catGeo);
  const found = await Promise.all(catLabels.map((l) => page.getByRole('button', { name: l, exact: true }).count()));
  check(`${code}: every category is in the list, not scrolled off a row`,
    found.every((n) => n >= 1), Object.fromEntries(catLabels.map((l, i) => [l, found[i]])));
  check(`${code}: ten categories DO add a search box`,
    (await page.getByPlaceholder(dict.common.search).count()) > catSearchBefore,
    { before: catSearchBefore, after: await page.getByPlaceholder(dict.common.search).count() });
  // "1 products" is the sort of thing an operator spots straight away.
  const subs = await page.evaluate(() => [...document.querySelectorAll('*')]
    .filter((e) => e.children.length === 0)
    .map((e) => e.textContent.trim()));
  // Hindi uses the same word for one and many, so there is nothing to catch
  // there; only assert where the two forms genuinely differ.
  const one = dict.inventory.productOne, many = dict.inventory.itemsCounted;
  check(`${code}: a count of one uses the singular form`,
    one === many || !subs.includes(`1 ${many}`),
    { one, many, offenders: subs.filter((x) => /^1 /.test(x)) });
  check(`${code}: counts of one are actually present to check`,
    subs.some((x) => /^1 /.test(x)), subs.filter((x) => /^\d+ /.test(x)).slice(0, 6));
  await page.screenshot({ path: `/tmp/drop-${code}-category.png` });

  console.log(`\n===== ${code}: the search box narrows the list =====`);
  await page.getByPlaceholder(dict.common.search).last().fill('Ring');
  await page.waitForTimeout(700);
  check(`${code}: a matching option survives`, (await page.getByRole('button', { name: 'Rings', exact: true }).count()) >= 1);
  check(`${code}: a non-matching option is filtered out`, (await page.getByRole('button', { name: 'Watches', exact: true }).count()) === 0);
  await pickOption('Rings', 1600);
  const invFront = await frontText();
  check(`${code}: the filter applied -- only the ring is listed`,
    invFront.includes('Diamond ring') && !invFront.includes('Shirt test'), invFront.slice(0, 300));
  check(`${code}: and the field shows the chosen category`, invFront.includes('Rings'));

  console.log(`\n===== ${code}: the four bottom tabs are distinguishable =====`);
  const tabLabels = await page.evaluate(() =>
    // innerText leads with the Ionicons glyph, which lives in the Unicode
    // Private Use Area and is not whitespace, so strip that range too.
    [...document.querySelectorAll('[role="tab"]')].map((t) =>
      (t.innerText || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim()));
  check(`${code}: four tabs`, tabLabels.length === 4, tabLabels);
  check(`${code}: no two tabs read the same`, new Set(tabLabels).size === tabLabels.length, tabLabels);
  check(`${code}: tabs read as expected`,
    JSON.stringify(tabLabels) === JSON.stringify([dict.tabs.pos, dict.tabs.inventory, dict.tabs.sales, dict.tabs.reports]),
    { got: tabLabels, want: [dict.tabs.pos, dict.tabs.inventory, dict.tabs.sales, dict.tabs.reports] });
  check(`${code}: the Sell and Sales screens have different titles`,
    dict.pos.title.trim() !== dict.sales.title.trim(), { pos: dict.pos.title, sales: dict.sales.title });

  // Reset both filters so the next language starts from a known state.
  await openSelect(dict.inventory.category);
  await pickOption(dict.pos.allItems, 1600);
  await tapTab('Reports', 2600);
  await openSelect(dict.range.period);
  await pickOption(dict.range.thisMonth, 2600);
}

/* ------------------- the product form's category ------------------- */
console.log('\n===== the New product form uses a dropdown =====');
await setLang('EN');
await tapTab('Inventory', 2600);
await page.getByRole('button', { name: 'New product', exact: false }).last().click();
await page.waitForTimeout(1400);
let form = await page.evaluate(() => document.body.innerText);
check('the form opened', /New product/.test(form), form.slice(0, 200));
check('the category field prompts for a choice', /Select a category/.test(form), form.slice(0, 400));
check('the chips are gone -- categories are not all laid out in the form',
  (await page.getByRole('button', { name: 'Watches', exact: true }).count()) === 0);
await page.screenshot({ path: '/tmp/drop-form-closed.png' });

await openSelect('Category');
const formCats = await Promise.all(CAT_NAMES.map((l) => page.getByRole('button', { name: l, exact: true }).count()));
check('every category is offered in the sheet', formCats.every((n) => n >= 1),
  Object.fromEntries(CAT_NAMES.map((l, i) => [l, formCats[i]])));
const formGeo = await measureOptions(CAT_NAMES);
assertOptions('product form', CAT_NAMES.filter((n) => formGeo[n]), formGeo);
await page.screenshot({ path: '/tmp/drop-form-open.png' });
await pickOption('These are test categories', 1200);
form = await page.evaluate(() => document.body.innerText);
check('the chosen category shows on the field', /These are test categories/.test(form), form.slice(0, 400));

console.log('\n===== the form still validates and still saves =====');
await page.getByRole('button', { name: 'Save', exact: true }).last().click();
await page.waitForTimeout(1200);
form = await page.evaluate(() => document.body.innerText);
check('an empty name is still rejected', /required|Required/i.test(form), form.slice(0, 300));

await page.getByPlaceholder('Masala Chai').last().fill('Dropdown probe');
const money = page.getByPlaceholder('0');
await money.nth(0).fill('99');
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Save', exact: true }).last().click();
await page.waitForTimeout(3000);
const saved = (await req('/products', null, token, 'GET')).products.find((p) => p.name === 'Dropdown probe');
check('the product saved', Boolean(saved), saved);
check('and it carries the category chosen from the dropdown',
  String(saved?.categoryId) === String(cats['These are test categories']._id),
  { got: saved?.categoryId, want: cats['These are test categories']._id });

console.log('\n===== Sell tab: the same dropdown =====');
await tapTab('Pos', 3000);
await openSelect('Category');
const sellCats = await Promise.all(['All', 'Rings', 'Watches'].map((l) => page.getByRole('button', { name: l, exact: true }).count()));
check('the Sell tab lists its categories in a sheet too', sellCats.every((n) => n >= 1), sellCats);
await pickOption('Rings', 2000);
const sell = await frontText();
check('the grid filtered to the chosen category',
  sell.includes('Diamond ring') && !sell.includes('Shirt test'), sell.slice(0, 300));
await page.screenshot({ path: '/tmp/drop-sell.png' });

console.log(`\n${pass} passed, ${fail} failed | console errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log('  -', e.slice(0, 200)));
await browser.close();
process.exit(fail ? 1 : 0);
