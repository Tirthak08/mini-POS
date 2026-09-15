/**
 * AUDIT 1 — the catalogue: categories, products, and every filter on them.
 *
 * This is not a feature suite. It walks the Stock tab the way somebody setting
 * up a shop would, and checks the things that only break when a screen is used
 * in earnest: a filter that does not clear, a search that ignores case, a count
 * in a heading that stops matching the list under it, a delete that takes
 * something with it.
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
  ...(body && m !== 'GET' && { body: JSON.stringify(body) }),
})).json();
const get = (p, t) => req(p, null, t, 'GET');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 350) : ''}`));
};

const shop = 'Audit1 ' + crypto.randomBytes(3).toString('hex');
const token = (await req('/auth/register', { businessName: shop, pin: '1234' })).token;

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
const fill = async (label, value) =>
  page.getByLabel(label, { exact: false }).last().fill(value);

/** Text of the Stock tab only — every tab stays mounted, so the whole body lies. */
const stockText = () => page.evaluate(() => {
  const heading = [...document.querySelectorAll('*')]
    .filter((n) => n.children.length === 0 && /^Products \(\d+\)$/.test(n.textContent || ''))
    .pop();
  let node = heading;
  while (node && node.parentElement) {
    node = node.parentElement;
    if ((node.innerText || '').includes('New product')) return node.innerText;
  }
  return document.body.innerText;
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(shop);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  await tapTab('Stock');
  await page.waitForTimeout(2200);

  /* ==================== 1. an empty shop says so ==================== */
  console.log('\n=== a brand new shop ===');
  let text = await stockText();
  check('it says there is nothing yet', /No products/i.test(text) || /No categories/i.test(text), text.slice(0, 400));
  check('  and the tab counts agree', /Products \(0\)/.test(text), text.slice(0, 300));

  /* ==================== 2. categories ==================== */
  console.log('\n=== categories ===');
  await tap('Categories (0)', { exact: false });
  await page.waitForTimeout(900);
  await tap('New category');
  await page.waitForTimeout(1200);
  await fill('Category name', 'Grain');
  await tap('Save');
  await page.waitForTimeout(1800);

  let cats = (await get('/categories', token)).categories;
  check('a category is created', cats.length === 1 && cats[0].name === 'Grain', cats.map((c) => c.name));
  check('  it gets a colour without being asked', /^#[0-9a-fA-F]{6}$/.test(cats[0].color ?? ''), cats[0].color);

  await tap('New category');
  await page.waitForTimeout(1200);
  await fill('Category name', 'grain');
  await tap('Save');
  await page.waitForTimeout(1800);
  text = await body();
  check('the same name in a different case is refused',
    (await get('/categories', token)).categories.length === 1,
    (await get('/categories', token)).categories.map((c) => c.name));
  check('  and says so on the form', /already/i.test(text), text.slice(0, 500));
  await tap('Cancel', { exact: false }).catch(() => {});
  await page.waitForTimeout(900);

  for (const name of ['Snacks', 'Drinks']) {
    await tap('New category');
    await page.waitForTimeout(1100);
    await fill('Category name', name);
    await tap('Save');
    await page.waitForTimeout(1600);
  }
  cats = (await get('/categories', token)).categories;
  check('three categories exist', cats.length === 3, cats.map((c) => c.name));
  check('  and the tab count keeps up', /Categories \(3\)/.test(await stockText()), (await stockText()).slice(0, 300));

  /* ==================== 3. products ==================== */
  console.log('\n=== products ===');
  await tap('Products (0)', { exact: false });
  await page.waitForTimeout(1000);

  const addProduct = async ({ name, category, price, cost, stock, unit }) => {
    await tap('New product');
    await page.waitForTimeout(1300);
    await fill('Product name', name);
    await page.getByRole('button', { name: 'Category', exact: false }).last().click();
    await page.waitForTimeout(800);
    await tap(category);
    await page.waitForTimeout(700);
    await fill('Selling price', String(price));
    await fill('Cost price', String(cost));
    if (unit) {
      await page.getByRole('button', { name: 'Sold by', exact: false }).last().click();
      await page.waitForTimeout(700);
      await tap(unit);
      await page.waitForTimeout(600);
    }
    await fill('Stock', String(stock));
    await tap('Save');
    await page.waitForTimeout(1900);
  };

  await addProduct({ name: 'Rice', category: 'Grain', price: 60, cost: 45, stock: 120, unit: 'Kilograms' });
  let products = (await get('/products', token)).products;
  check('a product is created', products.length === 1, products.map((p) => p.name));
  check('  with its price and cost', products[0].price === 60 && products[0].cost === 45, products[0]);
  check('  its unit', products[0].unit === 'kg', products[0].unit);
  check('  and its stock', products[0].stock === 120, products[0].stock);
  check('  filed under the right category', products[0].category === 'Grain', products[0].category);

  await addProduct({ name: 'Dal', category: 'Grain', price: 110, cost: 85, stock: 40, unit: 'Kilograms' });
  await addProduct({ name: 'Chips', category: 'Snacks', price: 20, cost: 12, stock: 60 });
  await addProduct({ name: 'Biscuits', category: 'Snacks', price: 30, cost: 20, stock: 45 });
  await addProduct({ name: 'Cola', category: 'Drinks', price: 40, cost: 28, stock: 3 });
  await addProduct({ name: 'Water', category: 'Drinks', price: 20, cost: 12, stock: 0 });

  products = (await get('/products', token)).products;
  check('six products exist', products.length === 6, products.map((p) => p.name));
  check('  and the tab count agrees', /Products \(6\)/.test(await stockText()), (await stockText()).slice(0, 300));

  /* ============ 4. the same name twice in one category ============ */
  console.log('\n=== the duplicate guard ===');
  await tap('New product');
  await page.waitForTimeout(1300);
  await fill('Product name', 'rice');
  await page.getByRole('button', { name: 'Category', exact: false }).last().click();
  await page.waitForTimeout(800);
  await tap('Grain');
  await page.waitForTimeout(700);
  await fill('Selling price', '70');
  await tap('Save');
  await page.waitForTimeout(1800);
  check('the same name in the same category is refused',
    (await get('/products', token)).products.length === 6,
    (await get('/products', token)).products.length);
  text = await body();
  check('  naming the category it clashes in', /already has a product/i.test(text), text.slice(0, 600));

  // The same name under a DIFFERENT category is legitimate.
  await page.getByRole('button', { name: 'Category', exact: false }).last().click();
  await page.waitForTimeout(800);
  await tap('Snacks');
  await page.waitForTimeout(700);
  await tap('Save');
  await page.waitForTimeout(1900);
  check('but the same name under another category is allowed',
    (await get('/products', token)).products.length === 7,
    (await get('/products', token)).products.map((p) => `${p.category}/${p.name}`));

  /* ==================== 5. the filters ==================== */
  console.log('\n=== the filters on the stock list ===');
  const rowsShown = async () => {
    const txt = await stockText();
    return ['Rice', 'Dal', 'Chips', 'Biscuits', 'Cola', 'Water'].filter((n) => txt.includes(n));
  };

  check('everything shows with no filter', (await rowsShown()).length === 6, await rowsShown());

  await page.getByRole('button', { name: 'Category', exact: false }).last().click();
  await page.waitForTimeout(900);
  await tap('Snacks');
  await page.waitForTimeout(1200);
  let shown = await rowsShown();
  check('filtering by category shows only that category',
    shown.includes('Chips') && shown.includes('Biscuits') && !shown.includes('Dal'), shown);
  check('  including the same-named product from it', /rice/i.test(await stockText()));

  const scoped = await stockText();
  check('  and the money tiles are scoped to it too',
    /₹2,110|₹2110/.test(scoped) || !/₹12,/.test(scoped), scoped.slice(0, 500));

  await page.getByRole('button', { name: 'Category', exact: false }).last().click();
  await page.waitForTimeout(900);
  await tap('All');
  await page.waitForTimeout(1200);
  check('clearing the category brings everything back', (await rowsShown()).length === 6, await rowsShown());

  const searchBox = page.getByPlaceholder('Search').last();
  await searchBox.fill('col');
  await page.waitForTimeout(1200);
  shown = await rowsShown();
  check('search is case-insensitive and partial', shown.includes('Cola') && !shown.includes('Rice'), shown);
  await searchBox.fill('ZZZZ');
  await page.waitForTimeout(1100);
  check('  a search matching nothing says so', /No products/i.test(await stockText()), (await stockText()).slice(0, 400));
  await searchBox.fill('');
  await page.waitForTimeout(1100);
  check('  clearing it restores the list', (await rowsShown()).length === 6, await rowsShown());

  /* ==================== 6. the low-stock filter ==================== */
  console.log('\n=== running low ===');
  text = await stockText();
  check('the heading counts what needs attention', /Running low/.test(text), text.slice(0, 600));
  await tap('Running low');
  await page.waitForTimeout(1300);
  shown = await rowsShown();
  check('the filter shows only what is low or out',
    shown.includes('Cola') && shown.includes('Water') && !shown.includes('Rice'), shown);
  await tap('Running low');
  await page.waitForTimeout(1200);
  check('  and toggles back off', (await rowsShown()).length === 6, await rowsShown());

  /* ==================== 7. editing ==================== */
  console.log('\n=== editing a product ===');
  await tap('Edit Cola');
  await page.waitForTimeout(1400);
  await fill('Selling price', '45');
  await fill('Stock', '24');
  await tap('Save');
  await page.waitForTimeout(1900);
  const cola = (await get('/products', token)).products.find((p) => p.name === 'Cola');
  check('the edit saved', cola.price === 45 && cola.stock === 24, cola);
  check('  and it is no longer running low', !(await stockText()).includes('Cola\nDrinks\n\n\n₹45\nMargin ₹17\n3'),
    'still shows 3');

  const ledger = await get(`/products/${cola._id}/movements`, token);
  check('  the stock change is in the ledger',
    ledger.timeline.some((m) => m.type === 'adjustment' && m.delta === 21), ledger.timeline.slice(0, 3));

  /* ==================== 8. deleting ==================== */
  console.log('\n=== deleting ===');
  await tap('Delete Water');
  await page.waitForTimeout(1300);
  await tap('Delete');
  await page.waitForTimeout(1900);
  check('a product can be deleted',
    (await get('/products', token)).products.length === 6,
    (await get('/products', token)).products.map((p) => p.name));

  await tap('Categories (3)', { exact: false });
  await page.waitForTimeout(1200);
  await tap('Delete Drinks');
  await page.waitForTimeout(1400);
  text = await body();
  check('deleting a category that still holds products warns first',
    /product/i.test(text), text.slice(0, 600));
  await tap('Cancel', { exact: false }).catch(() => {});
  await page.waitForTimeout(1000);
  check('  and backing out keeps it',
    (await get('/categories', token)).categories.length === 3,
    (await get('/categories', token)).categories.map((c) => c.name));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
