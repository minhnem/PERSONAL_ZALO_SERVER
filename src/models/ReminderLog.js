import mongoose from 'mongoose';

const logSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: String,
  phone: String,
  productName: String,
  accountId: String,
  status: { type: String, enum: ['success', 'failed'] },
  errorMessage: String,
  createdAt: { type: Date, default: Date.now }
});

export const ReminderLog = mongoose.model('ReminderLog', logSchema);
