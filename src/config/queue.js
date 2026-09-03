import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Redis Connection (You need Redis installed and running, usually on port 6379)
const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null
});

// Zalo Message Queue
export const zaloMessageQueue = new Queue('ZaloMessages', { connection });

console.log('[Queue] BullMQ Initialized');
