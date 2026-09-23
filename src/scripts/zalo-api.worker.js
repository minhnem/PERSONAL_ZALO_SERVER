import { Zalo, ThreadType } from 'zca-js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { Contact } from '../models/Contact.js';
import { Group } from '../models/Group.js';
import { GroupMember } from '../models/GroupMember.js';
import { Account } from '../models/Account.js';

// ========================================================================================
// ZCA-JS WORKER MODULE
// Quản lý kết nối Zalo API (zca-js) cho mỗi tài khoản
// Tương đương vai trò playwright.worker.js nhưng dùng Internal API thay vì Browser
// ========================================================================================

// Map quản lý API instances cho mỗi account (giống browserContexts trong playwright.worker.js)
const zaloApiInstances = new Map(); // accountId → { zalo, api }

// Hàm đọc metadata ảnh bắt buộc cho zca-js v2 (gửi ảnh qua file path)
async function imageMetadataGetter(filePath) {
  const data = await fs.promises.readFile(filePath);
  const metadata = await sharp(data).metadata();
  return {
    height: metadata.height,
    width: metadata.width,
    size: metadata.size || data.length,
  };
}

// ========================================================================================
// ĐĂNG NHẬP & QUẢN LÝ KẾT NỐI
// ========================================================================================

/**
 * Khởi tạo kết nối zca-js bằng Cookie (Extract từ Playwright Session hoặc nhập thủ công)
 * @param {string} accountId - Mã tài khoản (phoneNumber)
 * @param {object} credentials - { cookie: Array, imei: string, userAgent: string }
 * @returns {object} - API instance
 */
