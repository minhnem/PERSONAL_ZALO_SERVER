import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import { sendMessageToZalo, syncZaloContacts, closeAllBrowsers, sendGroupMemberMessageToZalo } from './playwright.worker.js';
import { sendMessageViaApi, closeAllZaloApis } from './zalo-api.worker.js';
import { Campaign } from '../models/Campaign.js';

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
    const { campaignId, accountId, contactId, to, message, imagePath, groupName } = job.data;
    
    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] Tạm nghỉ ${delay/1000}s trước khi gửi cho ${to} (Chiến dịch)...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      if (groupName) {
        console.log(`[Queue Processor] Gọi luồng gửi tin Thành Viên Nhóm "${groupName}"...`);
        await sendGroupMemberMessageToZalo(accountId || 'default', groupName, to, message, imagePath);
      } else {
        console.log(`[Queue Processor] Gọi luồng gửi tin Danh Bạ thông thường...`);
        await sendMessageToZalo(accountId || 'default', to, message, imagePath);
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
    const { campaignId, accountId, contactId, recipientUid, recipientName, message, imagePath } = job.data;
    
    const delay = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    console.log(`[Queue Processor] [API] Tạm nghỉ ${delay/1000}s trước khi gửi cho UID ${recipientUid} (${recipientName})...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      await sendMessageViaApi(accountId || 'default', recipientUid, message, imagePath);
      console.log(`[Queue Processor] [API] Đã gửi xong Job ${job.id} cho UID ${recipientUid}`);
      
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

// TỰ ĐỘNG TẮT TRÌNH DUYỆT KHI HẾT VIỆC (Tránh lỗi đá ping-pong session)
worker.on('drained', async () => {
  console.log('[Queue Processor] Hàng đợi đã trống. Đang đóng tất cả trình duyệt và API ngầm để giải phóng tài nguyên...');
  await closeAllBrowsers();
  await closeAllZaloApis();
});
