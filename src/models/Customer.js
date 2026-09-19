import mongoose from 'mongoose';

const trackedProductSchema = new mongoose.Schema({
  productName: { type: String, required: true },
  purchaseDate: { type: Date, required: true },
  quantity: { type: Number, default: 1 },
  expectedEmptyDate: { type: Date, required: true },
  hasReminded: { type: Boolean, default: false }
});

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, default: 'Unknown' },
  phone: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  trackedProducts: [trackedProductSchema]
}, { timestamps: true });

// A phone number should ideally be unique in the CRM context
customerSchema.index({ phone: 1 }, { unique: true });

export const Customer = mongoose.model('Customer', customerSchema);
