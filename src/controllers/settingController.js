import { SystemSetting } from '../models/SystemSetting.js';
import { restartAutoReminderCron } from '../scripts/cronAutoReminder.js';

export const getAutoReminderSettings = async (req, res) => {
  try {
    let setting = await SystemSetting.findOne({ key: 'auto_reminder_schedule' });
    if (!setting) {
      setting = {
        value: {
          isAutoRun: true,
          runTime: '08:00',
          startDate: '',
          hasEndDate: false,
          endDate: ''
        }
      };
    }
    res.json({ success: true, data: setting.value });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const saveAutoReminderSettings = async (req, res) => {
  try {
    const { isAutoRun, runTime, startDate, hasEndDate, endDate, allowedAccountIds } = req.body;
    
    const newValue = { isAutoRun, runTime, startDate, hasEndDate, endDate, allowedAccountIds };
    
    await SystemSetting.findOneAndUpdate(
      { key: 'auto_reminder_schedule' },
      { value: newValue },
      { new: true, upsert: true }
    );

    // Restart the cron with new settings
    await restartAutoReminderCron();

    res.json({ success: true, message: 'Lưu cấu hình thành công' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
