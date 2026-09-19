import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { sendMessageToZalo, syncZaloContacts, closeAllBrowsers, sendGroupMemberMessageToZalo } from './playwright.worker.js';
import { sendMessageViaApi, sendFriendRequestViaApi, closeAllZaloApis } from './zalo-api.worker.js';
import { Campaign } from '../models/Campaign.js';
import { Blacklist } from '../models/Blacklist.js';
import { Customer } from '../models/Customer.js';
import { ReminderLog } from '../models/ReminderLog.js';
import { getAvailableAccount, incrementDailyCount } from '../services/accountService.js';

dotenv.config();

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null
});

console.log('[Queue Processor] Đang khởi động Worker lắng nghe hàng đợi...');

const worker = new Worker('ZaloMessages', async (job) => {
  console.log(`[Queue Processor] Bắt đầu xử lý Job ${job.id} - Tên Job: ${job.name}`);
  
  if (job.name === 'sendMessage') {
    const { to, message } = job.data;
    
    const accountId = await getAvailableAccount();
    if (!accountId) {
      throw new Error('Vượt quá giới hạn gửi tin 30 tin/ngày của tất cả tài khoản Zalo. Không thể gửi.');
    }

    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] Tạm nghỉ ${delay/1000}s trước khi gửi cho ${to} bằng tài khoản ${accountId}...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    await sendMessageToZalo(accountId, to, message);
    await incrementDailyCount(accountId);
  }

  if (job.name === 'sendCampaignMessage') {
    const { campaignId, accountId: assignedAccountId, contactId, to, message, imagePath, groupName, recipientName } = job.data;
    
    // Kiểm tra Global Blacklist
    const isBlacklisted = await Blacklist.findOne({ contactId: to });
    if (isBlacklisted) {
      console.log(`[Queue Processor] Bỏ qua ${to} vì nằm trong danh sách Blacklist (Global).`);
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "failed", "recipients.$.errorMessage": "Đã bỏ qua (Blacklist chung)" } }
        );
        
        const checkCampaign = await Campaign.findById(campaignId);
        if (checkCampaign && !checkCampaign.recipients.some(r => r.status === 'pending')) {
          await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'completed' } });
        }
      }
      return; 
    }

    // Tôn trọng tài khoản đã được chỉ định từ giao diện Tạo Chiến Dịch
    const accountId = assignedAccountId || 'default';

    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] Tạm nghỉ ${delay/1000}s trước khi gửi cho ${to} (Chiến dịch, qua nick ${accountId})...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      if (groupName) {
        console.log(`[Queue Processor] Gọi luồng gửi tin Thành Viên Nhóm "${groupName}"...`);
        await sendGroupMemberMessageToZalo(accountId, groupName, to, message, imagePath);
      } else {
        console.log(`[Queue Processor] Gọi luồng gửi tin Danh Bạ thông thường...`);
        await sendMessageToZalo(accountId, to, message, imagePath, recipientName);
      }
      console.log(`[Queue Processor] Đã gửi xong Job ${job.id} (Chiến dịch)`);
      
      await incrementDailyCount(accountId);

      // Cập nhật trạng thái thành công trong DB
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "sent" } }
        );
      }
    } catch (err) {
      // Cập nhật trạng thái lỗi trong DB
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "failed", "recipients.$.errorMessage": err.message } }
        );
      }
      throw err;
    } finally {
      // Kiểm tra xem chiến dịch đã hoàn tất toàn bộ chưa
      if (campaignId) {
        const checkCampaign = await Campaign.findById(campaignId);
        if (checkCampaign && !checkCampaign.recipients.some(r => r.status === 'pending')) {
          await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'completed' } });
        }
      }
    }
  }
  
  if (job.name === 'syncContacts') {
    console.log(`[Queue Processor] Yêu cầu quét danh bạ cho tài khoản ${job.data.accountId}`);
    await syncZaloContacts(job.data.accountId);
  }

  // ====== JOB MỚI: Nhắc mua lại tự động ======
  if (job.name === 'sendAutoReminderMessage') {
    const { customerId, productId, productName, phoneNumber, recipientUid, recipientName, message, imagePath, allowedAccountIds } = job.data;
    
    const contactIdToCheck = recipientUid || phoneNumber;
    const isBlacklisted = await Blacklist.findOne({ contactId: contactIdToCheck });
    if (isBlacklisted) {
      console.log(`[Queue Processor] [AutoReminder] Bỏ qua ${recipientName} vì nằm trong Global Blacklist.`);
      return;
    }

    const accountId = await getAvailableAccount(allowedAccountIds);
    if (!accountId) {
      throw new Error('Tất cả tài khoản Zalo đã đạt giới hạn 30 tin/ngày. Vui lòng thử lại vào ngày mai.');
    }

    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] [AutoReminder] Tạm nghỉ ${delay/1000}s trước khi nhắc ${recipientName} bằng nick ${accountId}...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      if (recipientUid) {
        console.log(`[Queue Processor] [AutoReminder] Gửi qua API ZCA bằng UID: ${recipientUid}`);
        await sendMessageViaApi(accountId, recipientUid, message, imagePath, false);
      } else {
        console.log(`[Queue Processor] [AutoReminder] Không có UID, dùng Playwright quét SĐT: ${phoneNumber}`);
        await sendMessageToZalo(accountId, phoneNumber, message, imagePath, recipientName);
      }
      
      console.log(`[Queue Processor] [AutoReminder] Đã gửi thành công nhắc nhở cho ${recipientName}`);
      
      await incrementDailyCount(accountId);

      await Customer.updateOne(
        { _id: customerId, "trackedProducts._id": productId },
        { $set: { "trackedProducts.$.hasReminded": true } }
      );

      await ReminderLog.create({
        customerId,
        customerName: recipientName,
        phone: phoneNumber,
        productName,
        accountId,
        status: 'success'
      });
    } catch (err) {
      console.error(`[Queue Processor] [AutoReminder] Lỗi gửi nhắc nhở:`, err.message);
      try {
        await ReminderLog.create({
          customerId,
          customerName: recipientName,
          phone: phoneNumber,
          productName,
          accountId: accountId || 'Chưa rõ',
          status: 'failed',
          errorMessage: err.message
        });
      } catch (logErr) {}
      throw err;
    }
  }

  // ====== JOB MỚI: Gửi tin bằng zca-js API (UID trực tiếp, không cần browser) ======
  if (job.name === 'sendCampaignMessageV2') {
    const { campaignId, accountId: assignedAccountId, contactId, recipientUid, recipientName, message, imagePath, isFriendRequest, friendRequestMessage, isGroupTarget } = job.data;
    
    // Kiểm tra Global Blacklist
    const isBlacklisted = await Blacklist.findOne({ contactId: recipientUid });
    if (isBlacklisted) {
      console.log(`[Queue Processor] [API] Bỏ qua ${recipientUid} vì nằm trong danh sách không nhận tin.`);
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "failed", "recipients.$.errorMessage": "Đã bỏ qua (Global Blacklist)" } }
        );

        const checkCampaign = await Campaign.findById(campaignId);
        if (checkCampaign && !checkCampaign.recipients.some(r => r.status === 'pending')) {
          await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'completed' } });
        }
      }
      return; 
    }

    // Tôn trọng tài khoản đã được chỉ định từ giao diện Tạo Chiến Dịch
    const accountId = assignedAccountId || 'default';

    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] [API] Tạm nghỉ ${delay/1000}s trước khi xử lý Job cho UID ${recipientUid} bằng nick ${accountId}...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      if (isFriendRequest) {
        try {
          await sendFriendRequestViaApi(accountId, recipientUid, friendRequestMessage);
          console.log(`[Queue Processor] [API] Đã gửi kết bạn cho UID ${recipientUid}`);
        } catch (friendErr) {
          console.log(`[Queue Processor] [API] Bỏ qua lỗi kết bạn: ${friendErr.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      await sendMessageViaApi(accountId, recipientUid, message, imagePath, isGroupTarget);
      console.log(`[Queue Processor] [API] Đã gửi xong tin nhắn Job ${job.id} cho UID ${recipientUid}`);
      
      await incrementDailyCount(accountId);

      // Cập nhật trạng thái thành công trong DB
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "sent" } }
        );
      }
    } catch (err) {
      // Cập nhật trạng thái lỗi trong DB
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "failed", "recipients.$.errorMessage": err.message } }
        );
      }
      throw err;
    } finally {
      // Kiểm tra xem chiến dịch đã hoàn tất toàn bộ chưa
      if (campaignId) {
        const checkCampaign = await Campaign.findById(campaignId);
        if (checkCampaign && !checkCampaign.recipients.some(r => r.status === 'pending')) {
          await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'completed' } });
        }
      }
    }
  }

}, { connection });

worker.on('completed', job => {
  console.log(`[Queue Processor] Job ${job.id} đã hoàn thành thành công.`);
});

worker.on('failed', (job, err) => {
  console.error(`[Queue Processor] Job ${job.id} bị lỗi: ${err.message}`);
});

import { Queue } from 'bullmq';
const queue = new Queue('ZaloMessages', { connection });

// TỰ ĐỘNG TẮT TRÌNH DUYỆT VÀ DỌN RÁC KHI HẾT VIỆC
worker.on('drained', async () => {
  console.log('[Queue Processor] Hàng đợi đã trống. Đang đóng tất cả trình duyệt và API ngầm để giải phóng tài nguyên...');
  await closeAllBrowsers();
  await closeAllZaloApis();

  try {
    // Lấy danh sách các jobs đang chờ hoặc đang chạy (đề phòng)
    const waiting = await queue.getWaiting();
    const active = await queue.getActive();
    const delayed = await queue.getDelayed();
    const allJobs = [...waiting, ...active, ...delayed];
    
    const activeImagePaths = allJobs.map(j => j.data?.imagePath).filter(Boolean);
    
    // Quét thư mục uploads
    const uploadsDir = path.resolve('uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      let deletedCount = 0;
      for (const file of files) {
        const fullPath = path.join(uploadsDir, file);
        // Nếu file ảnh không còn nằm trong bất kỳ job nào đang chờ/chạy -> Xóa
        if (!activeImagePaths.includes(fullPath)) {
          fs.unlinkSync(fullPath);
          deletedCount++;
        }
      }
      if (deletedCount > 0) {
        console.log(`[Queue Processor] Đã dọn dẹp tự động ${deletedCount} file ảnh rác trong thư mục uploads.`);
      }
    }
  } catch (err) {
    console.error(`[Queue Processor] Lỗi khi dọn dẹp file uploads:`, err.message);
  }
});
