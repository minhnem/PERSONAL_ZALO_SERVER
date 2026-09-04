import mongoose from 'mongoose';

const groupSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true,
    index: true // Tăng tốc độ truy vấn theo tài khoản
  },
  zaloId: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  avatar: {
    type: String,
    default: ''
  },
  type: {
    type: String,
    default: 'group' // Phân biệt với contact thường
  }
}, { timestamps: true });

export const Group = mongoose.model('Group', groupSchema);
