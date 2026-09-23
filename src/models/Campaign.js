import mongoose from 'mongoose';

const campaignSchema = new mongoose.Schema({
  accountId: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  messageTemplate: {
    type: String,
    required: true
  },
  attachmentType: {
    type: String,
    enum: ['text', 'image', 'video'],
    default: 'text'
  },
  recipients: [{
    contactId: {
      type: String
    },
    name: String,
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending'
    },
    errorMessage: String
  }],
  status: {
    type: String,
    enum: ['draft', 'running', 'paused', 'completed', 'cancelled'],
    default: 'draft'
  },
  scheduleAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

export const Campaign = mongoose.model('Campaign', campaignSchema);
