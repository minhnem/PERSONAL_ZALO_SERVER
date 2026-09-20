import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { zaloMessageQueue } from '../config/queue.js';
import { Contact } from '../models/Contact.js';
import { Account } from '../models/Account.js';
import { Campaign } from '../models/Campaign.js';
import { Group } from '../models/Group.js';
import { GroupMember } from '../models/GroupMember.js';
import { Blacklist } from '../models/Blacklist.js';
import { ReminderLog } from '../models/ReminderLog.js';
import customerRoutes from './customerRoutes.js';
import reminderRuleRoutes from './reminderRuleRoutes.js';
import settingRoutes from './settingRoutes.js';
import authRoutes from './authRoutes.js';
import userRoutes from './userRoutes.js';

// Đảm bảo thư mục uploads tồn tại
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Cấu hình Multer để lưu file tạm
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'campaign-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

const router = express.Router();

// CRM Auto Reminder Routes
router.use('/customers', customerRoutes);
router.use('/reminder-rules', reminderRuleRoutes);
router.use('/settings', settingRoutes);

// License Server Routes
router.use('/auth', authRoutes);
router.use('/admin/users', userRoutes);

router.get('/status', (req, res) => {
  res.json({ status: 'OK', message: 'AutoZalo API is running' });
});

router.get('/reminder-logs', async (req, res) => {
  try {
    const logs = await ReminderLog.find().sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/send-message', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing to or message' });
  }

  try {
    // Đẩy vào hàng đợi (Job)
    const job = await zaloMessageQueue.add('sendMessage', {
      accountId: req.body.accountId || 'default',
      to,
      message,
      timestamp: Date.now()
    });

    res.json({
      success: true,
      message: 'Tin nhắn đã được đưa vào hàng đợi chờ gửi',
      jobId: job.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get accounts
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await Account.find({});
    // [BỔ SUNG] Kiểm tra xem tài khoản có đang bận chạy Campaign ngầm hay không
    const accountsWithWorkerStatus = await Promise.all(accounts.map(async (acc) => {
      const runningCampaigns = await Campaign.find({ accountId: acc.phoneNumber, status: 'running' });
      // Cờ chỉ bật nếu có Campaign đang chạy MÀ VẪN CÒN người nhận đang chờ (pending)
      const isActuallyRunning = runningCampaigns.some(c => c.recipients.some(r => r.status === 'pending'));

      return {
        ...acc.toObject(),
        isWorkerRunning: isActuallyRunning
      };
    }));
    res.json({ success: true, data: accountsWithWorkerStatus });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Create placeholder account
router.post('/accounts', async (req, res) => {
  try {
    const { phoneNumber, name } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Missing phoneNumber' });

    const newAccount = new Account({
      phoneNumber,
      name: name || phoneNumber,
      sessionFolder: `./userData/zalo_${phoneNumber}`,
      status: 'disconnected'
    });
    await newAccount.save();

    res.json({ success: true, data: newAccount });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Delete account
router.delete('/accounts/:id', async (req, res) => {
  try {
    const accountId = req.params.id;
    await Account.findOneAndDelete({ phoneNumber: accountId });

    // Giải phóng rác: Xóa toàn bộ danh bạ liên quan đến tài khoản này
    await Contact.deleteMany({ accountId: accountId });

    // Giải phóng rác: Xóa toàn bộ chiến dịch chạy dở liên quan đến tài khoản này
    await Campaign.deleteMany({ accountId: accountId });

    // Giải phóng rác: Xóa toàn bộ nhóm liên quan đến tài khoản này
    await Group.deleteMany({ accountId: accountId });

    res.json({ success: true, message: 'Đã xóa tài khoản và giải phóng bộ nhớ DB' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get account status (For Polling)
router.get('/accounts/status/:id', async (req, res) => {
  try {
    const account = await Account.findOne({ phoneNumber: req.params.id });
    if (!account) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, status: account.status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Create and Start a Campaign
router.post('/campaigns', upload.single('image'), async (req, res) => {
  try {
    let { accountId, accountIds, limitPerAccount, name, messageTemplate, recipients, groupName } = req.body;

    let targetAccountIds = [];
    if (accountIds) {
      targetAccountIds = JSON.parse(accountIds);
    } else if (accountId) {
      targetAccountIds = [accountId];
    }

    const limit = limitPerAccount ? parseInt(limitPerAccount, 10) : 999999;

    // Parse recipients if it's sent as a JSON string from FormData
    if (typeof recipients === 'string') {
      recipients = JSON.parse(recipients);
    }

    if (targetAccountIds.length === 0 || !messageTemplate || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    // Lấy đường dẫn file ảnh nếu có
    const imagePath = req.file ? req.file.path : null;

    let currentIndex = 0;
    const campaignIds = [];
    const processedContactIds = [];

    for (const accId of targetAccountIds) {
      if (currentIndex >= recipients.length) break;
      const chunk = recipients.slice(currentIndex, currentIndex + limit);
      if (chunk.length === 0) continue;
      
      const dbRecipients = chunk.map(c => ({
        contactId: c.id,
        name: c.name,
        status: 'pending'
      }));

      const campaignName = targetAccountIds.length > 1 ? `${name || 'Chiến dịch'} - ${accId}` : (name || `Chiến dịch ${new Date().toLocaleString('vi-VN')}`);
      
      const campaign = new Campaign({
        accountId: accId,
        name: campaignName,
        messageTemplate,
        recipients: dbRecipients,
        status: 'running'
      });
      await campaign.save();
      campaignIds.push(campaign._id);
      processedContactIds.push(...chunk.map(c => c.id));

      // Dispatch jobs to Queue
      for (const recipient of chunk) {
        await zaloMessageQueue.add('sendCampaignMessage', {
          campaignId: campaign._id,
          accountId: accId,
          contactId: recipient.id,
          to: recipient.id, // MUST search by phone number!
          recipientName: recipient.name, // Giữ lại tên thật để dùng cá nhân hóa {name}
          message: messageTemplate,
          imagePath: imagePath,
          groupName: groupName,
          timestamp: Date.now()
        });
      }
      
      currentIndex += limit;
    }

    res.json({ 
      success: true, 
      message: `Đã bắt đầu ${campaignIds.length} chiến dịch gửi tới ${processedContactIds.length} người.`, 
      campaignIds,
      processedContactIds
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get contacts
router.get('/contacts', async (req, res) => {
  try {
    // Nếu có accountId thì query, nếu không thì lấy tất cả (hoặc một account mặc định)
    const query = req.query.accountId ? { accountId: req.query.accountId } : {};
    const contacts = await Contact.find(query);

    // Map về đúng chuẩn Frontend đang dùng
    const data = contacts.map(c => ({
      id: c.zaloId, // map sang id cho UI
      name: c.name,
      type: c.type,
      tags: c.tags,
      avatar: c.avatar
    }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================================================================
// BLACKLIST API ENDPOINTS
// ========================================================================================

// API: Get blacklist for an account
router.get('/blacklist', async (req, res) => {
  try {
    const query = req.query.accountId ? { accountId: req.query.accountId } : {};
    const blacklist = await Blacklist.find(query).sort({ createdAt: -1 });
    res.json({ success: true, data: blacklist });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Add to blacklist
router.post('/blacklist', async (req, res) => {
  try {
    const { accountId, contactId, name, avatar } = req.body;
    if (!accountId || !contactId) return res.status(400).json({ error: 'Missing accountId or contactId' });

    const newBlacklist = new Blacklist({
      accountId,
      contactId,
      name: name || 'Không tên',
      avatar: avatar || ''
    });

    await newBlacklist.save();
    res.json({ success: true, message: 'Đã thêm vào danh sách không nhận tin', data: newBlacklist });
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key error
      return res.status(400).json({ success: false, error: 'Người này đã có trong danh sách không nhận tin' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Remove from blacklist
router.delete('/blacklist/:contactId', async (req, res) => {
  try {
    const contactId = req.params.contactId;
    const accountId = req.query.accountId;
    
    if (!accountId) return res.status(400).json({ error: 'Missing accountId' });

    await Blacklist.findOneAndDelete({ accountId, contactId });
    res.json({ success: true, message: 'Đã gỡ khỏi danh sách không nhận tin' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Import the functions from playwright worker
import { getLoginQRCode, closeBrowser, syncZaloContacts, syncZaloGroups, syncGroupMembers } from '../scripts/playwright.worker.js';

// Import the functions from zca-js worker (API trực tiếp, không cần browser)
import {
  initZaloApi, syncFriendsViaApi, syncGroupsViaApi,
  syncGroupMembersViaApi, sendMessageViaApi,
  extractCredentialsFromPlaywright, getZaloApiStatus,
  closeZaloApi
} from '../scripts/zalo-api.worker.js';

// API: Trigger contact sync (Synchronous execution for Smart Yield)
router.post('/accounts/sync', async (req, res) => {
  const { accountId } = req.body;
  try {
    if (!accountId) throw new Error('Thiếu accountId');

    // Chạy trực tiếp hàm quét danh bạ (Đồng bộ)
    await syncZaloContacts(accountId);

    // Tắt ngay trình duyệt sau khi quét xong để trả quyền cho Desktop App
    await closeBrowser(accountId);

    res.json({ success: true, message: 'Đã quét và đồng bộ danh bạ thành công' });
  } catch (error) {
    // Đảm bảo đóng trình duyệt nếu có lỗi
    if (accountId) {
      await closeBrowser(accountId).catch(() => console.error("Failed to close browser on error"));
    }
    res.status(500).json({ error: error.message });
  }
});

// API: Trigger group sync (Synchronous execution for Smart Yield)
router.post('/accounts/sync-groups', async (req, res) => {
  const { accountId } = req.body;
  try {
    if (!accountId) throw new Error('Thiếu accountId');

    await syncZaloGroups(accountId);
    await closeBrowser(accountId);

    res.json({ success: true, message: 'Đã quét và đồng bộ nhóm thành công' });
  } catch (error) {
    if (accountId) {
      await closeBrowser(accountId).catch(() => console.error("Failed to close browser on error"));
    }
    res.status(500).json({ error: error.message });
  }
});

// API: Trigger group members sync
router.post('/accounts/sync-group-members', async (req, res) => {
  const { accountId, groupId, groupName } = req.body;
  try {
    if (!accountId || !groupId || !groupName) throw new Error('Thiếu accountId, groupId hoặc groupName');

    await syncGroupMembers(accountId, groupId, groupName);
    await closeBrowser(accountId);

    res.json({ success: true, message: 'Đã quét và đồng bộ thành viên nhóm thành công' });
  } catch (error) {
    if (accountId) {
      await closeBrowser(accountId).catch(() => console.error("Failed to close browser on error"));
    }
    res.status(500).json({ error: error.message });
  }
});

// API: Sync session from Electron to Playwright (Bằng cách Copy Profile Vật Lý)
router.post('/accounts/sync-session', async (req, res) => {
  try {
    const { accountId, name } = req.body;
    if (!accountId) {
      return res.status(400).json({ success: false, error: 'Thiếu dữ liệu accountId' });
    }

    // Thực hiện copy thư mục Partition từ Electron sang Playwright
    const appData = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + '/.config');
    const sourceDir = path.join(appData, 'desktop-app', 'Partitions', `zalo_${accountId.toLowerCase()}`);
    const destDir = path.resolve(`./userData/zalo_${accountId}/Default`);

    if (!fs.existsSync(sourceDir)) {
      return res.status(400).json({ success: false, error: `Không tìm thấy thư mục Profile gốc: ${sourceDir}` });
    }

    // ĐÓNG TRÌNH DUYỆT TRƯỚC KHI COPY (Giải phóng file lock)
    await closeBrowser(accountId);

    // Xóa thư mục đích nếu đã tồn tại để tránh xung đột
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    // Copy toàn bộ cấu trúc
    fs.cpSync(sourceDir, destDir, { recursive: true });

    // Tạo hoặc cập nhật account trong DB
    await Account.findOneAndUpdate(
      { phoneNumber: accountId }, // Dùng accountId làm phoneNumber tạm thời để phân biệt
      {
        name: name || accountId,
        sessionFolder: `./userData/zalo_${accountId}`,
        status: 'active',
        lastSyncAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Copy Profile vật lý thành công' });
  } catch (error) {
    console.error('[API] Lỗi khi đồng bộ session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get groups for an account
router.get('/groups/:accountId', async (req, res) => {
  try {
    const groups = await Group.find({ accountId: req.params.accountId });
    res.json({ success: true, data: groups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get members of a specific group
router.get('/groups/:groupId/members', async (req, res) => {
  try {
    const members = await GroupMember.find({ groupId: req.params.groupId });
    // Format to match Contact structure so UI can reuse logic
    const data = members.map(m => ({
      id: m.zaloId,
      name: m.name,
      type: 'group_member',
      avatar: m.avatar,
      groupId: m.groupId,
      accountId: m.accountId
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get Zalo QR Code
router.get('/accounts/qr', async (req, res) => {
  try {
    const qrBase64 = await getLoginQRCode();
    res.json({ success: true, qr: qrBase64 });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Không thể tải mã QR. Vui lòng thử lại.' });
  }
});

// API: Get all campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await Campaign.find({}).sort({ createdAt: -1 });

    // Tính toán số liệu thống kê cho mỗi chiến dịch
    const summaryData = campaigns.map(c => {
      const total = c.recipients.length;
      const sent = c.recipients.filter(r => r.status === 'sent').length;
      const failed = c.recipients.filter(r => r.status === 'failed').length;
      const pending = c.recipients.filter(r => r.status === 'pending').length;

      let displayStatus = c.status;
      if (c.status === 'running' && pending === 0) {
        displayStatus = 'completed';
      }

      return {
        _id: c._id,
        name: c.name,
        accountId: c.accountId,
        status: displayStatus,
        createdAt: c.createdAt,
        stats: { total, sent, failed, pending }
      };
    });

    res.json({ success: true, data: summaryData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get campaign details
router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Không tìm thấy chiến dịch' });
    
    const total = campaign.recipients.length;
    const sent = campaign.recipients.filter(r => r.status === 'sent').length;
    const failed = campaign.recipients.filter(r => r.status === 'failed').length;
    const pending = campaign.recipients.filter(r => r.status === 'pending').length;

    const data = campaign.toObject();
    data.stats = { total, sent, failed, pending };
    
    if (data.status === 'running' && pending === 0) {
      data.status = 'completed';
    }

    res.json({ success: true, data: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Delete campaign
router.delete('/campaigns/:id', async (req, res) => {
  try {
    await Campaign.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Đã xóa chiến dịch' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================================================================
// ZCA-JS API ENDPOINTS (V2) — Quét data & gửi tin bằng Internal API thay vì Browser
// ========================================================================================

// API: Kết nối zca-js cho một tài khoản (Extract credentials từ Playwright session)
router.post('/accounts/zca-connect', async (req, res) => {
  const { accountId } = req.body;
  try {
    if (!accountId) throw new Error('Thiếu accountId');

    // Bước 1: Extract cookies, imei, userAgent từ Playwright session đang chạy
    const credentials = await extractCredentialsFromPlaywright(accountId);

    // Bước 2: Lưu credentials vào DB để tái sử dụng sau
    await Account.findOneAndUpdate(
      { phoneNumber: accountId },
      { zcaCredentials: credentials }
    );

    // Bước 3: Đăng nhập zca-js bằng credentials vừa extract
    await initZaloApi(accountId, credentials);

    res.json({ success: true, message: 'Kết nối API Zalo thành công!' });
  } catch (error) {
    console.error('[API] Lỗi kết nối zca-js:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Kiểm tra trạng thái kết nối zca-js
router.get('/accounts/zca-status/:id', async (req, res) => {
  try {
    const status = getZaloApiStatus(req.params.id);
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Ngắt kết nối zca-js
router.post('/accounts/zca-disconnect', async (req, res) => {
  const { accountId } = req.body;
  try {
    if (!accountId) throw new Error('Thiếu accountId');
    await closeZaloApi(accountId);
    res.json({ success: true, message: 'Đã ngắt kết nối API Zalo.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Quét danh bạ bạn bè bằng zca-js (V2)
router.post('/accounts/sync-v2', async (req, res) => {
  const { accountId } = req.body;
  try {
    if (!accountId) throw new Error('Thiếu accountId');
    const result = await syncFriendsViaApi(accountId);
    res.json({ success: true, message: `Đã quét ${result.count} bạn bè (UID thật) qua API.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Quét nhóm bằng zca-js (V2)
router.post('/accounts/sync-groups-v2', async (req, res) => {
  const { accountId } = req.body;
  try {
    if (!accountId) throw new Error('Thiếu accountId');
    const result = await syncGroupsViaApi(accountId);
    res.json({ success: true, message: `Đã quét ${result.count} nhóm (ID thật) qua API.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Quét thành viên nhóm bằng zca-js (V2) — Kể cả thành viên ẨN
router.post('/accounts/sync-group-members-v2', async (req, res) => {
  const { accountId, groupId, groupZaloId } = req.body;
  try {
    if (!accountId || !groupId || !groupZaloId) throw new Error('Thiếu accountId, groupId hoặc groupZaloId');
    const result = await syncGroupMembersViaApi(accountId, groupId, groupZaloId);
    res.json({
      success: true,
      message: `Đã quét ${result.count} thành viên nhóm "${result.groupName}" (UID thật, kể cả ẩn) qua API.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Tạo chiến dịch gửi tin bằng UID qua zca-js (V2)
router.post('/campaigns-v2', upload.single('image'), async (req, res) => {
  try {
    let { accountId, accountIds, limitPerAccount, name, messageTemplate, recipients, groupName, isFriendRequest, friendRequestMessage, isGroupTarget } = req.body;

    let targetAccountIds = [];
    if (accountIds) {
      targetAccountIds = JSON.parse(accountIds);
    } else if (accountId) {
      targetAccountIds = [accountId];
    }

    const limit = limitPerAccount ? parseInt(limitPerAccount, 10) : 999999;

    // Parse recipients if it's sent as a JSON string from FormData
    if (typeof recipients === 'string') {
      recipients = JSON.parse(recipients);
    }

    if (targetAccountIds.length === 0 || !messageTemplate || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    // Lấy đường dẫn file ảnh nếu có
    const imagePath = req.file ? req.file.path : null;

    let currentIndex = 0;
    const campaignIds = [];
    const processedContactIds = [];

    for (const accId of targetAccountIds) {
      if (currentIndex >= recipients.length) break;
      const chunk = recipients.slice(currentIndex, currentIndex + limit);
      if (chunk.length === 0) continue;
      
      const dbRecipients = chunk.map(c => ({
        contactId: c.id,
        name: c.name,
        status: 'pending'
      }));

      const campaignName = targetAccountIds.length > 1 ? `${name || 'Chiến dịch API'} - ${accId}` : (name || `Chiến dịch API ${new Date().toLocaleString('vi-VN')}`);
      
      const campaign = new Campaign({
        accountId: accId,
        name: campaignName,
        messageTemplate,
        recipients: dbRecipients,
        status: 'running'
      });
      await campaign.save();
      campaignIds.push(campaign._id);
      processedContactIds.push(...chunk.map(c => c.id));

      // Dispatch jobs to Queue
      for (const recipient of chunk) {
        await zaloMessageQueue.add('sendCampaignMessageV2', {
          campaignId: campaign._id,
          accountId: accId,
          contactId: recipient.id,
          recipientUid: recipient.id,
          recipientName: recipient.name,
          message: messageTemplate,
          imagePath: imagePath,
          isFriendRequest: isFriendRequest === 'true' || isFriendRequest === true,
          friendRequestMessage: friendRequestMessage,
          isGroupTarget: isGroupTarget === 'true',
          timestamp: Date.now()
        });
      }
      
      currentIndex += limit;
    }

    res.json({
      success: true,
      message: `Đã bắt đầu ${campaignIds.length} chiến dịch API gửi tới ${processedContactIds.length} người.`,
      campaignIds,
      processedContactIds
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
