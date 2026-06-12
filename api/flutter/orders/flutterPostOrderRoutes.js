const express = require("express");
const router = express.Router();
const zingoPool = require("../../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../../rateLimiter");
const { generateOrderId } = require("../../../utils/generateOrderId");
require('dotenv').config();



// Custom error class for better error handling
class OrderError extends Error {
    constructor(message, statusCode, title = "Error") {
        super(message);
        this.statusCode = statusCode;
        this.title = title
    }
}

const getEffectivePrice = (product) => {
  if (product.discountedPrice && parseFloat(product.discountedPrice) > 0) {
      return parseFloat(product.discountedPrice);
  }
  return parseFloat(product.productPrice);
};

async function sendTelegramNotification(orderId, orderDetails) {
  console.log(`Attempting to send Telegram notification for order ${orderId}`);
  try {
    // Store these securely in environment variables
    const botToken = String(process.env.TELEGRAM_ORDERS_BOT_TOKEN.trim());
    const chatId = Number(process.env.TELEGRAM_CHAT_ID.trim());
    console.log("Order Details in Telegram Notification", orderDetails);

    console.log("botToken", botToken, typeof(botToken));
    console.log("chatId", chatId, typeof(chatId));
    
    // Calculate total amount
    const totalAmount = orderDetails.items.reduce((sum, item) => 
      sum + (item.effectivePrice * item.purchasedQuantity), 0);
    
    // Calculate original total (before discounts)
    const originalTotal = orderDetails.items.reduce((sum, item) => 
      sum + (Number(item.productPrice) * item.purchasedQuantity), 0);
    
    // Format delivery address
    const address = [
      orderDetails.buyerAddress,
      orderDetails.buyerCommune,
      orderDetails.buyerDistrict,
      orderDetails.buyerCity
    ].filter(Boolean).join(', ');
    
    // Format a nice message with emojis and better structure
    const message = `🛍️ *NEW ORDER #${orderId}*\n\n` +
      `👤 *Customer:* ${orderDetails.buyerFullName}\n` +
      `📱 *Phone:* ${orderDetails.buyerPhoneNumber}\n` +
      `📍 *Address:* ${address}\n` +
      `💳 *Payment:* ${orderDetails.paymentMethod === 'delivery' ? 'Cash on Delivery' : orderDetails.paymentMethod}\n` +
      `📦 *Status:* ${orderDetails.orderStatus}\n\n` +
      
      `🛒 *Order Items:*\n` +
      `${orderDetails.items.map(item => 
        `• ${item.purchasedQuantity}x ${item.productName}\n` +
        `   Original: $${item.productPrice} | Discount: $${item.discountedPrice} | Final: $${item.effectivePrice}\n` +
        `   Ordered Quantity: ${item.purchasedQuantity}\n` +
        `   Subtotal: $${(item.effectivePrice * item.purchasedQuantity).toFixed(2)}`
      ).join('\n\n')}\n\n` +
      
      
      
      `📊 *Order Summary:*\n` +
      `Original Total: $${originalTotal.toFixed(2)}\n` +
      `${orderDetails.deliveryFee > 0 ? `🚚 Delivery Fee: $${orderDetails.deliveryFee.toFixed(2)}\n` : ''}` +
      `${orderDetails.pointsUsed > 0 ? `⭐ Points Used: ${orderDetails.pointsUsed}\n` : ''}` +
      `${orderDetails.pointsDiscount > 0 ? `⭐ Points Discount: $${orderDetails.pointsDiscount.toFixed(2)}\n` : ''}` +
      `💰 *FINAL TOTAL: $${totalAmount.toFixed(2)}*\n\n` +
      
      `🏬 *Product Details:*\n` +
      `${orderDetails.items.map(item => 
        `• ${item.productName}\n` +
        `   ID: ${item.productId}\n` +
        `   Posted by: ${item.postedBy}\n` +
        `   Available: ${item.availableQuantity}`
      ).join('\n\n')}`;

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    // console.log('Telegram API URL:', url);
    
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log(`Telegram API response:`, response);
    
    console.log('Telegram notification sent successfully');
    return { success: true };
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
    return { success: false, error: error.message };
  }
}



