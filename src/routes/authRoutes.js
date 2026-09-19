import express from 'express';
import { login, verifyHeartbeat, verifyToken } from '../controllers/authController.js';

const router = express.Router();

// Public route cho Desktop App đăng nhập
router.post('/login', login);

// Protected route cho Desktop App kiểm tra định kỳ (Heartbeat)
router.post('/verify', verifyToken, verifyHeartbeat);

export default router;
