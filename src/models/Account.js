import mongoose from 'mongoose';

const accountSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  name: String,
  avatar: String,
  status: {
    type: String,
    enum: ['active', 'disconnected', 'banned', 'syncing'],
    default: 'disconnected'
  },
  sessionFolder: {
    type: String, // Path to Playwright userData folder
    required: true
  },
  lastSyncAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

export const Account = mongoose.model('Account', accountSchema);
