import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import {
  listProducts, createProduct, updateProduct, adjustStock, deleteProduct,
  stocktake, getMovements,
} from '../controllers/productController.js';

const router = Router();
router.use(requireBusiness);

router.get('/', listProducts);
// Before '/:id' so a physical count is never read as a product id.
router.post('/stocktake', stocktake);
router.post('/', createProduct);
router.get('/:id/movements', getMovements);
router.patch('/:id/stock', adjustStock);
router.patch('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;