export const initZaloApi = async (accountId, credentials) => {
  // Nếu đã có kết nối, trả về luôn
  if (zaloApiInstances.has(accountId)) {
    const existing = zaloApiInstances.get(accountId);
    console.log(`[ZCA Worker] Tài khoản ${accountId} đã có kết nối API, tái sử dụng.`);
    return existing.api;
  }

  console.log(`[ZCA Worker] Đang khởi tạo kết nối zca-js cho tài khoản ${accountId}...`);

  try {
    const zalo = new Zalo({
      selfListen: false,
      checkUpdate: true,
      logging: true,
      imageMetadataGetter,
    });

    const api = await zalo.login({
      cookie: credentials.cookie,
      imei: credentials.imei,
      userAgent: credentials.userAgent,
    });

    zaloApiInstances.set(accountId, { zalo, api });

    // Cập nhật trạng thái trong DB
    await Account.findOneAndUpdate(
      { phoneNumber: accountId },
      { zcaStatus: 'connected' }
    );

    console.log(`[ZCA Worker] ✅ Kết nối zca-js thành công cho tài khoản ${accountId}`);
    return api;
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi kết nối zca-js cho ${accountId}:`, error.message);

    // Cập nhật trạng thái lỗi
    await Account.findOneAndUpdate(
      { phoneNumber: accountId },
      { zcaStatus: 'error' }
    );

    throw new Error(`Không thể kết nối API Zalo: ${error.message}`);
  }
};

/**
 * Lấy API instance đã kết nối (hoặc throw nếu chưa)
 */
const getApi = (accountId) => {
  if (!zaloApiInstances.has(accountId)) {
    throw new Error(`Tài khoản ${accountId} chưa kết nối API. Vui lòng bấm "Kết nối API" trước.`);
  }
  return zaloApiInstances.get(accountId).api;
};

/**
 * Kiểm tra trạng thái kết nối zca-js
 */
export const getZaloApiStatus = (accountId) => {
  return zaloApiInstances.has(accountId) ? 'connected' : 'disconnected';
};

/**
 * Đóng kết nối zca-js cho một tài khoản
 */
export const closeZaloApi = async (accountId) => {
  try {
    if (zaloApiInstances.has(accountId)) {
      console.log(`[ZCA Worker] Đang đóng kết nối API cho tài khoản ${accountId}...`);
      zaloApiInstances.delete(accountId);

      await Account.findOneAndUpdate(
        { phoneNumber: accountId },
        { zcaStatus: 'disconnected' }
      );

      console.log(`[ZCA Worker] Đã đóng kết nối API cho tài khoản ${accountId}.`);
    }
  } catch (error) {
    console.error(`[ZCA Worker] Lỗi khi đóng API ${accountId}:`, error.message);
  }
};

/**
 * Đóng tất cả kết nối zca-js (dùng khi worker rảnh rỗi)
 */
export const closeAllZaloApis = async () => {
  console.log(`[ZCA Worker] Yêu cầu đóng TẤT CẢ kết nối API...`);
  const keys = Array.from(zaloApiInstances.keys());
  for (const accountId of keys) {
    await closeZaloApi(accountId);
  }
};

// ========================================================================================
// EXTRACT CREDENTIALS TỪ PLAYWRIGHT SESSION
// ========================================================================================

/**
 * Extract cookies, imei, userAgent từ Playwright persistent context đang chạy
 * hoặc từ thư mục userData đã lưu.
 * @param {string} accountId
 * @returns {object} { cookie, imei, userAgent }
 */
export const extractCredentialsFromPlaywright = async (accountId) => {
  console.log(`[ZCA Worker] Đang extract credentials từ Playwright session cho ${accountId}...`);

  // Import playwright worker để lấy browser context
  const { initBrowser, closeBrowser } = await import('./playwright.worker.js');

  try {
    const context = await initBrowser(accountId);
    const pages = context.pages();
    const page = pages.find(p => p.url().includes('chat.zalo.me')) || pages[pages.length - 1];

    if (!page) throw new Error('Không tìm thấy trang Zalo đang mở');

    // Đảm bảo đang ở trang Zalo
    if (!page.url().includes('zalo.me')) {
      await page.goto('https://chat.zalo.me', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // 1. Lấy cookies từ browser context (không truyền url để lấy ALL cookies bao gồm cả .zalo.me)
    const rawCookies = await context.cookies();
    // Chuyển đổi cookie sang format zca-js cần (array of { name, value, domain, ... })
    const cookie = rawCookies.map(c => ({
      domain: c.domain,
      expirationDate: c.expires,
      hostOnly: !c.domain.startsWith('.'),
      httpOnly: c.httpOnly,
      name: c.name,
      path: c.path,
      sameSite: c.sameSite || 'unspecified',
      secure: c.secure,
      session: c.expires === -1,
      storeId: '0',
      value: c.value,
    }));

    // 2. Lấy IMEI từ localStorage
    const imei = await page.evaluate(() => {
      return localStorage.getItem('z_uuid') || localStorage.getItem('sh_z_uuid') || '';
    });

    if (!imei) {
      throw new Error('Không tìm thấy IMEI (z_uuid) trong localStorage. Tài khoản có thể chưa đăng nhập Zalo.');
    }

    // 3. Lấy userAgent
    const userAgent = await page.evaluate(() => navigator.userAgent);

    console.log(`[ZCA Worker] ✅ Extract credentials thành công:
  - Cookies: ${cookie.length} cookies
  - IMEI: ${imei.substring(0, 8)}...
  - UserAgent: ${userAgent.substring(0, 50)}...`);

    // Đóng browser sau khi extract (giải phóng session cho zca-js)
    await closeBrowser(accountId);

    return { cookie, imei, userAgent };
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi extract credentials:`, error.message);
    // Đóng browser dù lỗi
    await closeBrowser(accountId).catch(() => { });
    throw new Error(`Không thể extract credentials: ${error.message}`);
  }
};

// ========================================================================================
// QUÉT DANH BẠ (BẠN BÈ)
// ========================================================================================

/**
 * Quét danh bạ bạn bè qua zca-js API
 * getAllFriends() trả về User[] với userId, displayName, zaloName, avatar, phoneNumber
 */
