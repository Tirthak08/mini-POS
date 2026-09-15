import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import {
  listCustomers, createCustomer, updateCustomer, deleteCustomer,
  getCustomer, recordPayment,
} from '../controllers/customerController.js';

const router = Router();
router.use(requireBusiness);

router.get('/', listCustomers);
router.post('/', createCustomer);
router.get('/:id', getCustomer);
router.patch('/:id', updateCustomer);
router.delete('/:id', deleteCustomer);
router.post('/:id/payments', recordPayment);

export default router;
