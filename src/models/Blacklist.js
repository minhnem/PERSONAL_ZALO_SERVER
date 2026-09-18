import mongoose from 'mongoose';

const BlacklistSchema = new mongoose.Schema({
  accountId: { type: String, required: true, index: true },
  contactId: { type: String, required: true, index: true },
  name: { type: String, default: 'Không tên' },
  avatar: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

// Mỗi contactId chỉ bị chặn 1 lần trên mỗi accountId
BlacklistSchema.index({ accountId: 1, contactId: 1 }, { unique: true });

export const Blacklist = mongoose.model('Blacklist', BlacklistSchema);