export const syncFriendsViaApi = async (accountId) => {
  const api = getApi(accountId);

  console.log(`[ZCA Worker] Bắt đầu quét danh bạ bạn bè cho ${accountId}...`);

  try {
    const friends = await api.getAllFriends();

    // 1. Fetch tags (labels) and map to UIDs
    let uidToTags = {};
    try {
      if (typeof api.getLabels === 'function') {
        const labelsRes = await api.getLabels();
        const labels = labelsRes?.labelData || [];
        labels.forEach(label => {
          const tagName = label.text || label.textKey;
          if (tagName && label.conversations && Array.isArray(label.conversations)) {
            label.conversations.forEach(uid => {
              if (!uidToTags[uid]) uidToTags[uid] = [];
              uidToTags[uid].push(tagName);
            });
          }
        });
        console.log(`[ZCA Worker] Đã bóc tách thành công Tag cho các UID. Tín hiệu mẫu: ${Object.keys(uidToTags).length} UIDs có tag.`);
      }
    } catch (err) {
      console.error('[ZCA Worker] Lỗi khi lấy danh sách Tag:', err.message);
    }

    console.log(`[ZCA Worker] API trả về ${friends.length} bạn bè.`);

    if (friends.length > 0) {
      const contactsToSave = friends.map(f => ({
        accountId,
        zaloId: f.userId, // UID THẬT
        name: f.displayName || f.zaloName || f.username || 'Không tên',
        avatar: f.avatar || '',
        phoneNumber: f.phoneNumber || '',
        type: 'friend',
        tags: uidToTags[f.userId] || [],
      }));

      console.log(`\n[ZCA Worker] ===== DỮ LIỆU BẠN BÈ QUÉT ĐƯỢC (MẪU 5 ĐẦU) =====`);
      console.log(JSON.stringify(contactsToSave.slice(0, 5), null, 2));
      console.log(`==================================================================\n`);

      // Xóa data cũ rồi ghi mới (giống logic playwright.worker.js)
      await Contact.deleteMany({ accountId });
      await Contact.insertMany(contactsToSave);

      console.log(`[ZCA Worker] ✅ Đã lưu ${contactsToSave.length} bạn bè (UID thật) vào DB.`);
    } else {
      console.log(`[ZCA Worker] Không quét được bạn bè nào.`);
    }

    return { success: true, count: friends.length };
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi quét bạn bè:`, error.message);
    throw error;
  }
};

// ========================================================================================
// QUÉT NHÓM
// ========================================================================================

/**
 * Quét danh sách nhóm qua zca-js API
 * getAllGroups() trả về { gridVerMap: { [groupId]: version } }
 * getGroupInfo(groupIds) trả về chi tiết từng nhóm (tên, avatar, memVerList, ...)
 */
export const syncGroupsViaApi = async (accountId) => {
  const api = getApi(accountId);

  console.log(`[ZCA Worker] Bắt đầu quét nhóm cho ${accountId}...`);

  try {
    // Bước 1: Lấy danh sách groupId
    const allGroupsRes = await api.getAllGroups();
    const groupIds = Object.keys(allGroupsRes.gridVerMap || {});

    console.log(`[ZCA Worker] Tìm thấy ${groupIds.length} nhóm, đang lấy thông tin chi tiết...`);

    if (groupIds.length === 0) {
      console.log(`[ZCA Worker] Không tìm thấy nhóm nào.`);
      return { success: true, count: 0 };
    }

    // Bước 2: Lấy chi tiết nhóm (batch 20 nhóm/lần để tránh quá tải)
    const BATCH_SIZE = 20;
    const groupsToSave = [];

    for (let i = 0; i < groupIds.length; i += BATCH_SIZE) {
      const batch = groupIds.slice(i, i + BATCH_SIZE);
      try {
        const groupInfoRes = await api.getGroupInfo(batch);
        const gridInfoMap = groupInfoRes.gridInfoMap || {};

        for (const [gId, gInfo] of Object.entries(gridInfoMap)) {
          groupsToSave.push({
            accountId,
            zaloId: gId, // Group ID THẬT
            name: gInfo.name || `Nhóm ${gId}`,
            avatar: gInfo.avt || gInfo.avatar || '',
            type: 'group',
            memberCount: (gInfo.memVerList || []).length,
          });
        }
      } catch (batchErr) {
        console.log(`[ZCA Worker] Cảnh báo: Lỗi khi lấy info batch nhóm ${i}-${i + BATCH_SIZE}:`, batchErr.message);
      }

      // Delay nhỏ giữa các batch
      if (i + BATCH_SIZE < groupIds.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`\n[ZCA Worker] ===== DỮ LIỆU NHÓM QUÉT ĐƯỢC (MẪU 5 ĐẦU) =====`);
    console.log(JSON.stringify(groupsToSave.slice(0, 5), null, 2));
    console.log(`==================================================================\n`);

    if (groupsToSave.length > 0) {
      await Group.deleteMany({ accountId });
      await Group.insertMany(groupsToSave);
      console.log(`[ZCA Worker] ✅ Đã lưu ${groupsToSave.length} nhóm (ID thật) vào DB.`);
    }

    return { success: true, count: groupsToSave.length };
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi quét nhóm:`, error.message);
    throw error;
  }
};

