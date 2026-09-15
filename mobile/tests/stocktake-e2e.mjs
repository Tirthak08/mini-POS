/**
 * The stock count, driven through the real screen.
 *
 * The unit suite (stocktake-math.mjs) proves the arithmetic. This proves the
 * things arithmetic cannot: that the screen is reachable, that a blank field
 * really does survive the round trip untouched, that the draft comes back after
 * the app is closed mid-count, and that applying it moves the actual stock.
 *
 * Needs the API on :5000 and `npx expo export --platform web` served on :8099.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';

const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && { body: JSON.stringify(body) }),
})).json();

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 350) : ''}`));
};

/* ------------------------------ a shop ------------------------------ */
const shop = 'Count ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;
const grain = (await req('/categories', { name: 'Grain' }, token)).category;
const snacks = (await req('/categories', { name: 'Snacks' }, token)).category;

const make = async (name, categoryId, stock, cost) =>
  (await req('/products', { name, categoryId, price: cost * 2, cost, stock }, token)).product;

const rice = await make('Rice 5kg', grain._id, 20, 50);
const dal = await make('Dal 1kg', grain._id, 12, 30);
const atta = await make('Atta 10kg', grain._id, 8, 100);
const chips = await make('Chips', snacks._id, 40, 5);

// One sale, so the reconciliation has something real to account for.
await req('/orders', { items: [{ productId: rice._id, qty: 3 }] }, token);

const stockOf = async (id) => {
  const list = await (await fetch(`${API}/products`, { headers: { Authorization: `Bearer ${token}` } })).json();
  return list.products.find((p) => String(p._id) === String(id))?.stock;
};

// CHROME_PATH lets a machine whose Playwright and Chromium versions disagree
// point at the binary it actually has; everywhere else Playwright finds its own.
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

