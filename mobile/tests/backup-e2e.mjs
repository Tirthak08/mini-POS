/**
 * Backup and restore, through the real screen.
 *
 * The dangerous half is restore, and that is what this drives: picking a file,
 * being shown what is in it BEFORE anything happens, being told exactly what
 * will be destroyed, and then seeing the shop actually come back.
 *
 * SCOPE: saving the backup to a folder is Android's Storage Access Framework
 * and cannot run here -- there is no folder picker on web, and expo-file-system
 * has no cache directory in a browser. What is checked is that the export is
 * requested and comes back whole; that it lands on the phone's storage is a
 * phone test.
 *
 * Needs the API on :5000 and `npx expo export --platform web` served on :8099.
 */
import { playwright } from './_paths.mjs';
const { chromium } = await playwright();
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'http://127.0.0.1:5000/api';
const APP = 'http://127.0.0.1:8099/';

const req = async (p, body, t, m = 'POST') => (await fetch(API + p, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) },
  ...(body && m !== 'GET' && { body: JSON.stringify(body) }),
})).json();

/** Reads, for the assertions that have to look at the server rather than the screen. */
const get = (p, t) => req(p, null, t, 'GET');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 350) : ''}`));
};

/* ---------------- a shop worth losing, and a backup of it ---------------- */
const source = 'Src ' + crypto.randomBytes(3).toString('hex');
const srcToken = (await req('/auth/register', { businessName: source, pin: '1234' })).token;
const grain = (await req('/categories', { name: 'Grain' }, srcToken)).category;
const snacks = (await req('/categories', { name: 'Snacks' }, srcToken)).category;
const mk = async (n, c, price, cost, stock) =>
  (await req('/products', { name: n, categoryId: c, price, cost, stock }, srcToken)).product;
const rice = await mk('Rice 5kg', grain._id, 500, 380, 40);
const dal = await mk('Dal 1kg', grain._id, 120, 90, 25);
const chips = await mk('Chips', snacks._id, 20, 12, 60);
await req('/orders', { items: [{ productId: rice._id, qty: 2 }, { productId: chips._id, qty: 5 }] }, srcToken);
await req('/orders', { items: [{ productId: dal._id, qty: 3 }] }, srcToken);
await req('/expenses', { amount: 2500, note: 'Shop rent' }, srcToken);

const exported = await (await fetch(`${API}/backup/export`, {
  headers: { Authorization: `Bearer ${srcToken}` },
})).json();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyapaar-backup-'));
const backupPath = path.join(dir, 'vyapaar-backup.json');
fs.writeFileSync(backupPath, JSON.stringify(exported.backup));

// Two files that are not backups, to prove the screen says so rather than
// sending whatever it was handed to the server.
const notJsonPath = path.join(dir, 'shopping-list.json');
fs.writeFileSync(notJsonPath, 'Rice, dal, sugar\n');
const wrongJsonPath = path.join(dir, 'some-other-app.json');
fs.writeFileSync(wrongJsonPath, JSON.stringify({ hello: 'world', rows: [1, 2, 3] }));

/* ------------------------- the shop doing the restore ------------------------- */
const target = 'Tgt ' + crypto.randomBytes(3).toString('hex');
const tgtToken = (await req('/auth/register', { businessName: target, pin: '1234' })).token;
const other = (await req('/categories', { name: 'Leftovers' }, tgtToken)).category;
await req('/products', { name: 'Old thing', categoryId: other._id, price: 5, cost: 2, stock: 9 }, tgtToken);
await req('/orders', { items: [{ productId: (await get('/products', tgtToken)).products[0]._id, qty: 1 }] }, tgtToken);

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

/** Hands the file picker a path, whatever element expo-document-picker made. */
const pick = async (file) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    tap('Choose a backup file'),
  ]);
  await chooser.setFiles(file);
  await page.waitForTimeout(1500);
};

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.locator('[placeholder="Sharma Kirana"]').first().fill(target);
await page.locator('[placeholder="••••"]').first().fill('1234');
await tap('Sign in');
await page.waitForTimeout(3400);
check('signed in', /Point of Sale/.test(await body()), (await body()).slice(0, 120));

try {
  /* ==================== 1. reachable from Settings ==================== */
  console.log('\n=== backup lives in Settings, and says when you last took one ===');
  await tap('Settings');
  await page.waitForTimeout(1800);
  const settings = await body();
  check('Settings offers Backup & restore', /Backup & restore/.test(settings), settings.slice(0, 400));
  check('  and says you have never taken one', /Never/.test(settings), settings.slice(0, 400));

  await tap('Backup & restore', { exact: false });
  await page.waitForTimeout(2200);
  let text = await body();
  check('the screen opened', /What a backup holds/.test(text), text.slice(0, 300));

  /* ==================== 2. it counts what is really there ==================== */
  console.log('\n=== it says what a backup would hold ===');
  check('  it counts the products', /Products\s*\n?\s*1/.test(text), text.slice(0, 500));
  check('  and the sales', /Sales\s*\n?\s*1/.test(text), text.slice(0, 500));
  check('  photos, with a size', /Photos/.test(text) && /0 · 0 B/.test(text), text.slice(0, 600));
  check('  and that no backup has been taken', /never taken a backup/i.test(text), text.slice(0, 600));
  check('the photo backup is offered but disabled with no photos',
    await page.getByRole('button', { name: 'Save a backup with photos', exact: true })
      .last().isDisabled().catch(() => null) === true);

  /* ==================== 3. a file that is not a backup ==================== */
  console.log('\n=== a file that is not a backup is refused, and says so ===');
  await pick(notJsonPath);
  text = await body();
  check('plain text is rejected', /not a Vyapaar backup file/i.test(text), text.slice(0, 400));
  check('  and nothing is staged for restore', !/Restore\b.*\n.*Cancel/s.test(text));

  await pick(wrongJsonPath);
  text = await body();
  check('valid JSON that is not a backup is rejected',
    /file is not a Vyapaar backup/i.test(text), text.slice(0, 400));

  const stillThere = (await get('/products', tgtToken)).products;
  check('  and the shop is untouched by either', stillThere.length === 1, stillThere.map((p) => p.name));

  /* ============ 4. a real backup is summarised before anything happens ============ */
  console.log('\n=== a real backup is shown before it is applied ===');
  await pick(backupPath);
  text = await body();
  check('the file is summarised by shop name', new RegExp(source).test(text), text.slice(0, 700));
  check('  saying what it holds', /3 products · 2 sales · 1 expenses/.test(text), text.slice(0, 700));
  check('  and warning it has no photos', /no photos in it/i.test(text), text.slice(0, 700));
  check('  Restore and Cancel are both offered',
    await page.getByRole('button', { name: 'Restore', exact: true }).last().isVisible()
      && await page.getByRole('button', { name: 'Cancel', exact: true }).last().isVisible());

  const beforeConfirm = (await get('/products', tgtToken)).products;
  check('  and STILL nothing has been sent', beforeConfirm.length === 1, beforeConfirm.map((p) => p.name));

  /* ==================== 5. backing out is free ==================== */
  console.log('\n=== backing out costs nothing ===');
  await tap('Cancel');
  await page.waitForTimeout(900);
  check('cancelling clears the staged file',
    !new RegExp(source).test(await body()), (await body()).slice(0, 400));
  check('  and the shop is unchanged',
    (await get('/products', tgtToken)).products.length === 1);

  /* ============ 6. the confirmation says what will be destroyed ============ */
  console.log('\n=== the confirmation names what is about to be lost ===');
  await pick(backupPath);
  await tap('Restore');
  await page.waitForTimeout(1200);
  const dialog = await body();
  check('it asks before replacing', /Restore this backup\?/.test(dialog), dialog.slice(0, 500));
  check('  and says exactly what goes', /DELETE the 1 products and 1 sales/.test(dialog), dialog.slice(0, 700));
  check('  naming the shop the backup came from', new RegExp(source).test(dialog), dialog.slice(0, 700));
  check('  and that it cannot be undone', /cannot be undone/i.test(dialog), dialog.slice(0, 700));

  /**
   * The assertion that makes the three above worth having: the dialog has to
   * GATE the restore, not merely appear beside it. Without this, deleting the
   * `if (!ok) return` guard passes every test on this screen.
   */
  await page.waitForTimeout(800);
  const midDialog = (await get('/products', tgtToken)).products;
  check('  and while it is open, still nothing has been sent',
    midDialog.length === 1 && midDialog[0].name === 'Old thing', midDialog.map((p) => p.name));

  /* ============ 6b. and saying no to it is honoured ============ */
  console.log('\n=== declining the confirmation is honoured ===');
  await tap('Cancel');
  await page.waitForTimeout(1500);
  const declined = await body();
  check('the confirmation closes', !/Restore this backup\?/.test(declined), declined.slice(0, 300));
  const afterDecline = (await get('/products', tgtToken)).products;
  check('  and NOTHING was restored',
    afterDecline.length === 1 && afterDecline[0].name === 'Old thing', afterDecline.map((p) => p.name));
  check('  the file is still staged, ready to try again',
    new RegExp(source).test(declined), declined.slice(0, 600));

  /* ==================== 7. and then it actually works ==================== */
  console.log('\n=== restoring ===');
  await tap('Restore');
  await page.waitForTimeout(1200);
  /**
   * Polled rather than slept. The toast is transient, and a fixed wait long
   * enough for a slow restore is also long enough for the toast to have gone --
   * which reads as "the app never said anything" when it did.
   */
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

  await tap('Restore');
  const reported = await waitForText(/Restored 3 products and 2 sales/);
  check('it reports what came back', reported.ok, reported.seen.slice(0, 400));
  await page.waitForTimeout(2500);

  const products = (await get('/products', tgtToken)).products;
  check('the shop now holds the backup\'s products', products.length === 3, products.map((p) => p.name));
  check('  and not its own old one',
    !products.some((p) => p.name === 'Old thing'), products.map((p) => p.name));
  check('  with their categories intact',
    products.every((p) => p.category === 'Grain' || p.category === 'Snacks'),
    products.map((p) => [p.name, p.category]));

  const orders = (await get('/orders', tgtToken)).orders;
  check('the sales came back', orders.length === 2, orders.length);

  const summary = await (await fetch(`${API}/reports/summary`, {
    headers: { Authorization: `Bearer ${tgtToken}` },
  })).json();
  const srcSummary = await (await fetch(`${API}/reports/summary`, {
    headers: { Authorization: `Bearer ${srcToken}` },
  })).json();
  check('  and the reports agree with the shop it came from',
    summary.revenue === srcSummary.revenue && summary.orders === srcSummary.orders,
    { restored: summary.revenue, source: srcSummary.revenue });

  /* ============ 8. the screen catches up with what just happened ============ */
  console.log('\n=== the screen reflects the restore ===');
  await page.waitForTimeout(1200);
  const refreshed = await body();
  check('the counts on screen updated', /Products\s*\n?\s*3/.test(refreshed), refreshed.slice(0, 500));
  check('  and the staged file is gone', !/3 products · 2 sales/.test(refreshed), refreshed.slice(0, 500));

  /* ==================== 9. the POS sees the restored shop ==================== */
  console.log('\n=== the rest of the app sees it too ===');
  await tap('Back');
  await page.waitForTimeout(1200);
  await tap('Back');
  await page.waitForTimeout(1800);
  await page.locator('[role="tab"]').filter({ hasText: 'Stock' }).last().click();
  await page.waitForTimeout(2200);
  const stock = await body();
  check('the Stock tab shows the restored catalogue',
    /Rice 5kg/.test(stock) && /Chips/.test(stock), stock.slice(0, 600));
  check('  and the old product is gone from it', !/Old thing/.test(stock), stock.slice(0, 600));
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message.split('\n')[0]);
}

check('no uncaught errors in the app', errors.length === 0, errors.slice(0, 3));

fs.rmSync(dir, { recursive: true, force: true });
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