// ========================================================================================
// QUÉT THÀNH VIÊN NHÓM (KỂ CẢ ẨN)
// ========================================================================================

/**
 * Quét thành viên nhóm qua zca-js API
 * 1. getGroupInfo(groupZaloId) → memVerList (mảng UID thật của TẤT CẢ thành viên kể cả ẩn)
 * 2. getGroupMembersInfo(memberUids) → displayName, avatar cho mỗi UID
 */
export const syncGroupMembersViaApi = async (accountId, groupId, groupZaloId) => {
  const api = getApi(accountId);

  console.log(`[ZCA Worker] Bắt đầu quét thành viên nhóm ${groupZaloId} cho ${accountId}...`);

  try {
    // Bước 1: Lấy danh sách UID thành viên
    const groupInfoRes = await api.getGroupInfo(groupZaloId);
    const gridInfo = groupInfoRes.gridInfoMap?.[groupZaloId];

    if (!gridInfo) {
      throw new Error(`Không tìm thấy thông tin nhóm ${groupZaloId}. Nhóm có thể đã bị xóa hoặc bạn không phải thành viên.`);
    }

    const memberUids = (gridInfo.memberIds && gridInfo.memberIds.length > 0)
      ? gridInfo.memberIds
      : (gridInfo.memVerList?.map(id => id.split('_')[0]) || []);
    const groupName = gridInfo.name || `Nhóm ${groupZaloId}`;

    console.log(`[ZCA Worker] Nhóm "${groupName}" có ${memberUids.length} thành viên (kể cả ẩn). Đang lấy thông tin chi tiết...`);

    if (memberUids.length === 0) {
      console.log(`[ZCA Worker] Zalo chặn danh sách thành viên. Đang thử lấy qua link mời (nếu có)...`);
      try {
        const linkDetail = await api.getGroupLinkDetail(groupZaloId);
        if (linkDetail && linkDetail.enabled === 1 && linkDetail.link) {
          console.log(`[ZCA Worker] Nhóm đang bật link mời (${linkDetail.link}). Quét qua link...`);
          
          let page = 1;
          let hasMore = true;
          const membersToSave = [];

          while (hasMore) {
            const res = await api.getGroupLinkInfo({ link: linkDetail.link, memberPage: page });
            if (res && res.currentMems) {
              for (const m of res.currentMems) {
                membersToSave.push({
                  accountId,
                  groupId,
                  zaloId: m.id,
                  displayName: m.zaloName || m.dName || '',
                  name: m.dName || m.zaloName || `Thành viên ${m.id.substring(0, 8)}`,
                  avatar: m.avatar || m.avatar_25 || '',
                });
              }
            }
            if (res && res.hasMoreMember === 1) {
              page++;
              await new Promise(r => setTimeout(r, 1000));
            } else {
              hasMore = false;
            }
          }

          if (membersToSave.length > 0) {
            await GroupMember.deleteMany({ accountId, groupId });
            await GroupMember.insertMany(membersToSave);
            console.log(`[ZCA Worker] ✅ Đã lưu ${membersToSave.length} thành viên nhóm "${groupName}" (qua Link Mời) vào DB.`);
            return { success: true, count: membersToSave.length, groupName, fallbackUsed: true };
          }
        } else {
          console.log(`[ZCA Worker] Nhóm KHÔNG bật link mời. Kết thúc thử nghiệm link.`);
        }
      } catch (linkErr) {
        console.log(`[ZCA Worker] Lỗi thử quét qua link mời: ${linkErr.message}`);
      }

      console.log(`[ZCA Worker] Không thể quét thành viên do Zalo chặn diện rộng.`);
      // Ném lỗi với câu văn chính xác để UI hiển thị theo yêu cầu "Vấn đề 2"
      throw new Error("Zalo hiện đã ẩn danh sách thành viên cho nhóm này (chặn diện rộng).");
    }

    // Bước 2: Lấy profile từng thành viên (batch 50 UIDs/lần) bằng getUserInfo (vượt rào Zalo)
    const BATCH_SIZE = 50;
    const membersToSave = [];

    for (let i = 0; i < memberUids.length; i += BATCH_SIZE) {
      const batch = memberUids.slice(i, i + BATCH_SIZE);

      try {
        // Dùng getUserInfo (trả về cả người lạ) thay vì getGroupMembersInfo (bị lock)
        const profilesRes = await api.getUserInfo(batch);
        const changedProfiles = profilesRes.changed_profiles || {};

        for (const uid of batch) {
          // Key trả về thường có đuôi "_0", vd: "123456_0"
          const profile = changedProfiles[`${uid}_0`] || changedProfiles[uid] || {};
          
          membersToSave.push({
            accountId,
            groupId,
            zaloId: uid,
            displayName: profile.zaloName || profile.displayName || '',
            name: profile.displayName || profile.zaloName || `Thành viên ${uid.substring(0, 8)}`,
            avatar: profile.avatar || '',
          });
        }
      } catch (batchErr) {
        console.log(`[ZCA Worker] Cảnh báo: Lỗi khi lấy info batch thành viên ${i}-${i + BATCH_SIZE}:`, batchErr.message);
        // Vẫn lưu UID dù không có tên
        for (const uid of batch) {
          membersToSave.push({
            accountId,
            groupId,
            zaloId: uid,
            displayName: '',
            name: `Thành viên ${uid.substring(0, 8)}`,
            avatar: '',
          });
        }
      }

      // Delay nhỏ giữa các batch
      if (i + BATCH_SIZE < memberUids.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`\n[ZCA Worker] ===== DỮ LIỆU THÀNH VIÊN NHÓM QUÉT ĐƯỢC (MẪU 5 ĐẦU) =====`);
    console.log(JSON.stringify(membersToSave.slice(0, 5), null, 2));
    console.log(`==================================================================\n`);

    // Xóa data cũ rồi ghi mới
    await GroupMember.deleteMany({ accountId, groupId });
    await GroupMember.insertMany(membersToSave);

    console.log(`[ZCA Worker] ✅ Đã lưu ${membersToSave.length} thành viên nhóm "${groupName}" (UID thật, kể cả ẩn) vào DB.`);

    return { success: true, count: membersToSave.length, groupName };
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi quét thành viên nhóm:`, error.message);
    throw error;
  }
};

// ========================================================================================
// QUÉT THÀNH VIÊN NHÓM QUA LINK (ZCA-JS V2)
// ========================================================================================

/**
 * Quét thành viên nhóm thông qua link tham gia (không cần ở trong nhóm)
 * @param {string} accountId 
 * @param {string} groupLink 
 */
export const syncGroupMembersViaLinkApi = async (accountId, groupLink) => {
  const api = getApi(accountId);
  console.log(`[ZCA Worker] Bắt đầu quét thành viên nhóm từ link ${groupLink} cho ${accountId}...`);

  try {
    let allMembers = [];
    let page = 1;
    let hasMore = true;
    let groupInfo = null;

    // 1. Phân trang lấy tất cả thành viên qua link
    while (hasMore) {
      console.log(`[ZCA Worker] Đang tải trang ${page}...`);
      const res = await api.getGroupLinkInfo({ link: groupLink, memberPage: page });
      
      if (!groupInfo && res) {
        groupInfo = {
          groupId: res.groupId,
          name: res.name || `Nhóm Zalo ${res.groupId}`,
          avatar: res.avt || res.fullAvt || '',
          totalMember: res.totalMember || 0
        };
      }

      if (res && res.currentMems) {
        allMembers.push(...res.currentMems);
      }

      if (res && res.hasMoreMember === 1) {
        page++;
        await new Promise(r => setTimeout(r, 1000)); // Delay tránh rate limit
      } else {
        hasMore = false;
      }
    }

    if (!groupInfo) {
      throw new Error('Không thể lấy thông tin nhóm. Link không hợp lệ hoặc nhóm đã bị giải tán.');
    }

    console.log(`[ZCA Worker] Quét được tổng cộng ${allMembers.length} thành viên từ link nhóm "${groupInfo.name}".`);

    // 2. Lưu/Cập nhật thông tin Nhóm vào bảng Group
    let groupRecord = await Group.findOne({ accountId, zaloId: groupInfo.groupId });
    if (!groupRecord) {
      groupRecord = new Group({
        accountId,
        zaloId: groupInfo.groupId, // groupId toàn cầu của Zalo
        name: groupInfo.name,
        avatar: groupInfo.avatar,
        type: 'group_from_link',
        memberCount: allMembers.length
      });
      await groupRecord.save();
      console.log(`[ZCA Worker] Đã tạo mới bản ghi nhóm "${groupInfo.name}" trong CSDL.`);
    } else {
      groupRecord.name = groupInfo.name;
      groupRecord.avatar = groupInfo.avatar;
      groupRecord.memberCount = allMembers.length;
      await groupRecord.save();
    }

    // 3. Xử lý lưu thành viên vào GroupMember
    if (allMembers.length > 0) {
      const membersToSave = allMembers.map(m => ({
        accountId,
        groupId: groupRecord._id, // Khóa ngoại trỏ đến _id của Group trong MongoDB
        zaloId: m.id,             // UID thật được cấp cục bộ cho nick này
        displayName: m.zaloName || m.dName || '',
        name: m.dName || m.zaloName || `Thành viên ${m.id.substring(0, 8)}`,
        avatar: m.avatar || m.avatar_25 || '',
      }));

      // Xóa thành viên cũ (thuộc Group này và Account này) trước khi insert mới
      await GroupMember.deleteMany({ accountId, groupId: groupRecord._id });
      await GroupMember.insertMany(membersToSave);
      
      console.log(`[ZCA Worker] ✅ Đã lưu ${membersToSave.length} thành viên từ link vào DB thành công.`);
    }

    return { success: true, count: allMembers.length, groupName: groupInfo.name };
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi quét nhóm qua link:`, error.message);
    throw error;
  }
};

