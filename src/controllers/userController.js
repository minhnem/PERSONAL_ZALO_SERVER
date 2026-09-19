import { User } from '../models/User.js';
import bcrypt from 'bcrypt';

// Lấy danh sách tất cả người dùng (Cho Admin)
export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Admin tạo tài khoản mới cho khách hàng
export const createUser = async (req, res) => {
  try {
    const { name, username, password, expireAt, role } = req.body;

    if (!name || !username || !password || !expireAt) {
      return res.status(400).json({ success: false, error: 'Vui lòng điền đầy đủ thông tin bắt buộc' });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Tên đăng nhập đã tồn tại' });
    }

    const newUser = new User({
      name,
      username,
      password,
      expireAt,
      role: role || 'user',
      status: 'active'
    });

    await newUser.save();
    
    // Ẩn password trước khi trả về
    const userResponse = newUser.toObject();
    delete userResponse.password;

    res.json({ success: true, message: 'Tạo tài khoản thành công', data: userResponse });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Reset khóa máy (Cho phép người dùng đăng nhập ở máy mới)
export const resetMachineId = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });

    user.machineId = null;
    await user.save();

    res.json({ success: true, message: 'Đã reset mã máy thành công. Khách hàng có thể đăng nhập ở máy mới.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Gia hạn thời gian bản quyền
export const extendLicense = async (req, res) => {
  try {
    const { id } = req.params;
    const { newExpireAt } = req.body; // Chuỗi định dạng YYYY-MM-DD

    if (!newExpireAt) {
       return res.status(400).json({ success: false, error: 'Vui lòng cung cấp ngày hết hạn mới' });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });

    user.expireAt = new Date(newExpireAt);
    await user.save();

    res.json({ success: true, message: 'Đã gia hạn bản quyền thành công', data: { expireAt: user.expireAt } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Khóa/Mở khóa tài khoản
export const updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'active' hoặc 'banned'

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng' });

    user.status = status;
    await user.save();

    res.json({ success: true, message: `Đã cập nhật trạng thái tài khoản thành: ${status}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
