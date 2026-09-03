import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
  // Add cloudinary config here or use CLOUDINARY_URL in .env
});

export default cloudinary;