// ========================================================================================
// GỬI TIN NHẮN BẰNG UID
// ========================================================================================

/**
 * Gửi tin nhắn trực tiếp qua zca-js API (không cần mở browser)
 * @param {string} accountId
 * @param {string} recipientUid - UID người nhận (chính xác 100%)
 * @param {string} messageText - Nội dung tin nhắn (đã xử lý spintax)
 * @param {string|null} imagePath - Đường dẫn ảnh đính kèm (nếu có)
 * @param {boolean} isGroupTarget - Có phải nhóm đích hay không
 */
export const sendMessageViaApi = async (accountId, recipientUid, messageText, imagePath = null, isGroupTarget = false) => {
  const api = getApi(accountId);
  let finalUid = recipientUid;

  console.log(`[ZCA Worker] Đang gửi tin nhắn cho UID/SĐT: ${recipientUid}...`);

  try {
    // Tự động nhận diện nếu đầu vào là số điện thoại
    if (/^(0|84)\d{8,9}$/.test(finalUid)) {
      console.log(`[ZCA Worker] Phát hiện đầu vào là SĐT (${finalUid}), đang tra cứu UID...`);
      const user = await api.findUser(finalUid);
      if (!user || !user.uid) {
        throw new Error(`Không tìm thấy Zalo của SĐT ${finalUid}`);
      }
      finalUid = user.uid;
      console.log(`[ZCA Worker] Đã dịch SĐT ${recipientUid} thành UID: ${finalUid}`);
    }
    // Xử lý Spintax (giống logic trong playwright.worker.js)
    let finalMessage = messageText.replace(/\{([^{}]*\|[^{}]*)\}/g, (match, p1) => {
      const options = p1.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });

    // Xử lý Shortcodes cá nhân hóa
    // Lấy tên người nhận từ DB (nếu có)
    let recipientName = 'bạn';
    try {
      // Tìm trong Contact hoặc GroupMember
      const contact = await Contact.findOne({ zaloId: finalUid });
      const member = await GroupMember.findOne({ zaloId: finalUid });
      recipientName = contact?.name || member?.name || 'bạn';
    } catch (e) { /* ignore */ }

    const nameParts = recipientName.split(' ');
    const firstName = nameParts[nameParts.length - 1] || '';
    const lastName = nameParts[0] || '';

    const now = new Date();
    const dateStr = now.toLocaleDateString('vi-VN');
    const timeStr = now.toLocaleTimeString('vi-VN');
    const yearStr = now.getFullYear().toString();
    const randomStr = Math.floor(100000 + Math.random() * 900000).toString();

    finalMessage = finalMessage
      .replace(/{name}/g, recipientName)
      .replace(/{first_name}/g, firstName)
      .replace(/{last_name}/g, lastName)
      .replace(/{date}/g, dateStr)
      .replace(/{datetime}/g, `${timeStr} ${dateStr}`)
      .replace(/{year}/g, yearStr)
      .replace(/{random}/g, randomStr);

    // [QUAN TRỌNG] Sửa lỗi khoảng cách dòng xa nhau trên Zalo Desktop khi gửi qua API
    // Ký tự \r (Carriage Return) từ Windows/Copy-Paste thường bị Zalo Desktop hiểu thành 1 dòng trống phụ.
    finalMessage = finalMessage.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Chuẩn bị message content cho zca-js
    const messageContent = { msg: finalMessage };

    // Đính kèm ảnh nếu có
    if (imagePath && fs.existsSync(imagePath)) {
      messageContent.attachments = [path.resolve(imagePath)];
      console.log(`[ZCA Worker] Đính kèm ảnh: ${imagePath}`);
    }

    // Gửi tin nhắn bằng UID — CHÍNH XÁC 100%, KHÔNG BAO GIỜ NHẦM NGƯỜI
    const result = await api.sendMessage(
      messageContent,
      finalUid,
      isGroupTarget ? ThreadType.Group : ThreadType.User
    );

    console.log(`[ZCA Worker] ✅ Gửi tin thành công cho UID ${finalUid}. MsgId: ${result?.message?.msgId || 'N/A'}`);

    return { success: true, msgId: result?.message?.msgId };
  } catch (error) {
    // console.error(`[ZCA Worker] ❌ Lỗi gửi tin cho UID ${finalUid}:`, error.message);
    console.error(`\n========== ZCA SEND ERROR ==========`);
    console.error(`UID: ${finalUid}`);
    console.error(`message: ${error?.message}`);
    console.error(`name: ${error?.name}`);
    console.error(`code: ${error?.code}`);
    console.error(`status: ${error?.response?.status}`);
    console.error(`response:`, error?.response?.data);
    console.error(`====================================\n`);

    // throw error;
    throw error;
  }
};