router.post("/order/create/guest", async (req, res) => {
  console.log("========== ***Guest Create Order in FLutter*** ==========")

  const client = await zingoPool.connect()
  await client.query("BEGIN")
  try {
      // Generate a unique guest user ID based on phone number
      const phoneNumber = req.body.shippingInfo?.phoneNumber || 'unknown';
      const guestUserId = `999_${phoneNumber}`;
      console.log("guestUserId", guestUserId)
      
      // Create or get guest user record
      const guestUserQuery = `
        INSERT INTO users ("guestUserId", "isGuest", "phoneNumber", "role") 
        VALUES ($1, TRUE, $2, 'buyer')
        ON CONFLICT ("guestUserId") DO NOTHING
        RETURNING id
      `;
      
      const guestUserResult = await client.query(guestUserQuery, [guestUserId,phoneNumber]);
      console.log("guestUserResult", guestUserResult.rows[0])
      
      // Get the actual userId (either from the insert or use the existing one)
      let userId;
      if (guestUserResult.rowCount > 0) {
        userId = guestUserResult.rows[0].id;
      } else {
        // Query to get the existing user id
        const existingUserQuery = `SELECT id FROM users WHERE "guestUserId" = $1`;
        const existingUser = await client.query(existingUserQuery, [guestUserId]);
        userId = existingUser.rows[0].id;
      }
      
      // Use the existing validation logic but with the guest flag
      const orderDetails = await validateAndCheckAvailability(req, userId)
      
      // Mark this order as being placed by a guest
      orderDetails.isGuest = true;
  
      console.log("=============== Start Create Order ===============")
      const orderResult = await createOrder(client, orderDetails)
      
      // Rest of your order creation logic...
      const orderId = orderResult.rows[0].orderId
      await createOrderItems(client, orderId, orderDetails);
      await client.query('COMMIT');
      
      // Send Telegram notification
      await sendTelegramNotification(orderResult.rows[0].orderId, orderDetails);
      
      return res.status(200).json({
          message: "Guest order added successfully",
          orderId: orderResult.rows[0].orderId,
          order: orderResult.rows[0],
          guestUserId: guestUserId
      });
  } catch (e) {
      // Error handling same as before
      await client.query('ROLLBACK');
      const statusCode = e.statusCode || 500;
      const errorMessage = e.message || "An unexpected error occurred";
      const errorTitle = e.title || "Error";
      
      return res.status(statusCode).json({
          success: false,
          error: errorMessage,
          title: errorTitle
      });
  } finally {
      client.release();
  }
})

router.post("/order/create", authenticateFirebaseToken, async (req,res) => {
    console.log("========== Create Order in FLutter ==========")
    const client = await zingoPool.connect()
    await client.query("BEGIN")
    try {
        const userId = req.user.id
        
        const orderDetails = await validateAndCheckAvailability(req,userId)
        orderDetails.authenticatedUser = true;
        console.log(`order details: ${JSON.stringify(orderDetails, null, 2)}`);
        const orderResult = await createOrder(client, orderDetails)
        console.log("orderResult", orderResult.rows[0])

        if (!orderResult) {
            return res.status(404).json({ error: "Error inserting order to orders table"});
        }
        
        const orderId = orderResult.rows[0].orderId

        await createOrderItems(client, orderId, orderDetails);

        await client.query('COMMIT');

        // Send Telegram notification
        const notificationResult = await sendTelegramNotification(
          orderResult.rows[0].orderId, 
          orderDetails
        );

        console.log("Order added Succesfully");


        return res.status(200).json({
            message: "Order added successfully",
            orderId: orderResult.rows[0].orderId,
            order: orderResult.rows[0],
            orderItems: orderResult.rows[0],
            // emailSent: emailResult.success
        });

    } catch (e) {
        // Rollback the transaction
        await client.query('ROLLBACK');

        console.error('Full error:', e);

        // Prioritize the error's status code, default to 500
        const statusCode = e.statusCode || 500;
        const errorMessage = e.message || "An unexpected error occurred";
        const errorTitle = e.title || "Error";

        return res.status(statusCode).json({
            success: false,
            error: errorMessage,
            title: errorTitle
        });
    } finally {
        client.release();
    }
})