/** The count boxes, in list order: every numeric input in the list. */
const countBoxes = () => page.locator('input[inputmode="numeric"], input[type="number"]');

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  /* ==================== 1. it is reachable ==================== */
  console.log('\n=== the count is one tap from the stock screen ===');
  await tapTab('Stock');
  await page.waitForTimeout(2000);

  await tap('Stock count');
  await page.waitForTimeout(1800);
  const opened = await body();
  check('the Stock count screen opened', /Stock count/.test(opened), opened.slice(0, 160));
  check('  it shows nothing counted yet', /0 of 4 counted/.test(opened), opened.slice(0, 300));
  check('  and lists the products', /Rice 5kg/.test(opened) && /Chips/.test(opened));
  check('  with what is on record', /recorded 17/.test(opened), opened.slice(0, 400));

  /* ==================== 2. typing a count ==================== */
  console.log('\n=== typing what is on the shelf ===');
  const boxes = countBoxes();
  const n = await boxes.count();
  check('there is one box per product', n === 4, n);

  // Rows are sorted by category then name: Atta, Dal, Rice (Grain), Chips (Snacks).
  const labelled = async (name) =>
    page.locator('input').and(page.getByLabel(`Counted quantity for ${name}`)).first();

  await (await labelled('Rice 5kg')).fill('15');
  await page.waitForTimeout(700);
  let text = await body();
  check('the shortfall is shown on the row', /-2/.test(text), text.slice(0, 500));
  check('  progress moved to 1 of 4', /1 of 4 counted/.test(text), text.slice(0, 200));
  check('  and the running total is the loss at COST (2 x 50)',
    /₹\s?100/.test(text) || /-₹100/.test(text) || /₹-100/.test(text), text.slice(0, 600));

  await (await labelled('Dal 1kg')).fill('12');
  await page.waitForTimeout(700);
  text = await body();
  check('a matching count counts as counted', /2 of 4 counted/.test(text), text.slice(0, 200));
  check('  but is not a difference', /1 difference/.test(text), text.slice(0, 400));

  await (await labelled('Chips')).fill('43');
  await page.waitForTimeout(700);
  text = await body();
  check('a surplus is accepted too', /3 of 4 counted/.test(text), text.slice(0, 200));
  check('  and nets against the shortfall (3 x 5 = 15 against 100)',
    /85/.test(text), text.slice(0, 600));

  /* ============ 3. the outstanding filter, and blanks ============ */
  console.log('\n=== what has NOT been counted stays findable ===');
  check('the outstanding filter names the remaining one',
    /Not counted yet \(1\)/.test(await body()), (await body()).slice(0, 400));

  await tap('Not counted yet (1)');
  await page.waitForTimeout(900);
  const filtered = await body();
  check('  filtering shows only the uncounted product', /Atta 10kg/.test(filtered), filtered.slice(0, 400));
  check('  and hides the counted ones', !/Rice 5kg/.test(filtered), filtered.slice(0, 400));
  await tap('Not counted yet (1)');
  await page.waitForTimeout(800);

  /* ============ 4. the draft survives the app being killed ============ */
  console.log('\n=== a count in progress is not lost ===');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4200);
  await tapTab('Stock');
  await page.waitForTimeout(1600);
  await tap('Stock count');
  await page.waitForTimeout(1800);
  const restored = await body();
  check('the half-finished count came back', /3 of 4 counted/.test(restored), restored.slice(0, 300));
  const riceBox = await labelled('Rice 5kg');
  check('  with the typed figures intact', (await riceBox.inputValue()) === '15', await riceBox.inputValue());
  const attaBox = await labelled('Atta 10kg');
  check('  and the untouched one still BLANK, not zero',
    (await attaBox.inputValue()) === '', JSON.stringify(await attaBox.inputValue()));

  /* ==================== 5. applying it ==================== */
  console.log('\n=== applying the count ===');
  const before = { rice: await stockOf(rice._id), atta: await stockOf(atta._id) };
  check('before applying, stock is untouched', before.rice === 17 && before.atta === 8, before);

  await tap('Apply count');
  await page.waitForTimeout(1200);
  const dialog = await body();
  check('it asks first', /Apply this count\?/.test(dialog), dialog.slice(0, 400));
  check('  saying how many will change', /2 of the 3/.test(dialog), dialog.slice(0, 500));
  check('  and warning about the one not counted, in the singular',
    /One product you did not count will be left exactly as it is/.test(dialog), dialog.slice(0, 600));

  await tap('Apply count');
  await page.waitForTimeout(3000);
  const done = await body();
  check('the result screen appeared', /Count applied/.test(done), done.slice(0, 400));
  check('  2 corrected, 1 already matched',
    /2 corrected, 1 already matched/.test(done), done.slice(0, 400));
  check('  units short is reported', /Units short/.test(done) && /\b2\b/.test(done));

  const after = { rice: await stockOf(rice._id), atta: await stockOf(atta._id), chips: await stockOf(chips._id) };
  check('the counted stock actually changed', after.rice === 15 && after.chips === 43, after);
  check('  and the UNCOUNTED product was left exactly alone', after.atta === 8, after);

  /* ============ 6. the ledger recorded it, and reconciles ============ */
  console.log('\n=== the ledger explains the shop afterwards ===');
  const hist = await (await fetch(`${API}/products/${rice._id}/movements`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  check('the correction is in the history',
    hist.timeline.some((e) => e.type === 'adjustment' && e.reason === 'stocktake'),
    hist.timeline.slice(0, 3));
  check('  alongside the sale', hist.timeline.some((e) => e.type === 'sale'));
  check('  and nothing is unexplained', hist.reconciliation.unexplained === 0, hist.reconciliation);

  const attaHist = await (await fetch(`${API}/products/${atta._id}/movements`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  check('the product nobody counted got NO ledger row from the count',
    !attaHist.timeline.some((e) => e.reason === 'stocktake'), attaHist.timeline);

  /* ============ 7. the draft is cleared once applied ============ */
  console.log('\n=== once applied, the count is over ===');
  await tap('Back to stock');
  await page.waitForTimeout(1800);
  await tap('Stock count');
  await page.waitForTimeout(1800);
  const fresh = await body();
  check('reopening starts a clean count', /0 of 4 counted/.test(fresh), fresh.slice(0, 300));
  const freshRice = await labelled('Rice 5kg');
  check('  with every box blank again', (await freshRice.inputValue()) === '', await freshRice.inputValue());
  check('  and showing the corrected figure on record',
    /recorded 15/.test(fresh), fresh.slice(0, 500));

  /* ============ 8. it refuses to send an empty count ============ */
  console.log('\n=== an empty count cannot be applied ===');
  const applyBtn = page.getByRole('button', { name: 'Apply count', exact: true }).last();
  check('the Apply button is disabled with nothing counted',
    await applyBtn.isDisabled().catch(() => null) === true
      || (await applyBtn.getAttribute('aria-disabled')) === 'true',
    { disabled: await applyBtn.isDisabled().catch(() => null),
      aria: await applyBtn.getAttribute('aria-disabled') });
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
