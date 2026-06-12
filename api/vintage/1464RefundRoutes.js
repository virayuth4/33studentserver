const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const {upload, uploadFileToS3, deleteFileFromS3, uploadMediaFilesToS3} = require("../../database/s3")
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateAndUpdateProductTags } = require("../../helper/productRoutesHelper/addTagHelper");
const createRateLimiterMiddleware = require("../rateLimiter");
const { sanitizeProductDescription } = require("../../utils/sanatizeHtml");
const { sanitizeFileName } = require("../../utils/sanitzieFileName");
const path = require('path');
const fs = require('fs');
const { GetRandomProducts } = require("../../algorithms/randomProduct");


async function sendRefundTelegramNotification(orderId, productId, reason, description, orderItem) {
  console.log(`Attempting to send Telegram refund notification for order ${orderId}, product ${productId}`);
  try {
    const botToken = String(process.env.TELEGRAM_ORDERS_BOT_TOKEN.trim());
    const chatId = Number(process.env.TELEGRAM_CHAT_ID.trim());

    const message =
      `🔴 *REFUND REQUEST #${orderId}*\n\n` +
      `📦 *Product ID:* ${productId}\n` +
      `📝 *Product Name:* ${orderItem.productName || 'N/A'}\n` +
      `💰 *Product Price:* $${orderItem.price  || 'N/A'}\n` +
      `💰 *Price Paid:* $${orderItem.effectivePrice || orderItem.productPrice || 'N/A'}\n` +
      `🔢 *Quantity:* ${orderItem.quantity || 'N/A'}\n\n` +
      `❓ *Reason:* ${reason}\n` +
      `📄 *Description:* ${description || 'None provided'}\n\n` +
      `🕐 *Requested At:* ${new Date().toISOString()}`;

    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });

    console.log('Telegram refund notification sent successfully');
    return { success: true };
  } catch (error) {
    console.error('Error sending Telegram refund notification:', error.message);
    return { success: false, error: error.message };
  }
}


router.get('/1464/refund/:orderId/:productId', authenticateFirebaseToken, async (req,res) => {
  console.log('=== 1464 orders product for refund route hit.===');
  try {
    const {orderId, productId} = req.params;
    console.log('Order ID:', orderId, 'Product ID:', productId);
    if (!orderId || !productId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Order ID and Product ID are required'
      });
    }

    const query = `
      SELECT 
          oi.*, 
          p."productImagePaths"
      FROM "1464_order_items" oi
      INNER JOIN "1464_products" p ON oi."productId" = p.id
      WHERE oi."orderId" = $1 AND oi."productId" = $2
      `;
    const result = await zingoPool.query(query, [orderId, productId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Order or Product not found'
      });
    }
    console.log('Order details fetched successfully:', result.rows[0]);
    res.status(200).json({
      success: true,
      data: result.rows[0]
    });
      
  } catch (e) {
    console.error(`Error with fethcing order for producrt refund: ${e.message}`)
  }
})

  
// This is the refund route used on the website to post a refund request
router.post('/1464/refund/:orderId/:productId', authenticateFirebaseToken, async (req, res) => {
    console.log('=== Apply for refund route hit===');
    
    const { orderId, productId } = req.params;
    const { reason, description } = req.body;
    console.log('Order ID:', orderId, 'Product ID:', productId);
    console.log('Reason:', reason, 'Description:', description);


    try {
        // Create the new status history entry
        const newStatusEntry = {
            status: "pendingRefund",
            timestamp: new Date().toISOString(),
            note: `Refund requested: ${reason}${description ? ` - ${description}` : ''}`,
        };

        // Update the order item with new status and append to status histories
        const updateQuery = `
            UPDATE "1464_order_items" 
            SET 
                "currentStatus" = 'pendingRefund',
                "statusHistories" = "statusHistories" || $3::jsonb
            WHERE "orderId" = $1 AND "productId" = $2
            RETURNING *;
        `;

        const result = await zingoPool.query(updateQuery, [
            orderId, 
            productId, 
            JSON.stringify(newStatusEntry)
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Order item not found'
            });
        }

        console.log('Order item updated successfully:', result.rows[0]);

        // Send Telegram notification (non-blocking — won't fail the request if it errors)
        sendRefundTelegramNotification(orderId, productId, reason, description, result.rows[0])
          .then(telegramResult => {
            if (!telegramResult.success) {
              console.warn('Telegram refund notification failed:', telegramResult.error);
            }
          });

        res.status(200).json({
            success: true,
            message: 'Refund request submitted successfully',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('Error processing refund request:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});


router.post('/1464/refund/:orderId/:productId/status/update', authenticateFirebaseToken, async (req, res) => {
  console.log("==== Route to update refund status of 1464 order items hit ====")

  try {
    console.log('Request body:', req.body);
    const {orderId, productId, status, note} = req.body;
    console.log('Order ID:', orderId,'Product ID:', productId, 'Status:', status, 'Note:', note);
    if (!orderId || !productId || !status) {
      return res.status(400).json({
        success: false,
        message: 'Bad Request: Order ID, Product ID, and Status are required'
      })
    }

    const query = `
      UPDATE "1464_order_items"
      SET
        "currentStatus" = $1,
        "statusHistories" = "statusHistories" || jsonb_build_array(
          jsonb_build_object(
            'note', $2,
            'status', $1,
            'timestamp', NOW()
          )
        )
      `;

      const queryResult = await zingoPool.query(query, [status, note]);
      if  (queryResult.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Order item not found or no changes made'
        })
      }

      res.status(200).json({
        success: true,
        message: 'Refund status updated successfully',
        data: {
          orderId: orderId,
          productId: productId,
          status: status,
          note: note
        }
      })
    

  } catch (e) {
    console.error(`Error with updating refund status of 1464 order items: ${e.message}`);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: e.message
    });
  }
})
  
module.exports = router;