/**
 * Gửi lời mời kết bạn bằng UID (zca-js V2)
 */
export const sendFriendRequestViaApi = async (accountId, recipientUid, message) => {
  try {
    const api = getApi(accountId);
    let finalUid = recipientUid;

    // Tự động nhận diện nếu đầu vào là số điện thoại
    if (/^(0|84)\d{8,9}$/.test(finalUid)) {
      console.log(`[ZCA Worker] Phát hiện gửi kết bạn cho SĐT (${finalUid}), đang tra cứu UID...`);
      const user = await api.findUser(finalUid);
      if (!user || !user.uid) {
        throw new Error(`Không tìm thấy Zalo của SĐT ${finalUid}`);
      }
      finalUid = user.uid;
      console.log(`[ZCA Worker] Đã dịch SĐT ${recipientUid} thành UID: ${finalUid}`);
    }

    // Xử lý Shortcodes cá nhân hóa
    let recipientName = 'bạn';
    try {
      const contact = await Contact.findOne({ zaloId: finalUid });
      const member = await GroupMember.findOne({ zaloId: finalUid });
      recipientName = contact?.name || member?.name || 'bạn';
    } catch (e) { /* ignore */ }

    const nameParts = recipientName.split(' ');
    const firstName = nameParts[nameParts.length - 1] || '';
    const lastName = nameParts[0] || '';

    const now = new Date();
    const dateStr = now.toLocaleDateString('vi-VN');
    const timeStr = now.toLocaleTimeString('vi-VN');
    const yearStr = now.getFullYear().toString();
    const randomStr = Math.floor(100000 + Math.random() * 900000).toString();

    let finalMessage = message || '';
    finalMessage = finalMessage
      .replace(/{name}/g, recipientName)
      .replace(/{first_name}/g, firstName)
      .replace(/{last_name}/g, lastName)
      .replace(/{date}/g, dateStr)
      .replace(/{datetime}/g, `${timeStr} ${dateStr}`)
      .replace(/{year}/g, yearStr)
      .replace(/{random}/g, randomStr);

    // Đảm bảo không vượt quá ~150 ký tự
    if (finalMessage.length > 150) {
      finalMessage = finalMessage.substring(0, 150);
      console.warn(`[ZCA Worker] Lời mời kết bạn quá dài, đã cắt bớt: ${finalMessage}`);
    }

    const result = await api.sendFriendRequest(finalMessage, finalUid);

    console.log(`[ZCA Worker] ✅ Gửi yêu cầu kết bạn thành công cho UID ${finalUid}`);
    return { success: true, result };
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi gửi kết bạn cho UID ${recipientUid}:`, error.message);
    // Có thể là lỗi do đã là bạn bè, hoặc bị chặn, ...
    throw error;
  }
};

/**
 * Gửi yêu cầu kết bạn (kèm lời nhắn) thông qua số điện thoại.
 * Sử dụng API để tra cứu SĐT thành UID, sau đó gọi sendFriendRequest.
 * 
 * @param {string} accountId - Số điện thoại tài khoản nguồn
 * @param {string} phoneNumber - Số điện thoại người cần kết bạn
 * @param {string} message - Lời nhắn kết bạn
 * @returns {Promise<Object>} - Thông tin kết quả (UID nếu thành công)
 */
export const sendFriendRequestByPhoneViaApi = async (accountId, phoneNumber, message) => {
  const api = getApi(accountId);
  console.log(`[ZCA Worker] Yêu cầu kết bạn qua SĐT ${phoneNumber} từ tài khoản ${accountId}...`);

  try {
    // 1. Tìm Zalo ID (UID) từ SĐT
    const user = await api.findUser(phoneNumber);
    if (!user || !user.uid) {
      throw new Error(`Không tìm thấy tài khoản Zalo nào gắn với SĐT ${phoneNumber}`);
    }

    // 2. Format lời nhắn giống hệt hàm sendFriendRequestViaApi (cắt chuỗi, thay thế biến)
    const recipientName = user.zaloName || user.displayName || phoneNumber;
    let finalMessage = message || '';
    
    // Replace các biến cơ bản
    const parts = recipientName.split(' ');
    const lastName = parts[0];
    const firstName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const now = new Date();
    const dateStr = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}`;
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const yearStr = now.getFullYear().toString();
    const randomStr = Math.random().toString(36).substring(7);

    finalMessage = finalMessage
      .replace(/{name}/g, recipientName)
      .replace(/{first_name}/g, firstName)
      .replace(/{last_name}/g, lastName)
      .replace(/{date}/g, dateStr)
      .replace(/{datetime}/g, `${timeStr} ${dateStr}`)
      .replace(/{year}/g, yearStr)
      .replace(/{random}/g, randomStr);

    if (finalMessage.length > 150) {
      finalMessage = finalMessage.substring(0, 150);
    }

    // 3. Gửi lời mời kết bạn
    const result = await api.sendFriendRequest(finalMessage, user.uid);
    console.log(`[ZCA Worker] ✅ Đã gửi lời mời kết bạn thành công cho ${phoneNumber} (UID: ${user.uid})`);
    return { success: true, uid: user.uid, result };
  } catch (error) {
    console.error(`[ZCA Worker] ❌ Lỗi khi gửi kết bạn cho SĐT ${phoneNumber}:`, error.message);
    throw error;
  }
};

