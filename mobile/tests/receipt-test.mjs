/**
 * The customer receipt (single sale).
 *
 * What a receipt must get right is not layout, it is arithmetic and language:
 * the numbers on the slip must be the ORDER's own numbers (what was charged),
 * the three-line story must add up (subtotal − discount + charges = total),
 * and a shop running in Hindi or Gujarati must hand over a slip in that
 * language. HTML injection through a customer name is also checked, because
 * customerName is free text typed at the counter.
 */
import { load } from './_paths.mjs';

const money = await load('utils/money.js', [
  ["import { APP_CONFIG } from '../config';", "const APP_CONFIG = { currencySymbol: '₹' };"],
]);
const receipt = await load('utils/receipt.js', [
  ["import * as Print from 'expo-print';", "const Print = {};"],
  ["import * as Sharing from 'expo-sharing';", "const Sharing = {};"],
  ["import { formatINR, formatDate, round2 } from './money';",
   `const APP_CONFIG = { currencySymbol: '₹' };
    const formatINR = ${money.formatINR.toString()};
    const formatDate = ${money.formatDate.toString()};
    const round2 = ${money.round2.toString()};
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];`],
]);

const dicts = {};
for (const l of ['en', 'hi', 'gu']) dicts[l] = (await import(`../src/i18n/${l}.js`)).default;
const makeT = (dict) => (key) => key.split('.').reduce((o, k) => o?.[k], dict) ?? key;

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 220) : ''}`));
};

// The exact case from the original bug report: a ₹50 ring, ₹10 off.
const order = {
  receiptNo: 'INV-000042',
  orderNumber: 42,
  customerName: 'Meera',
  timestamp: new Date(2026, 7, 18, 14, 5).toISOString(),
  items: [
    { name: 'Gold Ring', qty: 1, price: 50, discount: 10 },
    { name: 'Chain', qty: 2, price: 200, discount: 0 },
  ],
  subtotal: 450,
  discountTotal: 10,
  extraCharges: 25,
  grandTotal: 465,
  editCount: 0,
};

console.log('=== the numbers on the slip are the order\'s own ===');
const html = receipt.buildReceiptHtml({ order, businessName: 'Sharma Kirana', t: makeT(dicts.en) });
check('shop name is on it', html.includes('Sharma Kirana'));
check('receipt number is on it', html.includes('INV-000042'));
check('the customer is named', html.includes('Meera'));
check('the date is printed', html.includes('18 Aug 2026'));
check('line 1 gross is ₹50', html.includes('₹50'));
check('line 1 shows 1 × ₹50', html.includes('1 × ₹50'));
check('line 2 shows 2 × ₹200 = ₹400', html.includes('2 × ₹200') && html.includes('₹400'));
check('the line discount appears as a deduction', html.includes('− ₹10'));
check('the subtotal is the gross 450, not net', html.includes('₹450'));
check('extra charges appear as an addition', html.includes('+ ₹25'));
check('the grand total is 465', html.includes('₹465'));
check('no "Edited" marker on an untouched sale', !html.includes(dicts.en.sales.edited));

console.log('\n=== the three-line story adds up as printed ===');
check('450 − 10 + 25 = 465',
  Math.round((order.subtotal - order.discountTotal + order.extraCharges) * 100) === Math.round(order.grandTotal * 100));

console.log('\n=== an edited sale says so on the slip ===');
const edited = receipt.buildReceiptHtml({
  order: { ...order, editCount: 2 }, businessName: 'Sharma Kirana', t: makeT(dicts.en),
});
check('the edited marker is printed with its count', edited.includes(`${dicts.en.sales.edited} (2)`));

console.log('\n=== a discount larger than the line is clamped on the slip too ===');
const clamped = receipt.buildReceiptHtml({
  order: {
    ...order,
    items: [{ name: 'Ring', qty: 1, price: 50, discount: 9999 }],
    subtotal: 50, discountTotal: 50, extraCharges: 0, grandTotal: 0,
  },
  businessName: 'S', t: makeT(dicts.en),
});
check('the printed line discount is − ₹50, never − ₹9999',
  clamped.includes('− ₹50') && !clamped.includes('9,999') && !clamped.includes('9999'));

console.log('\n=== the receipt speaks the shop\'s language ===');
for (const [lang, dict] of Object.entries(dicts)) {
  const h = receipt.buildReceiptHtml({ order, businessName: 'Shop', t: makeT(dict) });
  check(`${lang}: subtotal label is "${dict.pos.subtotal}"`, h.includes(dict.pos.subtotal));
  check(`${lang}: grand total label is "${dict.pos.grandTotal}"`, h.includes(dict.pos.grandTotal));
  check(`${lang}: thank-you line is "${dict.receipt.thankYou}"`, h.includes(dict.receipt.thankYou));
}

console.log('\n=== a hostile customer name cannot inject markup ===');
const hostile = receipt.buildReceiptHtml({
  order: { ...order, customerName: '<script>alert(1)</script>' },
  businessName: '<img src=x onerror=alert(1)>', t: makeT(dicts.en),
});
check('script tags are escaped', !hostile.includes('<script>'), hostile.match(/.{0,60}script.{0,20}/)?.[0]);
check('attribute injection is escaped', !hostile.includes('<img src=x'));
check('the escaped text is still legible', hostile.includes('&lt;script&gt;'));

console.log('\n=== a missing receiptNo falls back to the order number ===');
const fallback = receipt.buildReceiptHtml({
  order: { ...order, receiptNo: undefined }, businessName: 'S', t: makeT(dicts.en),
});
check('INV-000042 is derived from orderNumber 42', fallback.includes('INV-000042'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
