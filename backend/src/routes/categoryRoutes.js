import { Router } from 'express';
import { requireBusiness } from '../middleware/auth.js';
import {
  listCategories, createCategory, updateCategory, deleteCategory,
} from '../controllers/categoryController.js';

const router = Router();
router.use(requireBusiness); // every route below is tenant-scoped

router.get('/', listCategories);
router.post('/', createCategory);
router.patch('/:id', updateCategory);
router.delete('/:id', deleteCategory);

export default router;
