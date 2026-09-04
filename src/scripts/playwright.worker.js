import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Contact } from '../models/Contact.js';
import { Group } from '../models/Group.js';
import { randomizeImageHash, deleteTempImage } from '../utils/imageModifier.js';
import path from 'path';
import fs from 'fs';

// Kích hoạt plugin tàng hình (chống bị phát hiện bot)
chromium.use(stealthPlugin());

const browserContexts = new Map();

// Khởi tạo trình duyệt một lần và giữ trạng thái cho mỗi accountId
export const initBrowser = async (accountId = 'default') => {
  if (browserContexts.has(accountId)) return browserContexts.get(accountId);

  console.log(`[Playwright Worker] Đang khởi động trình duyệt cho tài khoản ${accountId}...`);
  const context = await chromium.launchPersistentContext(`./userData/zalo_${accountId}`, {
    headless: true, // Chạy ngầm hoàn toàn, không bật Chrome bên ngoài
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await context.newPage();
  try {
    await page.goto('https://chat.zalo.me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log(`[Playwright Worker - ${accountId}] Cảnh báo khi tải trang Zalo:`, e.message);
  }
  console.log(`[Playwright Worker - ${accountId}] Trình duyệt đã sẵn sàng ở chat.zalo.me`);

  browserContexts.set(accountId, context);
  return context;
};

// Hàm đóng trình duyệt và giải phóng thư mục session (tránh lỗi file lock)
export const closeBrowser = async (accountId = 'default') => {
  try {
    if (browserContexts.has(accountId)) {
      console.log(`[Playwright Worker] Đang đóng trình duyệt cho tài khoản ${accountId}...`);
      const context = browserContexts.get(accountId);
      await context.close();
      browserContexts.delete(accountId);
      console.log(`[Playwright Worker] Đã đóng trình duyệt cho tài khoản ${accountId}.`);
      // Đợi 1.5s để hệ điều hành giải phóng hoàn toàn các file bị khóa
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } catch (error) {
    console.error(`[Playwright Worker] Lỗi khi đóng trình duyệt ${accountId}:`, error.message);
  }
};

// Hàm đóng tất cả trình duyệt đang mở (dùng khi worker rảnh rỗi)
export const closeAllBrowsers = async () => {
  console.log(`[Playwright Worker] Yêu cầu đóng TẤT CẢ trình duyệt...`);
  const keys = Array.from(browserContexts.keys());
  for (const accountId of keys) {
    await closeBrowser(accountId);
  }
};

// Hàm lấy ảnh mã QR (Base64)
export const getLoginQRCode = async (accountId = 'default') => {
  try {
    const context = await initBrowser(accountId);
    const pages = context.pages();
    const page = pages[pages.length - 1];

    if (!page) throw new Error('Không có tab trình duyệt nào đang mở');

    // Chờ cho trang ổn định (Zalo có thể chuyển hướng từ chat.zalo.me sang id.zalo.me)
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000); // Đợi thêm 3s cho QR render bằng JS

    let qrBase64 = '';
    try {
      // Zalo thường bọc mã QR trong div có class chứa 'qrcode' hoặc 'qr'
      // Ưu tiên tìm thẻ img hoặc canvas nằm trong đó
      const qrElement = await page.waitForSelector('img[alt*="QR"], canvas, .qrcode, [class*="qr-code"]', { timeout: 10000 });
      const buffer = await qrElement.screenshot();
      qrBase64 = 'data:image/png;base64,' + buffer.toString('base64');
    } catch (e) {
      console.log('[Playwright Worker] Không tìm thấy selector QR chính xác, đang chụp toàn bộ màn hình...');
      // Backup: Chụp 1 vùng vuông ở giữa màn hình (nơi thường chứa mã QR)
      const buffer = await page.screenshot({ clip: { x: 400, y: 200, width: 300, height: 300 } });
      qrBase64 = 'data:image/png;base64,' + buffer.toString('base64');
    }

    return qrBase64;
  } catch (error) {
    console.error('[Playwright Worker] Lỗi khi lấy mã QR:', error.message);
    throw error;
  }
};

// Hàm gửi tin nhắn
export const sendMessageToZalo = async (accountId = 'default', to, messageTemplate, imagePath = null) => {
  try {
    const context = await initBrowser(accountId);
    const page = context.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!page) throw new Error('Không tìm thấy trang chat.zalo.me');

    console.log(`[Playwright Worker] Đang tìm kiếm người dùng: ${to}...`);

    // [BỔ SUNG] Đóng các popup Welcome/Quảng cáo nếu có để không bị che thanh tìm kiếm
    try {
      const closeBtn = page.locator('.modal-close, [icon="close"], [icon="Close"], [icon="icn-Close"], [icon="OutlineClose"], .fa-close, button[title*="Đóng" i], button[title*="Close" i]').first();
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click();
        console.log(`[Playwright Worker] Đã dọn dẹp các Popup cản đường!`);
        await page.waitForTimeout(1000);
      }
    } catch (e) { }

    // Tự động nhận diện thanh tìm kiếm bằng nhiều phương pháp vì Zalo thay đổi class liên tục (Kể cả khi là thẻ div contenteditable)
    const searchSelector = '#contact-search-input, #global-search-input, [data-translate-placeholder="STR_SEARCH_CONTACT"], [placeholder*="Tìm kiếm" i]';

    // 1. Click vào ô tìm kiếm
    await page.locator(searchSelector).first().click();

    // [ANTI-BAN] Giả lập di chuyển chuột trước khi thao tác
    const randomX = Math.floor(Math.random() * 500) + 100;
    const randomY = Math.floor(Math.random() * 500) + 100;
    await page.mouse.move(randomX, randomY);
    await page.waitForTimeout(Math.floor(Math.random() * 1000) + 500);

    // XÓA TRẮNG Ô TÌM KIẾM CŨ (Khắc phục lỗi dính chùm số điện thoại nếu lượt trước tìm thất bại)
    await page.locator(searchSelector).first().fill('');
    await page.waitForTimeout(300);

    // 2. Gõ tên người nhận hoặc SĐT (chậm rãi)
    await page.locator(searchSelector).first().pressSequentially(to, { delay: 150 });

    // 3. Xử lý kết quả tìm kiếm an toàn (Khắc phục lỗi Blind Enter)
    console.log(`[Playwright Worker] Chờ Zalo phản hồi kết quả tìm kiếm...`);
    try {
      const searchResultStr = await Promise.race([
        page.waitForSelector('text="Không tìm thấy kết quả"', { timeout: 5000 }).then(() => 'NOT_FOUND'),
        page.waitForSelector('text="Số điện thoại chưa đăng ký Zalo"', { timeout: 5000 }).then(() => 'NOT_FOUND'),
        page.waitForSelector('.list-search-result', { timeout: 5000 }).then(() => 'FOUND'),
        page.waitForSelector('.contact-item', { timeout: 5000 }).then(() => 'FOUND')
      ]);

      if (searchResultStr === 'NOT_FOUND') {
        throw new Error('Số điện thoại không tồn tại trên Zalo hoặc không tìm thấy kết quả.');
      }

      // Bấm Enter để vào chat
      await page.keyboard.press('Enter');

      // Đợi một chút để khung chat bên phải load
      await page.waitForTimeout(1500);

    } catch (e) {
      if (e.message.includes('Số điện thoại không tồn tại')) {
        throw e; // Văng lỗi ra ngoài để đánh dấu Job Failed
      }
      // Nếu bị timeout ở Promise.race (mạng lag quá 5s hoặc Zalo đổi hoàn toàn class/text)
      console.log(`[Playwright Worker] Cảnh báo: Hết thời gian chờ phản hồi tìm kiếm, thử ấn Enter dự phòng...`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    }

    // 4. Xử lý Spintax (Ví dụ: {Chúc|Mong|Thân chúc})
    let finalMessage = messageTemplate.replace(/\{([^{}]*\|[^{}]*)\}/g, (match, p1) => {
      const options = p1.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });

    // 5. Xử lý Shortcodes cá nhân hóa
    let actualName = to; // Mặc định là chuỗi tìm kiếm
    try {
      // Thử lấy tên thật trên Header của cửa sổ chat
      actualName = await page.innerText('.header-title');
    } catch (e) { }

    const nameParts = actualName.split(' ');
    const firstName = nameParts[nameParts.length - 1] || '';
    const lastName = nameParts[0] || '';

    const now = new Date();
    const dateStr = now.toLocaleDateString('vi-VN');
    const timeStr = now.toLocaleTimeString('vi-VN');
    const yearStr = now.getFullYear().toString();
    const randomStr = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit random

    finalMessage = finalMessage
      .replace(/{name}/g, actualName)
      .replace(/{first_name}/g, firstName)
      .replace(/{last_name}/g, lastName)
      .replace(/{date}/g, dateStr)
      .replace(/{datetime}/g, `${timeStr} ${dateStr}`)
      .replace(/{year}/g, yearStr)
      .replace(/{random}/g, randomStr);

    // Xử lý gửi ẢNH nếu có
    if (imagePath && fs.existsSync(imagePath)) {
      console.log(`[Playwright Worker] Tiến hành đổi Hash ảnh và đính kèm ảnh...`);
      // Tạo file output tạm để đổi hash
      const modifiedImagePath = imagePath.replace(/(\.[\w\d_-]+)$/i, '_hashed$1');
      await randomizeImageHash(imagePath, modifiedImagePath);

      // Dùng waitForEvent('filechooser') để đón đầu hộp thoại chọn file của HĐH
      // Đã được thay thế bằng setInputFiles để tối ưu hóa và chống lỗi trên Zalo mới
      try {
        console.log(`[Playwright Worker] Đang tìm thẻ input file ẩn để upload...`);
        // Gắn file trực tiếp qua setInputFiles
        await page.setInputFiles('input[type="file"][accept*="image"]', modifiedImagePath, { timeout: 5000 });
        console.log(`[Playwright Worker] Đã đính kèm ảnh thành công bằng setInputFiles, đợi preview load...`);
        await page.waitForTimeout(2500); // Đợi ảnh nạp vào khung chat
      } catch (err) {
        console.log(`[Playwright Worker] setInputFiles thất bại. Thử click icon đính kèm...`);
        try {
          // Fallback: Mở thư mục chọn file thủ công bằng các class mới của Zalo
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10000 }),
            page.locator('[icon="OutlineImage"], [icon="Photo"], .chat-box-photo-btn, [title*="hình ảnh" i]').first().click({ timeout: 5000 })
          ]);
          await fileChooser.setFiles(modifiedImagePath);
          console.log(`[Playwright Worker] Đã đính kèm ảnh thành công thông qua FileChooser.`);
          await page.waitForTimeout(2500);
        } catch (err2) {
          console.log(`[Playwright Worker] CẢNH BÁO MẠNH: Thất bại toàn bộ cách đính kèm ảnh! Ảnh sẽ bị bỏ qua. Chi tiết: ${err2.message}`);
        }
      }

      // Xóa file tạm đã hash sau 30 giây để đảm bảo Zalo đã upload xong
      setTimeout(() => {
        deleteTempImage(modifiedImagePath);
      }, 30000);

      // KHÔNG XÓA imagePath (ảnh gốc) ở đây vì các số điện thoại tiếp theo trong chiến dịch vẫn cần dùng nó!
    }

    // 6. Gõ nội dung vào ô nhập tin nhắn (Gõ phím chậm hơn - giống người thật)
    console.log(`[Playwright Worker] Gõ nội dung tin nhắn: "${finalMessage}"`);
    const chatInputSelector = '#chatInput, #richInput, [data-id="div_Main_Input_Container"] [contenteditable="true"]';
    await page.locator(chatInputSelector).first().click(); // Click vào ô đầu tiên tìm được
    await page.locator(chatInputSelector).first().pressSequentially(finalMessage, { delay: 80 });


    // 7. Bấm gửi (Enter)
    console.log(`[Playwright Worker] Bấm Gửi (Enter)...`);
    await page.keyboard.press('Enter');

    // 8. Kiểm tra xem có bị chặn tin nhắn người lạ không
    console.log(`[Playwright Worker] Đang kiểm tra trạng thái gửi (đợi 2.5s)...`);
    await page.waitForTimeout(2500); // Nán lại 2.5s để Zalo phản hồi trạng thái mạng

    const isBlocked = await page.evaluate(() => {
      // 1. Kiểm tra các cảnh báo hệ thống hiển thị trong khung chat (như "Người này không nhận tin nhắn từ người lạ")
      const messages = Array.from(document.querySelectorAll('.chat-message, .message-view, .system-message, .chat-content, .error-msg'));
      const lastFewMessages = messages.slice(-5); // Lấy 5 tin nhắn/thông báo gần nhất

      for (const msg of lastFewMessages) {
        const text = msg.innerText?.toLowerCase() || '';
        if (
          text.includes('không nhận tin nhắn từ người lạ') ||
          text.includes('chỉ nhận tin nhắn từ bạn bè') ||
          text.includes('đã chặn bạn') ||
          text.includes('chưa thể gửi tin nhắn') ||
          text.includes('tin nhắn chưa được gửi')
        ) {
          return true;
        }

        // 2. Kiểm tra icon báo lỗi (dấu chấm than đỏ) trên tin nhắn vừa gửi
        if (msg.querySelector('.icn-error, .icon-error, [icon="outline-warning-circle"], i.fa-exclamation-circle')) {
          return true;
        }
      }
      return false;
    });

    if (isBlocked) {
      throw new Error('Bị chặn: Người dùng không nhận tin nhắn từ người lạ hoặc tin nhắn gửi thất bại.');
    }

    console.log(`[Playwright Worker] Hoàn thành luồng gửi tin cho ${to}`);

  } catch (error) {
    console.error(`[Playwright Worker] Lỗi khi gửi tin cho ${to}:`, error);
    throw error;
  }
};



