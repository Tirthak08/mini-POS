/**
 * Does an image ever actually leave the database?
 *
 * Before this, the answer was no -- not when replaced, not when the product was
 * deleted, not when a form was abandoned. A single product whose photo had been
 * retaken four times held five copies and showed one. At ~60KB each that is the
 * real storage problem, far more than the size of any individual photo.
 *
 * The assertions are about BYTES, not row counts, because a row that is flagged
 * deleted while keeping its buffer costs exactly as much as one that is not.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

const PORT = 5180;
const API = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  ok ? (pass++, console.log(`  PASS  ${l}`))
     : (fail++, console.log(`  FAIL  ${l}${extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`));
};

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ launchTimeout: 120_000 }],
});
const uri = replSet.getUri();

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'test', MONGODB_URI: uri,
    MONGODB_DB: 'imagelife', JWT_SECRET: 'image-life-secret-long-enough-0123456789',
    ADMIN_USERNAME: 'superadmin', ADMIN_PASSWORD: 'image-life-admin',
    REPORT_TIMEZONE: 'Asia/Kolkata',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const shutdown = async (code) => { server.kill(); await replSet.stop(); process.exit(code); };

for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 500));
}

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
};

// A valid JPEG header plus filler, at the size the app really uploads.
const jpegOf = (kb) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(kb * 1024),
]).toString('base64');
const PHOTO = jpegOf(60);

const client = new MongoClient(uri);
await client.connect();
const col = client.db('imagelife').collection('productimages');

/** What the database is actually holding, in bytes -- deleted rows included. */
const held = async (businessId) => {
  const rows = await col.find(businessId ? { businessId } : {}).toArray();
  return {
    rows: rows.length,
    bytes: rows.reduce((s, r) => s + (r.bytes || 0), 0),
  };
};

