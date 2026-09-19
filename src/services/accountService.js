import { Account } from '../models/Account.js';

const DAILY_LIMIT = 30; // Giới hạn 30 tin/tài khoản/ngày

export const getAvailableAccount = async (allowedAccountIds = null) => {
  try {
    // Lấy tất cả tài khoản đang active
    let query = { status: 'active' };
    if (allowedAccountIds && Array.isArray(allowedAccountIds) && allowedAccountIds.length > 0) {
      query.phoneNumber = { $in: allowedAccountIds };
    }
    const accounts = await Account.find(query);
    if (!accounts || accounts.length === 0) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let bestAccount = null;

    for (let account of accounts) {
      // Nếu đã từng gửi tin, kiểm tra xem có phải ngày hôm nay không
      if (account.lastSentDate) {
        const lastSent = new Date(account.lastSentDate);
        lastSent.setHours(0, 0, 0, 0);
        
        // Sang ngày mới -> Reset biến đếm
        if (lastSent.getTime() !== today.getTime()) {
          account.dailySentCount = 0;
          await account.save();
        }
      } else {
        account.dailySentCount = 0;
      }

      // Nếu tài khoản còn Quota
      if (account.dailySentCount < DAILY_LIMIT) {
        // Thuật toán rải đều tải (Load Balancing): Chọn tài khoản có số tin đã gửi thấp nhất
        if (!bestAccount || account.dailySentCount < bestAccount.dailySentCount) {
          bestAccount = account;
        }
      }
    }

    return bestAccount ? bestAccount.phoneNumber : null;
  } catch (error) {
    console.error('[Account Service] Lỗi khi lấy tài khoản khả dụng:', error);
    return null;
  }
};

export const incrementDailyCount = async (phoneNumber) => {
  try {
    const now = new Date();
    await Account.findOneAndUpdate(
      { phoneNumber },
      { 
        $inc: { dailySentCount: 1 },
        $set: { lastSentDate: now }
      }
    );
  } catch (error) {
    console.error(`[Account Service] Lỗi khi tăng biến đếm cho tài khoản ${phoneNumber}:`, error);
  }
};
