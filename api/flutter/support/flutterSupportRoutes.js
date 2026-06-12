const express = require("express");
const router = express.Router();
const multer = require('multer');
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken");
const axios = require("axios");


async function sendSupportTelegramNotification(userId, topic, description) {
    const message = `New Support Submission:\n\nUser ID: ${userId}\nTopic: ${topic}\nDescription: ${description}`;
    console.log('Sending Telegram notification with message:', message);
  try {
    const botToken = String(process.env.TELEGRAM_SUPPORT_BOT_TOKEN.trim());
    const chatId = Number(process.env.TELEGRAM_CHAT_ID.trim());


    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    console.log('Telegram API URL:', url);
    
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });
    
    console.log('Telegram notification sent successfully');
    return { success: true };
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
    return { success: false, error: error.message };
  }
}

router.post("/support-ticket/submission", authenticateFirebaseToken, async (req, res) => {
    console.log("============Support Submission=============");
    const userId = req.user.id
    const { topic, description } = req.body;
    try {
        sendSupportTelegramNotification(userId, topic, description)
        res.status(200).json({
            message: "Support submission received successfully",
        });
    
    } catch (error) {
        console.error("Error in support submission:", error);
        res.status(500).json({
            message: "Internal server error",
        });
    }
   

})

module.exports = router;