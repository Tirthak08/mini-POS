import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import {
  listProducts, createProduct, updateProduct, adjustStock, deleteProduct,
} from '../controllers/productController.js';

const router = Router();
router.use(requireBusiness);

router.get('/', listProducts);
router.post('/', createProduct);
router.patch('/:id/stock', adjustStock);
router.patch('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;
