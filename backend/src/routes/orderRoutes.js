import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import { checkout, listOrders, getOrder, updateOrder, voidOrder } from '../controllers/orderController.js';

const router = Router();
router.use(requireBusiness);

router.post('/', checkout);
router.get('/', listOrders);
router.get('/:id', getOrder);
router.patch('/:id', updateOrder);
router.delete('/:id', voidOrder);

export default router;
