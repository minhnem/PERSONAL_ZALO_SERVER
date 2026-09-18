import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { sendMessageToZalo, syncZaloContacts, closeAllBrowsers, sendGroupMemberMessageToZalo } from './playwright.worker.js';
import { sendMessageViaApi, sendFriendRequestViaApi, closeAllZaloApis } from './zalo-api.worker.js';
import { Campaign } from '../models/Campaign.js';
import { Blacklist } from '../models/Blacklist.js';

dotenv.config();

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null
});

console.log('[Queue Processor] Đang khởi động Worker lắng nghe hàng đợi...');

const worker = new Worker('ZaloMessages', async (job) => {
  console.log(`[Queue Processor] Bắt đầu xử lý Job ${job.id} - Tên Job: ${job.name}`);
  
  if (job.name === 'sendMessage') {
    const { accountId, to, message } = job.data;
    
    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] Tạm nghỉ ${delay/1000}s trước khi gửi cho ${to}...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    await sendMessageToZalo(accountId || 'default', to, message);
    console.log(`[Queue Processor] Đã gửi xong Job ${job.id}`);
  }

  if (job.name === 'sendCampaignMessage') {
    const { campaignId, accountId, contactId, to, message, imagePath, groupName, recipientName } = job.data;
    
    // Kiểm tra Blacklist
    const isBlacklisted = await Blacklist.findOne({ accountId: accountId || 'default', contactId: to });
    if (isBlacklisted) {
      console.log(`[Queue Processor] Bỏ qua ${to} vì nằm trong danh sách không nhận tin.`);
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "failed", "recipients.$.errorMessage": "Đã bỏ qua (Blacklist)" } }
        );
        
        // Kiểm tra xem chiến dịch đã hoàn tất toàn bộ chưa
        const checkCampaign = await Campaign.findById(campaignId);
        if (checkCampaign && !checkCampaign.recipients.some(r => r.status === 'pending')) {
          await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'completed' } });
        }
      }
      return; // Dừng xử lý job này
    }

    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] Tạm nghỉ ${delay/1000}s trước khi gửi cho ${to} (Chiến dịch)...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      if (groupName) {
        console.log(`[Queue Processor] Gọi luồng gửi tin Thành Viên Nhóm "${groupName}"...`);
        await sendGroupMemberMessageToZalo(accountId || 'default', groupName, to, message, imagePath);
      } else {
        console.log(`[Queue Processor] Gọi luồng gửi tin Danh Bạ thông thường...`);
        await sendMessageToZalo(accountId || 'default', to, message, imagePath, recipientName);
      }
      console.log(`[Queue Processor] Đã gửi xong Job ${job.id} (Chiến dịch)`);
      
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

  // ====== JOB MỚI: Gửi tin bằng zca-js API (UID trực tiếp, không cần browser) ======
  if (job.name === 'sendCampaignMessageV2') {
    const { campaignId, accountId, contactId, recipientUid, recipientName, message, imagePath, isFriendRequest, friendRequestMessage, isGroupTarget } = job.data;
    
    // Kiểm tra Blacklist
    const isBlacklisted = await Blacklist.findOne({ accountId: accountId || 'default', contactId: recipientUid });
    if (isBlacklisted) {
      console.log(`[Queue Processor] [API] Bỏ qua ${recipientUid} vì nằm trong danh sách không nhận tin.`);
      if (campaignId && contactId) {
        await Campaign.updateOne(
          { _id: campaignId, "recipients.contactId": contactId },
          { $set: { "recipients.$.status": "failed", "recipients.$.errorMessage": "Đã bỏ qua (Blacklist)" } }
        );

        // Kiểm tra xem chiến dịch đã hoàn tất toàn bộ chưa
        const checkCampaign = await Campaign.findById(campaignId);
        if (checkCampaign && !checkCampaign.recipients.some(r => r.status === 'pending')) {
          await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'completed' } });
        }
      }
      return; // Dừng xử lý job này
    }

    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] [API] Tạm nghỉ ${delay/1000}s trước khi xử lý Job cho UID ${recipientUid} (${recipientName})...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      if (isFriendRequest) {
        // Lệnh gửi kết bạn (Bọc try-catch để nếu lỗi do "đã là bạn bè" thì vẫn gửi tin nhắn thường)
        try {
          await sendFriendRequestViaApi(accountId || 'default', recipientUid, friendRequestMessage);
          console.log(`[Queue Processor] [API] Đã gửi kết bạn cho UID ${recipientUid}`);
        } catch (friendErr) {
          console.log(`[Queue Processor] [API] Bỏ qua lỗi kết bạn (có thể đã là bạn bè/đã gửi trước đó): ${friendErr.message}`);
        }
        
        // Nghỉ thêm 3 giây trước khi gửi tin nhắn chính
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      await sendMessageViaApi(accountId || 'default', recipientUid, message, imagePath, isGroupTarget);
      console.log(`[Queue Processor] [API] Đã gửi xong tin nhắn Job ${job.id} cho UID ${recipientUid}`);
      
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
