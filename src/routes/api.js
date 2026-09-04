import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { zaloMessageQueue } from '../config/queue.js';
import { Contact } from '../models/Contact.js';
import { Account } from '../models/Account.js';
import { Campaign } from '../models/Campaign.js';
import { Group } from '../models/Group.js';

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

router.get('/status', (req, res) => {
  res.json({ status: 'OK', message: 'AutoZalo API is running' });
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
    let { accountId, name, messageTemplate, recipients } = req.body;

    // Parse recipients if it's sent as a JSON string from FormData
    if (typeof recipients === 'string') {
      recipients = JSON.parse(recipients);
    }

    if (!accountId || !messageTemplate || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    // Lấy đường dẫn file ảnh nếu có
    const imagePath = req.file ? req.file.path : null;

    // Prepare recipients for DB
    const dbRecipients = recipients.map(c => ({
      contactId: c.id,
      status: 'pending'
    }));

    // Create Campaign
    const campaign = new Campaign({
      accountId,
      name: name || `Chiến dịch ${new Date().toLocaleString('vi-VN')}`,
      messageTemplate,
      recipients: dbRecipients,
      status: 'running'
    });
    await campaign.save();

    // Dispatch jobs to Queue
    for (const recipient of recipients) {
      await zaloMessageQueue.add('sendCampaignMessage', {
        campaignId: campaign._id,
        accountId,
        contactId: recipient.id,
        to: recipient.name,
        message: messageTemplate,
        imagePath: imagePath, // Truyền đường dẫn ảnh cho worker
        timestamp: Date.now()
      });
    }

    res.json({ success: true, message: `Đã bắt đầu chiến dịch gửi tới ${recipients.length} người.`, campaignId: campaign._id });
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

// Import the functions from playwright worker
import { getLoginQRCode, closeBrowser, syncZaloContacts, syncZaloGroups } from '../scripts/playwright.worker.js';

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
    res.json({ success: true, data: campaign });
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

export default router;
