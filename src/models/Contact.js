import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true
  },
  zaloId: {
    type: String, // Internal Zalo ID
    required: true
  },
  name: {
    type: String,
    required: true
  },
  avatar: String,
  phoneNumber: String,
  type: {
    type: String,
    enum: ['friend', 'group'],
    default: 'friend'
  },
  tags: [String], // Array of labels (e.g. ['VIP', 'Sinh nhật'])
  lastInteraction: Date
});

// Ensure uniqueness per account
contactSchema.index({ accountId: 1, zaloId: 1 }, { unique: true });

export const Contact = mongoose.model('Contact', contactSchema);
