import { Jimp } from 'jimp';
import fs from 'fs';
import path from 'path';

/**
 * Thêm 1 pixel ngẫu nhiên vào ảnh để thay đổi mã MD5 Hash, giúp chống thuật toán quét spam của Zalo.
 * @param {string} inputPath - Đường dẫn tới file ảnh gốc
 * @param {string} outputPath - Đường dẫn để lưu file ảnh đã xử lý
 * @returns {Promise<string>} Đường dẫn file kết quả
 */
export const randomizeImageHash = async (inputPath, outputPath) => {
  try {
    // Đọc ảnh bằng Jimp
    const image = await Jimp.read(inputPath);
    
    // Lấy kích thước ảnh
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    
    // Chọn tọa độ X, Y ngẫu nhiên (tránh sát viền để đỡ bị cắt)
    const randomX = Math.floor(Math.random() * (width - 10)) + 5;
    const randomY = Math.floor(Math.random() * (height - 10)) + 5;
    
    // Tạo 1 màu ngẫu nhiên (chênh lệch rất nhẹ so với màu cũ hoặc chỉ thay đổi độ trong suốt tí xíu)
    // Ở đây ta ghi đè 1 pixel bằng mã hex màu bất kỳ, mắt người sẽ không thể nhận ra 1 pixel giữa hàng triệu pixel
    const randomColor = Math.floor(Math.random() * 0xFFFFFFFF);
    
    // Set 1 pixel
    image.setPixelColor(randomColor, randomX, randomY);
    
    // Ghi ra file mới
    await image.write(outputPath);
    
    return outputPath;
  } catch (error) {
    console.error('[Image Modifier] Lỗi khi xử lý đổi hash ảnh:', error);
    // Fallback: Nếu lỗi, cứ copy ảnh cũ để quá trình không bị đứng
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
};

/**
 * Hàm hỗ trợ xóa file tạm sau khi gửi xong
 */
export const deleteTempImage = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Image Modifier] Đã xóa file tạm: ${filePath}`);
    }
  } catch (error) {
    console.error(`[Image Modifier] Không thể xóa file ${filePath}:`, error);
  }
};
