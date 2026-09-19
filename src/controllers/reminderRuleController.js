import { ReminderRule } from '../models/ReminderRule.js';

export const getRules = async (req, res) => {
  try {
    const rules = await ReminderRule.find().sort({ createdAt: -1 });
    res.json({ success: true, data: rules });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const saveRules = async (req, res) => {
  try {
    const { rules } = req.body;
    
    if (!rules || !Array.isArray(rules)) {
      return res.status(400).json({ success: false, error: 'Dữ liệu không hợp lệ' });
    }

    const savedRules = [];
    for (const ruleData of rules) {
      if (!ruleData.productName) continue;
      
      const rule = await ReminderRule.findOneAndUpdate(
        { productName: ruleData.productName },
        { ...ruleData },
        { new: true, upsert: true }
      );
      savedRules.push(rule);
    }

    res.json({ success: true, data: savedRules });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const deleteRule = async (req, res) => {
  try {
    await ReminderRule.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Đã xóa cấu hình kịch bản' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
