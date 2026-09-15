import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import { exportBackup, restoreBackup, backupStatus } from '../controllers/backupController.js';

const router = Router();
router.use(requireBusiness);

router.get('/status', backupStatus);
router.get('/export', exportBackup);
router.post('/restore', restoreBackup);

export default router;
