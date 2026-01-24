import { Router } from 'express';
import { UserController } from '../controllers/user.controller.js';

const router = Router();

// POST /api/user - Register or get user
router.post('/', UserController.getOrCreateUser);

// GET /api/user/:nametag - Get user by nametag
router.get('/:nametag', UserController.getUser);

export default router;
