import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import { deletePayment } from '../controllers/customerController.js';

/**
 * Only one route, and it is not under /customers/:id because undoing a
 * repayment needs nothing but the payment's own id -- the customer is on the
 * row. Nesting it would make the client carry a customer id it does not need.
 */
const router = Router();
router.use(requireBusiness);
router.delete('/:id', deletePayment);

export default router;
