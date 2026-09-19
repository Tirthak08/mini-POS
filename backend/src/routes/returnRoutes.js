import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import { listReturns, undoReturn } from '../controllers/returnController.js';

const router = Router();
router.use(requireBusiness);

router.get('/', listReturns);
router.delete('/:id', undoReturn);

export default router;
