import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  listBusinesses, getBusiness, deleteBusiness, restoreBusiness, purgeBusiness, platformStats,
} from '../controllers/adminController.js';

const router = Router();
router.use(requireAdmin);

router.get('/stats', platformStats);
router.get('/businesses', listBusinesses);
router.get('/businesses/:businessId', getBusiness);
router.delete('/businesses/:businessId/purge', purgeBusiness); // must precede /:businessId
router.post('/businesses/:businessId/restore', restoreBusiness);
router.delete('/businesses/:businessId', deleteBusiness);

export default router;
