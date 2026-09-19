import express from 'express';
import { getRules, saveRules, deleteRule } from '../controllers/reminderRuleController.js';

const router = express.Router();

router.get('/', getRules);
router.post('/', saveRules);
router.delete('/:id', deleteRule);

export default router;
