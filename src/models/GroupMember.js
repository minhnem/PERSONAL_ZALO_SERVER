import mongoose from 'mongoose';

const groupMemberSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true,
    index: true
  },
  groupId: {
    type: String,
    required: true,
    index: true // Tăng tốc độ truy vấn theo nhóm
  },
  zaloId: {
    type: String, // UID của thành viên (UID thật nếu quét bằng API, hoặc zalo_id_mem_... nếu quét bằng Playwright)
    required: true
  },
  displayName: {
    type: String,
    default: '' // Tên hiển thị gốc từ Zalo (zaloName/displayName từ API)
  },
  name: {
    type: String,
    required: true
  },
  avatar: {
    type: String,
    default: ''
  }
}, { timestamps: true });

// Tránh trùng lặp 1 người trong 1 nhóm của 1 tài khoản
groupMemberSchema.index({ accountId: 1, groupId: 1, zaloId: 1 }, { unique: true });

export const GroupMember = mongoose.model('GroupMember', groupMemberSchema);