try {
  const shop = 'Img ' + crypto.randomBytes(3).toString('hex');
  const reg = await api('POST', '/auth/register', { body: { businessName: shop, pin: '1234' } });
  const token = reg.body.token;
  const bizId = reg.body.business.businessId;
  const cat = (await api('POST', '/categories', { token, body: { name: 'Grain' } })).body.category;

  const upload = async (productId) => (await api('POST', '/images', {
    token, body: { base64: PHOTO, contentType: 'image/jpeg', ...(productId && { productId }) },
  })).body.image;

  /* ------------------------- replacing a photo ------------------------- */
  console.log('\n=== retaking a photo does not leave the old one behind ===');
  const first = await upload(null);
  const prod = (await api('POST', '/products', {
    token, body: { name: 'Rice 5kg', categoryId: cat._id, price: 100, stock: 5, imageId: first._id },
  })).body.product;

  const afterCreate = await held(bizId);
  check('one product with one photo holds one image', afterCreate.rows === 1, afterCreate);

  for (let i = 0; i < 4; i += 1) {
    const next = await upload(null);
    await api('PATCH', `/products/${prod._id}`, { token, body: { imageId: next._id } });
  }

  const afterReplacing = await held(bizId);
  check('after four retakes the database still holds exactly one photo',
    afterReplacing.rows === 1, afterReplacing);
  check('and the bytes did not grow with them',
    afterReplacing.bytes === afterCreate.bytes, afterReplacing);

  // The one kept must be the one the product actually points at.
  const current = (await api('GET', '/products', { token })).body.products
    .find((p) => String(p._id) === String(prod._id));
  const remaining = await col.findOne({ businessId: bizId });
  check('the surviving photo is the one on display',
    String(remaining._id) === String(current.imageId), { kept: remaining._id, onProduct: current.imageId });
  const stillServes = await api('GET', `/images/${current.imageId}`, { token });
  check('and it still serves', stillServes.status === 200);

  /* --------------------- clearing a photo entirely --------------------- */
  console.log('\n=== clearing a photo frees it too ===');
  await api('PATCH', `/products/${prod._id}`, { token, body: { imageId: null } });
  const afterClear = await held(bizId);
  check('removing the photo leaves nothing behind', afterClear.rows === 0, afterClear);

  /* ----------------------- deleting the product ----------------------- */
  console.log('\n=== deleting a product takes its photo with it ===');
  const img2 = await upload(null);
  const prod2 = (await api('POST', '/products', {
    token, body: { name: 'Wheat 10kg', categoryId: cat._id, price: 200, stock: 5, imageId: img2._id },
  })).body.product;
  check('the photo is stored', (await held(bizId)).rows === 1);

  const del = await api('DELETE', `/products/${prod2._id}`, { token });
  check('the product deletes', del.status === 200, del.body);
  const afterProductDelete = await held(bizId);
  check('and its photo is gone, not merely flagged',
    afterProductDelete.rows === 0 && afterProductDelete.bytes === 0, afterProductDelete);

  // The product row itself must SURVIVE -- old receipts resolve through it.
  const ghost = await client.db('imagelife').collection('products')
    .findOne({ _id: new (await import('mongodb')).ObjectId(String(prod2._id)) });
  check('the product row itself survives, so old receipts still resolve',
    Boolean(ghost) && ghost.deletedAt != null, { found: Boolean(ghost), deletedAt: ghost?.deletedAt });

  /* ------------------------- the DELETE endpoint ------------------------- */
  console.log('\n=== DELETE /images/:id really deletes ===');
  const loose = await upload(null);
  check('uploaded', (await held(bizId)).rows === 1);
  await api('DELETE', `/images/${loose._id}`, { token });
  check('the bytes are reclaimed', (await held(bizId)).bytes === 0, await held(bizId));

  /* ------------------------ abandoned upload forms ------------------------ */
  console.log('\n=== an abandoned form is cleaned up, but not too eagerly ===');
  const fresh = await upload(null);
  check('a just-uploaded orphan is KEPT -- the form may still be open',
    (await held(bizId)).rows === 1, await held(bizId));
  const servesFresh = await api('GET', `/images/${fresh._id}`, { token });
  check('and it still serves while the form is open', servesFresh.status === 200);

  // Age it past the grace window, then trigger the sweep with a new upload.
  await col.updateOne({ _id: fresh._id ? new (await import('mongodb')).ObjectId(String(fresh._id)) : null },
    { $set: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) } });
  const keeper = await upload(null);
  const afterSweep = await held(bizId);
  check('a day-old orphan is swept away on the next upload',
    afterSweep.rows === 1, afterSweep);
  check('and the sweep did not take the new one with it',
    (await api('GET', `/images/${keeper._id}`, { token })).status === 200);

  /* ------------- an archived business keeps its photos ------------- */
  console.log('\n=== archiving a business must stay reversible ===');
  const shopB = 'ImgB ' + crypto.randomBytes(3).toString('hex');
  const regB = await api('POST', '/auth/register', { body: { businessName: shopB, pin: '4321' } });
  const tokenB = regB.body.token;
  const bizB = regB.body.business.businessId;
  const catB = (await api('POST', '/categories', { token: tokenB, body: { name: 'Tea' } })).body.category;
  const imgB = (await api('POST', '/images', { token: tokenB, body: { base64: PHOTO, contentType: 'image/jpeg' } })).body.image;
  await api('POST', '/products', {
    token: tokenB, body: { name: 'Chai', categoryId: catB._id, price: 10, stock: 9, imageId: imgB._id },
  });

  const adminToken = (await api('POST', '/auth/admin/login', {
    body: { username: 'superadmin', password: 'image-life-admin' },
  })).body.token;
  await api('DELETE', `/admin/businesses/${encodeURIComponent(bizB)}`, { token: adminToken });

  const archived = await held(bizB);
  check('archiving KEEPS the photo, because archive is meant to be undone',
    archived.rows === 1 && archived.bytes > 0, archived);

  await api('POST', `/admin/businesses/${encodeURIComponent(bizB)}/restore`, { token: adminToken });
  const restored = await api('GET', '/products', { token: tokenB });
  const chai = restored.body.products?.[0];
  check('restoring brings the product back with its photo',
    Boolean(chai?.imageId), chai);
  check('and that photo still serves',
    (await api('GET', `/images/${chai.imageId}`, { token: tokenB })).status === 200);

  /* --------- purging, which is the irreversible one, frees them --------- */
  await api('DELETE', `/admin/businesses/${encodeURIComponent(bizB)}`, { token: adminToken });
  await api('DELETE', `/admin/businesses/${encodeURIComponent(bizB)}/purge`, { token: adminToken });
  check('purging reclaims every byte', (await held(bizB)).bytes === 0, await held(bizB));

  /* ---------------- one shop cannot free another's photos ---------------- */
  console.log('\n=== and none of this crosses tenants ===');
  const mine = await upload(null);
  const other = 'ImgC ' + crypto.randomBytes(3).toString('hex');
  const tokenC = (await api('POST', '/auth/register', { body: { businessName: other, pin: '1111' } })).body.token;
  const attack = await api('DELETE', `/images/${mine._id}`, { token: tokenC });
  check("another shop's delete of my image -> 404", attack.status === 404, attack.body);
  check('and my image is untouched',
    (await api('GET', `/images/${mine._id}`, { token })).status === 200);
} catch (err) {
  fail += 1;
  console.log('  FAIL  the suite threw:', err.message);
}

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
await shutdown(fail ? 1 : 0);
