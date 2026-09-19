import express from 'express';
import { getAutoReminderSettings, saveAutoReminderSettings } from '../controllers/settingController.js';

const router = express.Router();

router.get('/auto-reminder', getAutoReminderSettings);
router.post('/auto-reminder', saveAutoReminderSettings);

export default router;
