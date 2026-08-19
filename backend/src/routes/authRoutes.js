import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireBusiness } from '../middleware/auth.js';
import {
  register, login, signIn, me, changePin, renameBusiness, adminLogin,
} from '../controllers/authController.js';

const router = Router();

/** Rate limits exist for production; they only make the test suite flaky. */
const skipInTests = () => process.env.NODE_ENV === 'test';

/**
 * Per-ACCOUNT limit. This is the one that matters: a 4-digit PIN is only 10,000
 * combinations, so the defence has to be tied to the account being attacked.
 * Keying on the identifier also means a whole shop behind one Wi-Fi router is
 * not locked out because a different account was attacked from the same IP.
 */
const perAccountLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: (req) => {
    const id = req.body?.identifier ?? req.body?.businessName ?? req.body?.username ?? '';
    const normalised = String(id).trim().replace(/\s+/g, ' ').toLowerCase();
    return `account:${normalised || 'anonymous'}`;
  },
  message: {
    ok: false,
    error: 'Too many attempts for this account. Wait a few minutes and try again.',
  },
});

/**
 * Per-IP limit, deliberately looser: several staff on one shop's Wi-Fi share an
 * address, and locking the shop out is worse than the flood it would prevent.
 * It exists only to stop one host hammering many accounts.
 */
const perIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipInTests,
  message: { ok: false, error: 'Too many requests from this device. Try again shortly.' },
});

const credentials = [perIpLimiter, perAccountLimiter];

// One form for shops and the super admin; the server decides which it is.
router.post('/signin', ...credentials, signIn);
router.post('/register', ...credentials, register);

// Kept for compatibility and for anything scripting the API directly.
router.post('/login', ...credentials, login);
router.post('/admin/login', ...credentials, adminLogin);

router.get('/me', requireBusiness, me);
router.patch('/pin', ...credentials, requireBusiness, changePin);
router.patch('/business', requireBusiness, renameBusiness);

export default router;
