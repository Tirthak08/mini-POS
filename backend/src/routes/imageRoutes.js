import { Router } from 'express';
import { requireBusiness, requireBusinessForMedia } from '../middleware/auth.js';
import { uploadImage, getImage, deleteImage, imageUsage } from '../controllers/imageController.js';

const router = Router();

// GET is the only route that accepts ?token=, because React Native's <Image>
// cannot always attach an Authorization header (notably on web).
router.get('/usage', requireBusiness, imageUsage);
router.get('/:id', requireBusinessForMedia, getImage);

router.post('/', requireBusiness, uploadImage);
router.delete('/:id', requireBusiness, deleteImage);

export default router;
