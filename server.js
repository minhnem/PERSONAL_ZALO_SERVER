import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import apiRoutes from './src/routes/api.js';
import { initBrowser } from './src/scripts/playwright.worker.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.use('/api', apiRoutes);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/autozalo').then(() => {
  console.log('[MongoDB] Connected successfully');
}).catch(err => {
  console.error('[MongoDB] Connection error:', err);
});

import './src/scripts/queue.processor.js'; // Start the queue worker

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log(`[AutoZalo Server] is running on http://localhost:${PORT}`);
  
  // Initialize Background Worker
  console.log(`[Worker] Khởi tạo Playwright automation engine ở chế độ ngầm...`);
  try {
    await initBrowser(); 
  } catch (err) {
    console.error('[Worker] Lỗi khởi tạo Playwright ban đầu:', err.message);
  }
});
