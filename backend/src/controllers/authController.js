import crypto from 'node:crypto';
import { Business, Category, Product, Order, toSlug } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { requireFields, assertValidPin } from '../utils/validators.js';
import { signBusinessToken, signAdminToken } from '../utils/token.js';

/** What the app is allowed to see about itself. Never the PIN, never the slug. */
const shape = (b) => ({
  businessId: b.businessId,
  name: b.name,
  createdAt: b.createdAt,
});

/** POST /api/auth/register  { businessName, pin } */
export async function register(req, res) {
  requireFields(req.body, ['businessName', 'pin']);
  const { businessName } = req.body;
  const pin = assertValidPin(req.body.pin);

  const slug = toSlug(businessName);
  if (slug.length < 2) throw ApiError.badRequest('Business name must be at least 2 characters');

  // A shop called "superadmin" would be shadowed by the admin check in /signin,
  // and is an obvious impersonation vector. Refuse it outright.
  if (process.env.ADMIN_USERNAME && slug === toSlug(process.env.ADMIN_USERNAME)) {
    throw ApiError.conflict('That business name is reserved. Please choose another.');
  }

  // PRD 4: reject duplicates. Only LIVE shops count -- a deleted shop's name is
  // free again, and the new owner gets a fresh businessId so they cannot see any
  // of the previous owner's soft-deleted records.
  if (await Business.exists({ slug })) {
    throw ApiError.conflict('That business name is already registered. Try signing in instead.');
  }

  let business;
  try {
    business = await Business.create({ slug, name: String(businessName).trim(), pin });
  } catch (err) {
    // The partial unique index is the real guard when two phones race.
    if (err.code === 11000) {
      throw ApiError.conflict('That business name is already registered. Try signing in instead.');
    }
    throw err;
  }

  res.status(201).json({ ok: true, token: signBusinessToken(business), business: shape(business) });
}

/** POST /api/auth/login  { businessName, pin } */
export async function login(req, res) {
  requireFields(req.body, ['businessName', 'pin']);
  const slug = toSlug(req.body.businessName);

  // Deleted shops are excluded by the soft-delete middleware, so a deleted
  // business simply cannot sign in.
  const business = await Business.findOne({ slug }).select('+pin');

  // Same message and roughly the same work for "no such business" and "wrong
  // PIN", so the response cannot be used to enumerate registered businesses.
  const ok = business
    ? await business.verifyPin(req.body.pin)
    : await new Promise((r) => setTimeout(() => r(false), 60));
  if (!ok) throw ApiError.unauthorized('Incorrect business name or PIN');

  res.json({ ok: true, token: signBusinessToken(business), business: shape(business) });
}

/** GET /api/auth/me -- confirms the token is still good and returns dashboard counts. */
export async function me(req, res) {
  const business = await Business.findOne({ businessId: req.businessId });
  if (!business) throw ApiError.unauthorized('This business no longer exists');

  const [categories, products, orders] = await Promise.all([
    Category.countDocuments({ businessId: req.businessId }),
    Product.countDocuments({ businessId: req.businessId }),
    Order.countDocuments({ businessId: req.businessId }),
  ]);

  res.json({ ok: true, business: shape(business), counts: { categories, products, orders } });
}

/** PATCH /api/auth/business  { name } -- renaming is safe now that the key is opaque. */
export async function renameBusiness(req, res) {
  requireFields(req.body, ['name']);
  const name = String(req.body.name).trim();
  const slug = toSlug(name);
  if (slug.length < 2) throw ApiError.badRequest('Business name must be at least 2 characters');

  const clash = await Business.findOne({ slug });
  if (clash && clash.businessId !== req.businessId) {
    throw ApiError.conflict('Another business already uses that name');
  }

  try {
    // businessId is immutable, so none of this tenant's rows need rewriting.
    const business = await Business.findOneAndUpdate(
      { businessId: req.businessId },
      { name, slug },
      { new: true, runValidators: true }
    );
    if (!business) throw ApiError.unauthorized('This business no longer exists');
    res.json({ ok: true, business: shape(business) });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('Another business already uses that name');
    throw err;
  }
}

/** PATCH /api/auth/pin  { currentPin, newPin } */
export async function changePin(req, res) {
  requireFields(req.body, ['currentPin', 'newPin']);
  const newPin = assertValidPin(req.body.newPin, 'newPin');

  const business = await Business.findOne({ businessId: req.businessId }).select('+pin');
  if (!business) throw ApiError.unauthorized('This business no longer exists');
  if (!(await business.verifyPin(req.body.currentPin))) throw ApiError.unauthorized('Current PIN is incorrect');

  business.pin = newPin; // pre-save hook re-hashes
  await business.save();
  res.json({ ok: true, message: 'PIN updated' });
}

/** Constant-time string compare that does not leak length. */
function safeEqual(a = '', b = '') {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * POST /api/auth/signin   { identifier, secret }
 *
 * One endpoint for both account types, so the app needs a single login form
 * rather than asking the user to classify themselves before they have even typed
 * anything. The server knows which kind of credential it is holding; the client
 * does not need to guess.
 *
 * Admin is checked FIRST, and registration reserves the admin username, so a
 * shop can never shadow it. Every failure returns the same message and status,
 * so this cannot be used to discover which shops or usernames exist.
 */
export async function signIn(req, res) {
  requireFields(req.body, ['identifier', 'secret']);
  const identifier = String(req.body.identifier);
  const secret = String(req.body.secret);

  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  const adminConfigured = Boolean(adminUser && adminPass && !adminPass.includes('replace_me'));

  if (adminConfigured && safeEqual(identifier.trim(), adminUser)) {
    if (safeEqual(secret, adminPass)) {
      return res.json({
        ok: true,
        role: 'admin',
        token: signAdminToken(adminUser),
        admin: { username: adminUser },
      });
    }
    // Deliberately identical to the business failure below.
    throw ApiError.unauthorized('Incorrect name or PIN');
  }

  const business = await Business.findOne({ slug: toSlug(identifier) }).select('+pin');

  // Same message and roughly the same work whether the account is missing or the
  // secret is wrong.
  const ok = business
    ? await business.verifyPin(secret)
    : await new Promise((r) => setTimeout(() => r(false), 60));
  if (!ok) throw ApiError.unauthorized('Incorrect name or PIN');

  res.json({
    ok: true,
    role: 'business',
    token: signBusinessToken(business),
    business: shape(business),
  });
}

/** POST /api/auth/admin/login  { username, password } -- PRD 4, hardcoded via .env */
export async function adminLogin(req, res) {
  requireFields(req.body, ['username', 'password']);
  const user = process.env.ADMIN_USERNAME;
  const pass = process.env.ADMIN_PASSWORD;

  if (!user || !pass || pass.includes('replace_me')) {
    throw new ApiError(500, 'Super admin credentials are not configured in backend/.env');
  }
  if (!safeEqual(req.body.username, user) || !safeEqual(req.body.password, pass)) {
    throw ApiError.unauthorized('Invalid admin credentials');
  }
  res.json({ ok: true, token: signAdminToken(user), admin: { username: user } });
}
