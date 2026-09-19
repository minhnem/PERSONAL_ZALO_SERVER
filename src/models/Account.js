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
  zcaCredentials: {
    type: Object, // { cookie, imei, userAgent } cho đăng nhập zca-js
    default: null
  },
  zcaStatus: {
    type: String,
    enum: ['connected', 'disconnected', 'error'],
    default: 'disconnected'
  },
  lastSyncAt: Date,
  dailySentCount: {
    type: Number,
    default: 0
  },
  lastSentDate: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

export const Account = mongoose.model('Account', accountSchema);
