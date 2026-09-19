import express from 'express';
import { getAllUsers, createUser, resetMachineId, extendLicense, updateStatus } from '../controllers/userController.js';
import { verifyToken, requireAdmin } from '../controllers/authController.js';

const router = express.Router();

// Tất cả các route quản lý người dùng đều yêu cầu đăng nhập và quyền Admin
router.use(verifyToken, requireAdmin);

router.get('/', getAllUsers);
router.post('/', createUser);
router.put('/:id/reset-machine', resetMachineId);
router.put('/:id/extend', extendLicense);
router.put('/:id/status', updateStatus);

export default router;