// Hàm quét và đồng bộ danh bạ
export const syncZaloContacts = async (accountId = 'default') => {
  try {
    const context = await initBrowser(accountId);
    const page = context.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!page) throw new Error('Không tìm thấy trang chat.zalo.me');

    console.log('[Playwright Worker] Đang chuyển sang tab Danh bạ (để quét Bạn bè)...');
    
    // Đóng popup cản đường
    try {
      const closeBtn = page.locator('.modal-close, [icon*="lose" i], [icon*="close" i], button[title*="Đóng" i]').first();
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) { }

    try {
      // Click icon Danh Bạ
      const contactIcon = page.locator('[title*="Danh bạ" i], [data-translate-inner="STR_TAB_CONTACT"], .icn-Contact, [icon*="Contact" i], [icon*="contact" i]').first();
      await contactIcon.click({ timeout: 10000 });
      await page.waitForTimeout(1500); 

      // Click vào "Danh sách bạn bè"
      try {
        const friendListTab = page.getByText(/Danh sách bạn bè/i).first();
        await friendListTab.click({ timeout: 4000 });
      } catch (err) {
        const friendListFallback = page.locator('[title="Danh sách bạn bè"], [title="Danh sách Bạn bè"], [data-translate-inner="STR_CONTACT_LIST"], [icon="icn-Add-Friend"]').first();
        await friendListFallback.click({ timeout: 4000 });
      }
      console.log('[Playwright Worker] Đã vào đúng giao diện Danh sách bạn bè.');
    } catch (e) {
      console.log('[Playwright Worker] CẢNH BÁO: Lỗi điều hướng Danh Bạ:', e.message);
    }

    await page.waitForTimeout(2000); 

    console.log('[Playwright Worker] Bắt đầu quét BẠN BÈ bằng con lăn chuột (Hardware Mouse Wheel)...');

    const rawContacts = await (async () => {
      const contactsMap = new Map();
      let unchangedScrolls = 0;
      let lastCount = 0;

      // Tìm tọa độ vùng chứa an toàn để trỏ chuột
      const boundingBox = await page.evaluate(() => {
        const grids = Array.from(document.querySelectorAll('.ReactVirtualized__Grid, .contact-list, [data-id="div_Contact_List"]'));
        let maxArea = 0;
        let target = null;
        for (const grid of grids) {
          const rect = grid.getBoundingClientRect();
          if (rect.left > 300 && (rect.width * rect.height > maxArea)) {
            maxArea = rect.width * rect.height;
            target = rect;
          }
        }
        return target ? { x: target.left + target.width / 2, y: target.top + target.height / 2 } : null;
      });

      if (boundingBox) {
         await page.mouse.move(boundingBox.x, boundingBox.y);
      } else {
         await page.mouse.move(800, 400);
      }

      while (unchangedScrolls < 5 && contactsMap.size < 5000) {
        const visibleContacts = await page.evaluate(() => {
          const results = [];
          const grids = Array.from(document.querySelectorAll('.ReactVirtualized__Grid, .contact-list, [data-id="div_Contact_List"]'));
          let mainContainer = null;
          let maxArea = 0;
          for (const grid of grids) {
            const rect = grid.getBoundingClientRect();
            if (rect.left > 300 && (rect.width * rect.height > maxArea)) {
              maxArea = rect.width * rect.height;
              mainContainer = grid;
            }
          }
          if (!mainContainer) return results;

          const nameEls = mainContainer.querySelectorAll('.name, .conv-item-title__name, .truncate, .text-truncate, .item-title, [data-id="div_Item_Name"]');
          nameEls.forEach(nameEl => {
            let name = nameEl.innerText ? nameEl.innerText.trim().split('\n')[0] : '';
            if (!name || name.length < 2) return;
            const ignoreList = ['Tìm kiếm', 'Cài đặt', 'Thử ngay', 'Tìm hiểu thêm', 'Lời mời kết bạn', 'Từ danh bạ máy', 'Tất cả', 'Tên (A-Z)', 'Tên (Z-A)', 'Hoạt động'];
            if (ignoreList.includes(name) || name.length === 1) return;
            results.push({ name, zaloId: `zalo_id_${name}`, avatar: '' });
          });
          return results;
        });

        visibleContacts.forEach(c => {
          if (!contactsMap.has(c.name)) contactsMap.set(c.name, c);
        });

        if (contactsMap.size === lastCount) {
          unchangedScrolls++;
        } else {
          unchangedScrolls = 0;
          lastCount = contactsMap.size;
        }

        if (unchangedScrolls < 5) {
           // Giả lập lăn chuột hệt như người thật
           await page.mouse.wheel(0, Math.floor(Math.random() * 400) + 400);
           await page.waitForTimeout(Math.floor(Math.random() * 400) + 800);
        }
      }
      return Array.from(contactsMap.values());
    })();

    console.log(`[Playwright Worker] Vét cạn an toàn thành công! Đã quét được ${rawContacts.length} liên hệ.`);

    if (rawContacts.length > 0) {
      const contactsToSave = rawContacts.map(c => ({
        accountId,
        zaloId: c.zaloId,
        name: c.name,
        avatar: c.avatar,
        type: 'friend'
      }));
      
      console.log(`\n[Playwright Worker] ===== DỮ LIỆU BẠN BÈ QUÉT ĐƯỢC TRƯỚC KHI LƯU =====\n`, JSON.stringify(contactsToSave, null, 2), `\n==================================================================\n`);

      await Contact.deleteMany({ accountId });
      await Contact.insertMany(contactsToSave);
      console.log(`[Playwright Worker] Cập nhật DB thành công! Đã lưu ${contactsToSave.length} liên hệ.`);
    } else {
      console.log('[Playwright Worker] Không quét được liên hệ nào.');
    }
    return true;
  } catch (error) {
    console.error('[Playwright Worker] Lỗi đồng bộ danh bạ:', error);
    throw error;
  }
};

