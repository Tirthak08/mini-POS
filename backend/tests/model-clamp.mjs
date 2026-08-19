/**
 * The Order model must be safe against a DIRECT write, not only against the
 * HTTP path. Mongoose fires a parent's pre('validate') before its
 * subdocuments', so the parent used to sum raw `discount` values and could
 * report a discountTotal larger than the receipt actually gave away.
 *
 * A future migration or seed script writes through the model, not the API, so
 * this is the layer that has to hold.
 */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Order } from '/root/postest/src/models/index.js';

const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
await mongoose.connect(rs.getUri(), { dbName: 'clamp' });

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  PASS  ${label}`)) : (fail++, console.log(`  FAIL  ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

const biz = 'biz_' + 'a'.repeat(24);
const pid = new mongoose.Types.ObjectId();
const make = (items, extraCharges = 0) => new Order({
  businessId: biz, orderNumber: Math.floor(Math.random() * 1e6) + 1,
  customerName: 'Direct write', items, extraCharges,
});

console.log('an over-large per-line discount, written straight through the model');
let o = make([{ productId: pid, name: 'Ring', qty: 1, price: 50, cost: 30, discount: 9999, lineTotal: 0 }]);
await o.validate();
eq(o.subtotal, 50, 'subtotal is the gross 50');
eq(o.discountTotal, 50, 'discountTotal is clamped to the line gross, not 9999');
eq(o.grandTotal, 0, 'grand total is 0, never negative');
eq(o.items[0].discount, 50, 'the line itself is clamped too');
eq(Math.round((o.subtotal - o.discountTotal + o.extraCharges) * 100), Math.round(o.grandTotal * 100),
   'subtotal - discountTotal + charges === grandTotal');

console.log('\nthe same across several lines, one of them over-large');
o = make([
  { productId: pid, name: 'Ring', qty: 2, price: 50, cost: 30, discount: 500, lineTotal: 0 },
  { productId: pid, name: 'Chain', qty: 1, price: 200, cost: 120, discount: 20, lineTotal: 0 },
], 30);
await o.validate();
eq(o.subtotal, 300, 'gross of both lines (100 + 200)');
eq(o.discountTotal, 120, 'the over-large line contributes only its own 100, plus 20');
eq(o.grandTotal, 210, '300 - 120 + 30');
eq(Math.round((o.subtotal - o.discountTotal + o.extraCharges) * 100), Math.round(o.grandTotal * 100),
   'the receipt still adds up');

console.log('\na negative discount cannot inflate the total');
o = make([{ productId: pid, name: 'Ring', qty: 1, price: 50, cost: 30, discount: -100, lineTotal: 0 }]);
let rejected = false;
try { await o.validate(); } catch { rejected = true; }
eq(rejected || o.discountTotal >= 0, true, 'either rejected outright, or floored at 0 -- never a negative discount');
if (!rejected) eq(o.grandTotal, 50, 'and the total is not inflated above the gross');

console.log('\nthe honest case is untouched');
o = make([{ productId: pid, name: 'Ring', qty: 1, price: 50, cost: 30, discount: 10, lineTotal: 0 }]);
await o.validate();
eq([o.subtotal, o.discountTotal, o.grandTotal], [50, 10, 40], 'a normal 10-off receipt still reads 50 / 10 / 40');

console.log(`\n${pass} passed, ${fail} failed`);
await mongoose.disconnect();
await rs.stop();
process.exit(fail ? 1 : 0);
