import dotenv from 'dotenv';
dotenv.config();

export default {
  port: process.env.PORT || 3000,
  facebook: {
    verifyToken: process.env.VERIFY_TOKEN,
    pageAccessToken: process.env.PAGE_ACCESS_TOKEN,
  },
  ai: {
    apiKey: process.env.AI_API_KEY,
  }
};
