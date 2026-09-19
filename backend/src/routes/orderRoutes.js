import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import { checkout, listOrders, getOrder, updateOrder, voidOrder } from '../controllers/orderController.js';
import { createReturn, listOrderReturns } from '../controllers/returnController.js';

const router = Router();
router.use(requireBusiness);

router.post('/', checkout);
router.get('/', listOrders);
router.get('/:id', getOrder);
router.patch('/:id', updateOrder);
router.delete('/:id', voidOrder);

/* Returns hang off the receipt they came from, because that is the only place
   the quantities can be judged -- you cannot return four of something that was
   sold three of, and the receipt is what says three. */
router.post('/:id/returns', createReturn);
router.get('/:id/returns', listOrderReturns);

export default router;