async function validateAndCheckAvailability(req, userId, isGuest = false) {
    console.log("===== Extract, Validate Data and Check Availability =====");
    const orderStatus = "ordered";
    console.log("req body in ValidateAndCheckValidity", req.body)
    console.log("orderDetails", req.body.orderDetails)

    
    try {
      const products = req.body.orderDetails.products;
      console.log("products", products)
      const productIds = products.map(product => product.id);
      
      // Create a map of requested quantities
      const requestedQuantities = new Map(
        products.map(p => [p.id, parseInt(p.purchasedQuantity)])
      );
  
      // First query to get product details without locking
      const detailsQuery = `
        SELECT 
          id as "productId",
          "productPrice",
          "discountedPrice",
          "productName",
          "postedBy",
          "availableQuantity"
        FROM products 
        WHERE id = ANY($1)
      `;
      const productDetails = await zingoPool.query(detailsQuery, [productIds]);
      console.log("productDetails", productDetails.rows)
  
      // Check for missing products early
      const foundProductIds = new Set(productDetails.rows.map(row => row.productId));
      const missingProducts = productIds.filter(id => !foundProductIds.has(id));
      
      if (missingProducts.length > 0) {
        throw new OrderError(
          `Products not found: ${missingProducts.join(', ')}`,
          404,
          "Product unavailable"
        );
      }
  
      // Validate initial availability before attempting locks
      productDetails.rows.forEach(product => {
        const requestedQty = requestedQuantities.get(product.productId);
        if (product.availableQuantity <= 0) {
          throw new OrderError(
            `${product.productName} is out of stock`,
            409,
            "Out of Stock"
          );
        }
        if (product.availableQuantity < requestedQty) {
          throw new OrderError(
            `Insufficient stock for ${product.productName}. Available: ${product.availableQuantity}, Requested: ${requestedQty}`,
            400,
            "Insufficient Stock"
          );
        }
      });
  
      // Begin transaction for atomic updates
      const client = await zingoPool.connect();
      try {
        await client.query('BEGIN');
        
        const items = [];
        // Process each product sequentially within the transaction
        for (const product of productDetails.rows) {
          const requestedQty = requestedQuantities.get(product.productId);
          
          // Lock and verify specific quantity using a partial range lock
          const lockQuery = `
            SELECT "availableQuantity"
            FROM products
            WHERE id = $1 AND "availableQuantity" >= $2
            FOR UPDATE SKIP LOCKED
          `;
          
          const lockResult = await client.query(lockQuery, [
            product.productId,
            requestedQty
          ]);
  
          if (lockResult.rows.length === 0) {
            await client.query('ROLLBACK');
            throw new OrderError(
              `Unable to reserve ${requestedQty} units of ${product.productName}. Stock may have changed.`,
              409,
              "Stock Changed"
            );
          }
  
          // Add to items array for order creation
          items.push({
            ...product,
            purchasedQuantity: requestedQty,
            effectivePrice: getEffectivePrice(product),
          });
        }
  
        // Extract shipping information
        const { shippingInfo } = req.body;
        console.log("userId", userId)
        const orderDetails = {
          userId: userId || null,
          guestUserId: isGuest ? userId : null,
          items,
          orderStatus,
          buyerAddress: shippingInfo.address,
          buyerDistrict: shippingInfo.district,
          buyerCommune: shippingInfo.commune,
          buyerFullName: shippingInfo.fullName,
          buyerPhoneNumber: shippingInfo.phoneNumber,
          buyerCity: shippingInfo.city,
          paymentMethod: req.body.paymentMethod,
          deliveryFee: req.body.deliveryFee,
          pointsUsed: req.body.pointsUsed || 0,
          pointsDiscount: req.body.pointsDiscount || 0
        };
  
        await client.query('COMMIT');
        console.log("========== End Validation and Availability Check ==========");
        return orderDetails;
  
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
  
    } catch (error) {
      if (error instanceof OrderError) throw error;
      
      // Handle specific database errors
      const errorMap = {
        '55P03': ['Products are currently being purchased by another user', 423],
        '23505': ['Concurrent modification detected', 409],
        '42P01': ['Database table not found', 500],
        '42703': ['Invalid column reference', 500]
      };
  
      if (error.code && errorMap[error.code]) {
        const [message, statusCode] = errorMap[error.code];
        throw new OrderError(message, statusCode);
      }
      throw new OrderError('Invalid request format', 400);
    }
  }


  
async function subtractUserPoints(client, userId, pointsUsed ,orderId) {
  console.log(`===== Subtracting ${pointsUsed} points from User ${userId} =====`);
  
  if (!pointsUsed || pointsUsed <= 0) {
    console.log("No points to subtract, skipping point deduction");
    return { updated: false };
  }
  
  try {
    // First check if user has enough points
    const checkQuery = `
      SELECT "points" FROM users
      WHERE id = $1
      FOR UPDATE
    `;
    
    const userResult = await client.query(checkQuery, [userId]);
    
    if (userResult.rows.length === 0) {
      throw new OrderError("User not found", 404, "User Error");
    }
    
    const currentPoints = userResult.rows[0].points || 0;
    
    if (currentPoints < pointsUsed) {
      throw new OrderError(
        `Insufficient points. You have ${currentPoints} points but attempted to use ${pointsUsed}`,
        400,
        "Insufficient Points"
      );
    }
    
    // Update the user's points
    const updateQuery = `
      UPDATE users
      SET "points" = "points" - $1
      WHERE id = $2
      RETURNING "points"
    `;
    
    const updateResult = await client.query(updateQuery, [pointsUsed, userId]);
    
    console.log(`Points subtracted successfully. User ${userId} now has ${updateResult.rows[0].points} points`);
    
    // Add a record to points_history table if you have one
    // This is optional but recommended for tracking points transactions
    if (typeof client.query === 'function') {
      try {
        const historyQuery = `
          INSERT INTO points_history (
            "userId", "points", "type", "description", "referenceId", "createdAt"
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
        `;
        
        await client.query(historyQuery, [
          userId,
          -pointsUsed, // Negative value to indicate points were used
          'order_redemption',
          'Points used for purchase',
          orderId // Reference to the order ID
        ]);
        
        console.log(`Points history record created for User ${userId}`);
      } catch (historyError) {
        // Log but don't fail the transaction if history recording fails
        console.error("Error recording points history:", historyError);
      }
    }
    
    return { 
      updated: true,
      newPointsBalance: updateResult.rows[0].points
    };
    
  } catch (error) {
    if (error instanceof OrderError) throw error;
    
    console.error("Error subtracting user points:", error);
    throw new OrderError(
      "Failed to update user points",
      500,
      "Points Error"
    );
  }
}


async function createOrder(client, orderDetails) {
    console.log("=============== Start Create Order ===============")
    const productIds = orderDetails.items
    ? orderDetails.items.map(item=>item.productId)
    : [orderDetails.productId];
    console.log("Product Ids", productIds)

 

    const generatedOrderId = generateOrderId(
        orderDetails.items ? orderDetails.items[0].productId : orderDetails.productId
    );

    console.log('orderId', generatedOrderId)
    const status = "ordered"
    const description = `Order ${generatedOrderId} has been placed successfully`;

    const statusHistories = JSON.stringify([
      {
          status: "ordered",
          timestamp: new Date().toISOString(),
          description: "Order has been placed successfully"
      }
  ]);
  

   
    const orderQuery = `
       INSERT INTO orders (
        "userId", "orderId", "currentStatus", "buyerPhoneNumber", "totalAmount", "paymentMethod",
        "buyerAddress", "buyerDistrict", "buyerCommune", "buyerCity", "buyerFullName", "deliveryFee", 
        "statusHistories", "pointsUsed", "pointsDiscount"
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *
    `;
    // Total Amount based on a single purchase or cart purchase
    console.log('delivery fee', orderDetails.deliveryFee)
    
    
    const totalAmount = orderDetails.items.reduce((total, item) => {
        const price = item.effectivePrice; 
        const quantity = item.purchasedQuantity;
        console.log("Effective price:", price)
        console.log("Purchased quantity:", quantity)
        if (!isNaN(price) && !isNaN(quantity)) { // Check if the price is a valid number
            console.log(`Product ID: ${item.productId}, Price: ${price.toFixed(2)}`); // Log the price
            return total + (price * quantity);  // Add the price to the total
        } else {
            console.error(`Invalid price for Product ID ${item.productId}. Skipping...`);
            return total; // Skip invalid prices
        }
    }, 0) - (orderDetails.pointsDiscount || 0); // Start the total at 0

    console.log(`Total Amount: ${totalAmount.toFixed(2)}`); // Log the total amount

     // Only handle points for non-guest users
     if (!orderDetails.isGuest && orderDetails.pointsUsed > 0) {
      console.log("Subtract Points for registered user")
      const pointsResult = await subtractUserPoints(client, orderDetails.userId, orderDetails.pointsUsed, generatedOrderId)
      if (!pointsResult.updated) {
          throw new OrderError("Error updating user points", 404, "Points Error");
      }
    }
   
    
    //orderDetails is from the extractAndValidateRequestData(req, userId).
    const orderValues = [
        orderDetails.userId, 
        generatedOrderId,
        orderDetails.orderStatus, 
        orderDetails.buyerPhoneNumber,
        parseFloat(totalAmount.toFixed(2)), 
        orderDetails.paymentMethod,
        orderDetails.buyerAddress,
        orderDetails.buyerDistrict,
        orderDetails.buyerCommune,
        orderDetails.buyerCity, 
        orderDetails.buyerFullName,
        parseFloat(orderDetails.deliveryFee),
        statusHistories,
        orderDetails.pointsUsed || 0,
        parseFloat(orderDetails.pointsDiscount) || 0
    ];
    console.log('orderValues', orderValues)


    
    const orderResult = await client.query(orderQuery, orderValues);


    console.log("==========Sucessfully Create Order =====")
    return orderResult.rowCount ? orderResult : null;
}

async function createOrderItems(client, orderId, orderDetails) {
  console.log('==========Start Creating Order Items==============');
  console.log('OrderId:', orderId);
  console.log('OrderDetails:', JSON.stringify(orderDetails, null, 2));
  
  try {
      const orderItemsPromises = orderDetails.items.map(async item => {
          const status = "ordered";
          const description = `Seller have received your order`;
          const statusHistories = JSON.stringify([
              {
                  status: "ordered",
                  timestamp: new Date().toISOString(),
                  description: "Order has been placed successfully"
              }
          ]);

          // Insert order item
          const insertQuery = `
          INSERT INTO order_items("orderId", "productId", "purchasedQuantity", "productPrice", "statusHistories", "currentStatus")
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
          `;
          const purchasedQuantity = item.purchasedQuantity;
          console.log("*purchasedQuantity*", purchasedQuantity);
          const insertValues = [orderId, item.productId, parseInt(item.purchasedQuantity), item.effectivePrice, statusHistories, status];
         
          const orderItemResult = await client.query(insertQuery, insertValues);
          console.log('Insert successful:', orderItemResult.rows[0]);
  
          // Update product available quantity & quantity sold
          const updateQuery = `
            UPDATE products 
            SET "availableQuantity" = "availableQuantity" - $1,
                "quantitySold" = "quantitySold" + $1
            WHERE id = $2 AND "availableQuantity" >= $1
            RETURNING "availableQuantity", "quantitySold", id
          `;
          
          const updateValues = [parseInt(item.purchasedQuantity), item.productId];
          const updateResult = await client.query(updateQuery, updateValues);
  
          if (!updateResult.rows.length) {
              // Throw an error with specific status code
              const error = new Error(
                  `Try reduce your purchased quantity for ${item.productName}.`);
              error.statusCode = 400;
              error.title = 'Insufficient Stock';
              throw error;
          }
  
          console.log('Update result:', updateResult.rows[0]);
          console.log("Order Item Result", orderItemResult.rows[0]);
          return orderItemResult.rows[0];
      });

      // Wait for all promises to resolve
      const results = await Promise.all(orderItemsPromises);
      return results;
  } catch (error) {
      console.error('Operation failed:', {
          error: {
              code: error.code,
              constraint: error.constraint,
              detail: error.detail,
              message: error.message
          }
      });
      throw error;
  }
}

// async function checkProductAvailability(client, productIds) {
//     console.log("=============== Checking Product Availability ===============")
//     const query = `
//         SELECT 
//             p.id, 
//             p."availableQuantity",
//             p."productName"
//         FROM products p
//         WHERE p.id = ANY($1)
//         FOR UPDATE OF p NOWAIT
//     `;
    
//     try {
//         const result = await client.query(query, [productIds]);
        
//         // Group results by product ID
//         const productStatus = result.rows.reduce((acc, row) => {
//             if (!acc[row.id]) {
//                 acc[row.id] = {
//                     availableQuantity: row.availableQuantity,
//                     productName: row.productName
//                 };
//             }
//             return acc;
//         }, {});
        
//         // Check for unavailable products
//         const unavailableProducts = [];
//         const notFoundProducts = [];
        
//         for (const id of productIds) {
//             const status = productStatus[id];
            
//             // Handle missing products
//             if (!status) {
//                 notFoundProducts.push(id);
//                 const error = new Error (
//                     `Product is no longer available`,
//                     error.statusCode = 404,
//                     error.title = `Product unavailable`
                   
//                 );
//                 throw error;
                
//             }
            
//             // Only check availableQuantity
//             if (status.availableQuantity <= 0) {
//                 unavailableProducts.push({
//                     id,
//                     name: status.productName
//                 });
//             }
//         }
        
//         // Handle not found products first
//         if (notFoundProducts.length > 0) {
//             const error =  new OrderError(
//                 `Products not found: ${notFoundProducts.join(', ')}`,
//                 error.statusCode = 404,
//                 error.title = "Product unavailable"
//             );
//             throw error;
//         }

//         // Handle unavailable products
//         if (unavailableProducts.length > 0) {
//             const productList = unavailableProducts
//                 .map(p => `${p.name} (ID: ${p.id})`)
//                 .join(', ');

//             throw new OrderError(
//                 `The following product(s) are out of stock: ${productList}`,
//                 409,
//                 "Out of Stock"
//             );
//         }
        
//         return { 
//             available: true,
//             productIds: Object.entries(productStatus).map(([id, status]) => ({
//                 id,
//                 name: status.productName
//             }))
//         };
        
//     } catch (error) {
//         // Unified error handling
//         if (error instanceof OrderError) {
//             throw error; // Re-throw existing OrderErrors
//         }
//         // Handle specific database errors
//         const errorMap = {
//             '55P03': ['Products are currently being purchased by another user', 423],
//             '23505': ['Concurrent modification detected', 409],
//             '42P01': ['Database table not found', 500],
//             '42703': ['Invalid column reference', 500]
//         };
        
//         if (error.code && errorMap[error.code]) {
//             const [message, statusCode] = errorMap[error.code];
//             throw new OrderError(message, statusCode);
//         }
        
//         // Handle unexpected errors
//         throw new OrderError(
//             'An unexpected error occurred while checking product availability',
//             500
//         );
//     }
// }



module.exports = router;