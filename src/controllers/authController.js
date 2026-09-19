import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

const JWT_SECRET = process.env.JWT_SECRET || 'ZALO_SUPER_SECRET_KEY_2026';

export const login = async (req, res) => {
  try {
    const { username, password, machineId } = req.body;

    if (!username || !password || !machineId) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp username, password và machineId' });
    }

    // 1. Tìm user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ success: false, error: 'Tài khoản hoặc mật khẩu không chính xác' });
    }

    // 2. Kiểm tra mật khẩu
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Tài khoản hoặc mật khẩu không chính xác' });
    }

    // 3. Kiểm tra trạng thái và hạn sử dụng
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, error: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ Admin.' });
    }

    if (new Date() > new Date(user.expireAt)) {
      return res.status(403).json({ success: false, error: 'Tài khoản đã hết hạn bản quyền.' });
    }

    // 4. Kiểm tra mã máy (Hardware Lock)
    if (!user.machineId) {
      // Đăng nhập lần đầu -> Khóa luôn vào máy này
      user.machineId = machineId;
      await user.save();
    } else if (user.machineId !== machineId) {
      // Đã khóa vào máy khác
      return res.status(403).json({ 
        success: false, 
        error: 'Tài khoản này đang được sử dụng ở một thiết bị khác. Không thể đăng nhập!' 
      });
    }

    // 5. Cấp Token
    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, machineId: user.machineId },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      token,
      user: {
        name: user.name,
        username: user.username,
        role: user.role,
        expireAt: user.expireAt
      }
    });

  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ success: false, error: 'Lỗi máy chủ nội bộ' });
  }
};

export const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Không tìm thấy Token xác thực' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Người dùng không tồn tại' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, error: 'Tài khoản đã bị khóa' });
    }

    if (new Date() > new Date(user.expireAt)) {
      return res.status(403).json({ success: false, error: 'Tài khoản đã hết hạn' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
       return res.status(401).json({ success: false, error: 'Token đã hết hạn, vui lòng đăng nhập lại' });
    }
    return res.status(401).json({ success: false, error: 'Token không hợp lệ' });
  }
};

export const verifyHeartbeat = async (req, res) => {
  // Nhờ middleware verifyToken ở trên, nếu chạy đến đây thì account vẫn hợp lệ
  res.json({
    success: true,
    message: 'Tài khoản hợp lệ',
    user: {
      expireAt: req.user.expireAt,
      status: req.user.status
    }
  });
};

export const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ success: false, error: 'Bạn không có quyền quản trị viên' });
  }
};
