import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import {
  summary, salesTrend, byCategory, topProducts, lowStock, exportData,
} from '../controllers/reportController.js';

const router = Router();
router.use(requireBusiness);

router.get('/summary', summary);
router.get('/sales-trend', salesTrend);
router.get('/by-category', byCategory);
router.get('/top-products', topProducts);
router.get('/low-stock', lowStock);
router.get('/export', exportData);

export default router;
