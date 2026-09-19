import { Customer } from '../models/Customer.js';
import { ReminderRule } from '../models/ReminderRule.js';

export const getCustomers = async (req, res) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 });
    res.json({ success: true, data: customers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const addCustomer = async (req, res) => {
  try {
    const { name, phone, status, trackedProducts } = req.body;
    
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Thiếu tên hoặc số điện thoại' });
    }

    // Process trackedProducts to calculate expectedEmptyDate if not provided, based on rule
    const processedProducts = [];
    if (trackedProducts && Array.isArray(trackedProducts)) {
      for (const prod of trackedProducts) {
        let emptyDate = prod.expectedEmptyDate;
        
        // If emptyDate is not provided, try to calculate from Rule
        if (!emptyDate && prod.purchaseDate) {
          const rule = await ReminderRule.findOne({ productName: prod.productName });
          if (rule && rule.cycleDays) {
            const purchase = new Date(prod.purchaseDate);
            purchase.setDate(purchase.getDate() + rule.cycleDays - (rule.remindBeforeDays || 0));
            emptyDate = purchase;
          } else {
            // Default to 30 days if no rule found
            const purchase = new Date(prod.purchaseDate);
            purchase.setDate(purchase.getDate() + 30);
            emptyDate = purchase;
          }
        }

        processedProducts.push({
          ...prod,
          expectedEmptyDate: emptyDate || new Date()
        });
      }
    }

    const customer = await Customer.findOneAndUpdate(
      { phone },
      { 
        name, 
        status: status || 'active',
        trackedProducts: processedProducts 
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, data: customer });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, status, trackedProducts } = req.body;
    
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Thiếu tên hoặc số điện thoại' });
    }

    const processedProducts = [];
    if (trackedProducts && Array.isArray(trackedProducts)) {
      for (const prod of trackedProducts) {
        let emptyDate = prod.expectedEmptyDate;
        if (!emptyDate && prod.purchaseDate) {
          const rule = await ReminderRule.findOne({ productName: prod.productName });
          if (rule && rule.cycleDays) {
            const purchase = new Date(prod.purchaseDate);
            purchase.setDate(purchase.getDate() + rule.cycleDays - (rule.remindBeforeDays || 0));
            emptyDate = purchase;
          } else {
            const purchase = new Date(prod.purchaseDate);
            purchase.setDate(purchase.getDate() + 30);
            emptyDate = purchase;
          }
        }
        processedProducts.push({
          ...prod,
          expectedEmptyDate: emptyDate || new Date()
        });
      }
    }

    const customer = await Customer.findByIdAndUpdate(
      id,
      { name, phone, status, trackedProducts: processedProducts },
      { new: true }
    );
    res.json({ success: true, data: customer });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const deleteCustomer = async (req, res) => {
  try {
    await Customer.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Đã xóa khách hàng' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
