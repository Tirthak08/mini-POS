import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import {
  listExpenses, createExpense, updateExpense, deleteExpense,
} from '../controllers/expenseController.js';

const router = Router();
router.use(requireBusiness); // every route below is tenant-scoped

router.get('/', listExpenses);
router.post('/', createExpense);
router.patch('/:id', updateExpense);
router.delete('/:id', deleteExpense);

export default router;
