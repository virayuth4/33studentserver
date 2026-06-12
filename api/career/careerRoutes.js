const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../rateLimiter");
const {upload, uploadFileToS3, deleteFileFromS3, uploadMediaFilesToS3} = require("../../database/s3")

const fs = require('fs');




const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 1; // 1 image for student id

async function sendJobApplicationToTelegramNotification(name, university, phone, availability, interest, fileData) {
  const message = `🎓 *New Job Application Submission*\n\n👤 *Name:* ${name}\n🏫 *University:* ${university}\n📞 *Phone:* ${phone}\n⏰ *Availability:* ${availability}\n💭 *Interest:* ${interest}`;
  
  // console.log('Sending Job Application to Telegram notification with message:', message);
  
  try {
    const botToken = String(process.env.TELEGRAM_SUPPORT_BOT_TOKEN.trim());
    const chatId = Number(process.env.TELEGRAM_CHAT_ID.trim());

    // Check if we have file data
    if (fileData && (fileData.buffer || fileData.path)) {
      const photoUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;
      console.log('Telegram Photo API URL:', photoUrl);
      
      // Create form data using form-data package (Node.js compatible)
      const FormData = require('form-data');
      const form = new FormData();
      
      form.append('chat_id', chatId);
      form.append('caption', message);
      form.append('parse_mode', 'Markdown');
      
      // Handle both buffer and file path cases
      if (fileData.buffer) {
        // Using buffer (memory storage)
        form.append('photo', fileData.buffer, {
          filename: fileData.originalname || 'student_id.png',
          contentType: fileData.mimetype || 'image/png'
        });
      } else if (fileData.path) {
        // Using file path (disk storage)
        form.append('photo', fs.createReadStream(fileData.path), {
          filename: fileData.originalname || 'student_id.png',
          contentType: fileData.mimetype || 'image/png'
        });
      }
      
      const response = await axios.post(photoUrl, form, {
        headers: {
          ...form.getHeaders(),
        },
      });
      
      console.log('Telegram photo notification sent successfully');
      return { success: true, messageId: response.data.result.message_id };
      
    } else {
      // Fallback: Send text message only if no image
      const textUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      console.log('Telegram Text API URL:', textUrl);
      
      await axios.post(textUrl, {
        chat_id: chatId,
        text: message + '\n\n⚠️ *Note:* Student ID image was not attached.',
        parse_mode: 'Markdown'
      });
      
      console.log('Telegram text notification sent successfully');
      return { success: true };
    }
    
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
    if (error.response) {
      console.error('Telegram API Error:', error.response.data);
    }
    return { success: false, error: error.message };
  }
}

router.post('/career/application', 
  createRateLimiterMiddleware,
  (req, res) => {
    upload.fields([
      { name: 'studentIdImage', maxCount: 1 },
    ])(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        // Handle multer-specific errors
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ 
            error: `File size is too large. Maximum size is 50MB.` 
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ 
            error: `Too many files. Maximum is 11 files (8 images + 3 videos).` 
          });
        }
        return res.status(400).json({ error: err.message });
      } else if (err) {
        return res.status(400).json({ error: err.message });
      }

      // This code runs AFTER successful file upload
      console.log("===== Part Time Student Job Application Route Hit =====");
      // console.log("Request Body:", req.body);
      // console.log("Files:", req.files);
      
      // Access the uploaded file
      const studentIdImage = req.files['studentIdImage'] ? req.files['studentIdImage'][0] : null;
      // console.log("Student ID Image:", studentIdImage);

      try {
        // Process the application data
        const { name, university, phone, availability, interest } = req.body;
        
        // Validate required fields
        if (!name || !university || !phone || !availability || !interest) {
          return res.status(400).json({ 
            error: 'Please fill out all required fields.' 
          });
        }

        if (!studentIdImage) {
          return res.status(400).json({ 
            error: 'Please upload your university ID image.' 
          });
        }

        if (studentIdImage) {
          const result = await sendJobApplicationToTelegramNotification(
            name, 
            university, 
            phone, 
            availability, 
            interest,
            studentIdImage  // This is the file path from multer
          );
          
          if (!result.success) {
            console.error('Failed to send Telegram notification:', result.error);
          }
        }

       

        console.log('Application data processed successfully');
        
        // Send success response
        res.status(200).json({ 
          message: 'Application submitted successfully!',
         
        });

      } catch (error) {
        console.error('Error processing application:', error);
        res.status(500).json({ 
          error: 'Internal server error. Please try again.' 
        });
      }
    });
  }
);

module.exports = router;