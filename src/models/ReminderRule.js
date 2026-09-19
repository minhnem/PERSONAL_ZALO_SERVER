import mongoose from 'mongoose';

const reminderRuleSchema = new mongoose.Schema({
  campaignName: { type: String, required: true },
  productName: { type: String, required: true },
  cycleDays: { type: Number, required: true },
  remindBeforeDays: { type: Number, default: 3 },
  exactDay: { type: Boolean, default: true },
  messageContent: { type: String, required: true },
  attachedImage: { type: String } // Path or URL to the attached image
}, { timestamps: true });

// We usually want only one active reminder rule per product to avoid spamming
reminderRuleSchema.index({ productName: 1 }, { unique: true });

export const ReminderRule = mongoose.model('ReminderRule', reminderRuleSchema);