export const syncZaloGroups = async (accountId = 'default') => {
  try {
    const context = await initBrowser(accountId);
    const page = context.pages().find(p => p.url().includes('chat.zalo.me'));
    if (!page) throw new Error('Không tìm thấy trang chat.zalo.me');

    console.log('[Playwright Worker] Đang chuyển sang tab Danh bạ (để quét Nhóm)...');
    
    // [BỔ SUNG] Đóng các popup Welcome/Quảng cáo nếu có để không bị che nút bấm
    try {
      const closeBtn = page.locator('.modal-close, [icon*="lose" i], [icon*="close" i], button[title*="Đóng" i]').first();
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click();
        console.log(`[Playwright Worker] Đã đóng Popup quảng cáo cản đường!`);
        await page.waitForTimeout(1000);
      }
    } catch (e) { }

    try {
      // Cập nhật thêm nhiều selector nhận diện icon Danh bạ để tương thích các phiên bản Zalo khác nhau
      const contactIcon = page.locator('[title*="Danh bạ" i], [data-translate-inner="STR_TAB_CONTACT"], .icn-Contact, [icon*="Contact" i], [icon*="contact" i]').first();
      // Tăng thời gian chờ lên 10s đề phòng mạng chậm hoặc Zalo tải lâu
      await contactIcon.click({ timeout: 10000 });
      await page.waitForTimeout(1500); 

      // Click vào mục "Danh sách nhóm và cộng đồng"
      try {
        const groupListTab = page.getByText(/Danh sách nhóm/i).first();
        await groupListTab.click({ timeout: 4000 });
      } catch (err) {
        const groupListFallback = page.locator('[title="Danh sách nhóm"], [data-translate-inner="STR_GROUP_LIST"]').first();
        await groupListFallback.click({ timeout: 4000 });
      }
      console.log('[Playwright Worker] Đã vào giao diện Danh sách nhóm.');
    } catch (e) {
      console.log('[Playwright Worker] CẢNH BÁO: Lỗi điều hướng Danh sách nhóm:', e.message);
    }

    await page.waitForTimeout(2000); 

    console.log('[Playwright Worker] Bắt đầu quét NHÓM bằng con lăn chuột (Hardware Mouse Wheel)...');

    const rawGroups = await (async () => {
      let groupsMap = new Map();
      let unchangedScrolls = 0;
      let lastCount = 0;

      // Tìm tọa độ vùng chứa an toàn để trỏ chuột
      const boundingBox = await page.evaluate(() => {
        const grids = Array.from(document.querySelectorAll('.ReactVirtualized__Grid, .contact-list, [data-id="div_Contact_List"]'));
        let maxArea = 0;
        let target = null;
        for (const grid of grids) {
          const rect = grid.getBoundingClientRect();
          if (rect.left > 300 && (rect.width * rect.height > maxArea)) {
            maxArea = rect.width * rect.height;
            target = rect;
          }
        }
        return target ? { x: target.left + target.width / 2, y: target.top + target.height / 2 } : null;
      });

      if (boundingBox) {
         await page.mouse.move(boundingBox.x, boundingBox.y);
      } else {
         await page.mouse.move(800, 400);
      }

      while (unchangedScrolls < 5 && groupsMap.size < 2000) {
        const visibleGroups = await page.evaluate(() => {
          const results = [];
          const grids = Array.from(document.querySelectorAll('.ReactVirtualized__Grid, .contact-list, [data-id="div_Contact_List"]'));
          let mainContainer = null;
          let maxArea = 0;
          for (const grid of grids) {
            const rect = grid.getBoundingClientRect();
            if (rect.left > 300 && (rect.width * rect.height > maxArea)) {
              maxArea = rect.width * rect.height;
              mainContainer = grid;
            }
          }
          if (!mainContainer) return results;

          const nameEls = mainContainer.querySelectorAll('.name, .conv-item-title__name, .truncate, .text-truncate, .item-title, [data-id="div_Item_Name"]');
          nameEls.forEach(nameEl => {
            let name = nameEl.innerText ? nameEl.innerText.trim().split('\n')[0] : '';
            if (!name || name.length < 2) return;
            const ignoreList = ['Tìm kiếm', 'Cài đặt', 'Thử ngay', 'Tìm hiểu thêm', 'Tất cả', 'Phân loại', 'Chưa đọc', 'Hoạt động (mới → cũ)', 'Hoạt động (cũ → mới)'];
            if (ignoreList.includes(name)) return;
            results.push({ name, zaloId: `zalo_id_group_${name}`, avatar: '' });
          });
          return results;
        });

        visibleGroups.forEach(g => {
          if (!groupsMap.has(g.name)) groupsMap.set(g.name, g);
        });

        if (groupsMap.size === lastCount) {
          unchangedScrolls++;
        } else {
          unchangedScrolls = 0;
          lastCount = groupsMap.size;
        }

        if (unchangedScrolls < 5) {
           await page.mouse.wheel(0, Math.floor(Math.random() * 400) + 400);
           await page.waitForTimeout(Math.floor(Math.random() * 400) + 800);
        }
      }
      return Array.from(groupsMap.values());
    })();

    console.log(`[Playwright Worker] Vét cạn an toàn thành công! Đã quét được ${rawGroups.length} nhóm.`);

    if (rawGroups.length > 0) {
      await Group.deleteMany({ accountId });

      const groupsToSave = rawGroups.map(g => ({
        accountId,
        zaloId: g.zaloId,
        name: g.name,
        avatar: g.avatar,
        type: 'group'
      }));

      console.log(`\n[Playwright Worker] ===== DỮ LIỆU NHÓM QUÉT ĐƯỢC TRƯỚC KHI LƯU =====\n`, JSON.stringify(groupsToSave, null, 2), `\n==================================================================\n`);
      
      await Group.insertMany(groupsToSave);
      console.log(`[Playwright Worker] Cập nhật DB thành công! Đã lưu ${groupsToSave.length} nhóm.`);
    } else {
      console.log('[Playwright Worker] Không quét được nhóm nào.');
    }
    return true;
  } catch (error) {
    console.error('[Playwright Worker] Lỗi đồng bộ nhóm:', error);
    throw error;
  }
};
