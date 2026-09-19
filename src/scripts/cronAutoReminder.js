import cron from 'node-cron';
import { Customer } from '../models/Customer.js';
import { ReminderRule } from '../models/ReminderRule.js';
import { Account } from '../models/Account.js';
import { Contact } from '../models/Contact.js';
import { SystemSetting } from '../models/SystemSetting.js';
import { zaloMessageQueue } from '../config/queue.js';

let cronTask = null;

// Khởi tạo Cronjob dựa trên cấu hình trong DB
export const initAutoReminderCron = async () => {
  if (cronTask) {
    cronTask.stop();
    console.log('[CronJob] Đã dừng lịch cũ.');
  }

  try {
    let setting = await SystemSetting.findOne({ key: 'auto_reminder_schedule' });
    const config = setting ? setting.value : { isAutoRun: true, runTime: '08:00' };

    if (!config.isAutoRun) {
      console.log('[CronJob] Chế độ chạy tự động đang TẮT.');
      return;
    }

    const [hour, minute] = (config.runTime || '08:00').split(':');
    const cronStr = `${minute || '0'} ${hour || '8'} * * *`;

    cronTask = cron.schedule(cronStr, async () => {
      console.log(`[CronJob] Bắt đầu quét khách hàng đến hạn nhắc mua lại lúc ${config.runTime}...`);
      await processAutoReminders(config);
    });
    
    console.log(`[CronJob] Đã thiết lập lịch quét Nhắc Mua Lại tự động vào ${config.runTime} hàng ngày.`);
  } catch (err) {
    console.error('[CronJob] Lỗi khởi tạo lịch:', err);
  }
};

export const restartAutoReminderCron = async () => {
  console.log('[CronJob] Yêu cầu Restart lịch chạy tự động từ API...');
  await initAutoReminderCron();
};

export const processAutoReminders = async (config) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Kiểm tra giới hạn ngày (startDate, endDate)
    if (config.startDate) {
      const start = new Date(config.startDate);
      start.setHours(0,0,0,0);
      if (today < start) {
        console.log('[CronJob] Chưa đến ngày bắt đầu chiến dịch.');
        return;
      }
    }

    if (config.hasEndDate && config.endDate) {
      const end = new Date(config.endDate);
      end.setHours(23,59,59,999);
      if (today > end) {
        console.log('[CronJob] Đã vượt quá ngày kết thúc chiến dịch.');
        return;
      }
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const customers = await Customer.find({
      'trackedProducts': {
        $elemMatch: {
          expectedEmptyDate: {
            $gte: startOfToday,
            $lte: endOfToday
          },
          hasReminded: false
        }
      }
    });

    if (customers.length === 0) {
      console.log('[CronJob] Không có sản phẩm nào đến hạn nhắc hôm nay.');
      return;
    }

    console.log(`[CronJob] Tìm thấy ${customers.length} khách hàng cần nhắc. Đang chuẩn bị gửi...`);

    for (const customer of customers) {
      for (const product of customer.trackedProducts) {
        const isToday = product.expectedEmptyDate >= startOfToday && product.expectedEmptyDate <= endOfToday;
        
        if (isToday && !product.hasReminded) {
          const rule = await ReminderRule.findOne({ productName: product.productName });
          if (!rule) continue;

          let messageContent = rule.messageContent || '';
          messageContent = messageContent.replace(/{name}/g, customer.name);
          messageContent = messageContent.replace(/{product}/g, product.productName);

          const contactInfo = await Contact.findOne({ phoneNumber: customer.phone });
          const recipientUid = contactInfo ? contactInfo.zaloId : null;

          console.log(`[CronJob] Đẩy Job nhắc khách ${customer.name} (SĐT: ${customer.phone}) vào Queue...`);
          
          await zaloMessageQueue.add('sendAutoReminderMessage', {
            customerId: customer._id.toString(),
            productId: product._id.toString(),
            productName: product.productName,
            phoneNumber: customer.phone,
            recipientUid: recipientUid,
            recipientName: customer.name,
            message: messageContent,
            imagePath: rule.attachedImage,
            allowedAccountIds: config.allowedAccountIds || [],
            timestamp: Date.now()
          });
        }
      }
    }
  } catch (error) {
    console.error('[CronJob] Lỗi quét tự động:', error);
  }
};
