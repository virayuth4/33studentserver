const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateOrderId } = require("../../utils/generateOrderId");
const { upload, uploadMediaFilesToS3 } = require("../../database/s3");
const {getDeliveryFee} = require('./../../utils/constant/deliveryFee');
require('dotenv').config();

// Remove the duplicate import line - it was causing an error
// const {generateOrderId} = require() // <- This line was incomplete and duplicate

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

async function sendTelegramOrderDetailsToId(
  chatId,  // pass your chat ID here
  orderId,
  orderDetails,
  shippingInfo,
  deliveryFee,
  paymentMethod,
  pointsUsed,
  pointsDiscount,
  firstOrderDiscount,
  discountCode,
  codeDiscount,
  userFullName,
  userPhoneNumber
) {
  //   console.log("======= TELEGRAM DEBUG =======");
  // console.log("chatId:", chatId);
  // console.log("orderId:", orderId);
  // console.log("orderDetails:", JSON.stringify(orderDetails, null, 2));
  // console.log("products:", JSON.stringify(orderDetails.products ?? orderDetails.items, null, 2));
  // console.log("firstImageUrl:", (orderDetails.products ?? orderDetails.items)?.[0]?.productImagePaths?.[0]);
  // console.log("==============================");
  const botToken = process.env.TELEGRAM_ORDERS_BOT_TOKEN?.trim();
  

  if (!botToken || !chatId) {
    console.error("Missing bot token or chat ID");
    return { success: false, error: "Missing credentials" };
  }

  // Reuse the same message formatting from sendTelegramNotification
  const products = orderDetails.products ?? [];

  const subtotal = products.reduce(
    (sum, item) => sum + (item.price ?? 0) * item.purchasedQuantity,
    0
  );

  const finalTotal =
    subtotal +
    (deliveryFee ?? 0) -
    (pointsDiscount ?? 0) -
    (firstOrderDiscount ?? 0) -
    (codeDiscount ?? 0);

  const formatCurrency = (n) => Number(n).toFixed(2);

  const address =
    [shippingInfo?.address, shippingInfo?.commune, shippingInfo?.district, shippingInfo?.city]
      .filter(Boolean)
      .join(", ") || "Address not provided";

  const itemLines = products
    .map((item) => {
      const price = item.price ?? 0;
      const meta = [item.color && `Color: ${item.color}`, item.size && `Size: ${item.size}`]
        .filter(Boolean)
        .join(" | ");
      return (
        `• ${item.purchasedQuantity}x *${item.productName ?? "Unknown Product"}*\n` +
        (meta ? `   ${meta}\n` : "") +
        `   Price: $${formatCurrency(price)} → Subtotal: $${(price * item.purchasedQuantity).toFixed(2)}`
      );
    })
    .join("\n\n");

  const paymentLabel = paymentMethod === "delivery" ? "Cash on Delivery" : (paymentMethod ?? "N/A");
    const firstImageUrl = products[0]?.productImagePaths?.[0];


  const message =
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🛍️ *NEW ORDER* | #${orderId}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +

    `👤 *CUSTOMER*\n` +
    `├ Name: ${shippingInfo?.fullName ?? "N/A"}\n` +
    `├ Phone: ${shippingInfo?.phoneNumber ?? "N/A"}\n` +

     `👤 *Merchant*\n` +
    (userFullName ? `├ Merchant Name: ${userFullName}\n` : "") +
    (userPhoneNumber ? `└ Merchant Phone Number: ${userPhoneNumber}\n` : `└ No account linked\n`) +

    `\n📍 *DELIVERY*\n` +
    `├ Address: ${address}\n` +
    `└ Payment: ${paymentLabel}\n` +

    `\n🛒 *ORDER ITEMS*\n` +
    `${itemLines}\n` +

    `\n💰 *PRICE BREAKDOWN*\n` +
    `├ Subtotal: $${formatCurrency(subtotal)}\n` +
    (deliveryFee > 0 ? `├ 🚚 Delivery: $${formatCurrency(deliveryFee)}\n` : "") +
    (pointsDiscount > 0 ? `├ ⭐ Points: -$${formatCurrency(pointsDiscount)}\n` : "") +
    (firstOrderDiscount > 0 ? `├ 🎉 First Order: -$${formatCurrency(firstOrderDiscount)}\n` : "") +
    (discountCode ? `├ 🏷️ Code (${discountCode}): -$${formatCurrency(codeDiscount)}\n` : "") +
    `└ *TOTAL: $${formatCurrency(finalTotal)}*\n` +

    (firstImageUrl ? `\n🖼️ Item Image: ${firstImageUrl}\n` : "") +

    `\n━━━━━━━━━━━━━━━━━━━━━━`;



  try {
   
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: message,
    
      });

    console.log(`Telegram notification sent to chat ID ${chatId} for order #${orderId}`);
    return { success: true };
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
    console.error("Telegram error response:", error.response?.data)
    return { success: false, error: error.message };
  }
}

async function sendTelegramNotification(
  orderId,
  orderDetails,
  shippingInfo,
  deliveryFee,
  paymentMethod,
  pointsUsed,
  pointsDiscount,
  firstOrderDiscount,
  discountCode,
  codeDiscount
) {
  const botToken = process.env.TELEGRAM_ORDERS_BOT_TOKEN?.trim();
  const chatId = Number(process.env.TELEGRAM_CHAT_ID?.trim());

  if (!botToken || !chatId) {
    console.error("Missing Telegram credentials in environment variables");
    return { success: false, error: "Missing credentials" };
  }

  const products = orderDetails.products ?? [];

  const subtotal = products.reduce(
    (sum, item) => sum + (item.price ?? 0) * item.purchasedQuantity,
    0
  );

  const finalTotal =
    subtotal +
    (deliveryFee ?? 0) -
    (pointsDiscount ?? 0) -
    (firstOrderDiscount ?? 0) -
    (codeDiscount ?? 0);

  const address =
    [
      shippingInfo?.address,
      shippingInfo?.commune,
      shippingInfo?.district,
      shippingInfo?.city,
    ]
      .filter(Boolean)
      .join(", ") || "Address not provided";

  const formatCurrency = (n) => Number(n).toFixed(2);

  const itemLines = products
    .map((item) => {
      const price = item.price ?? 0;
      const subtotalLine = (price * item.purchasedQuantity).toFixed(2);
      const meta = [item.color && `Color: ${item.color}`, item.size && `Size: ${item.size}`]
        .filter(Boolean)
        .join(" | ");

      return (
        `• ${item.purchasedQuantity}x *${item.productName ?? "Unknown Product"}*\n` +
        (meta ? `   ${meta}\n` : "") +
        `   Price: $${formatCurrency(price)} → Subtotal: $${subtotalLine}`
      );
    })
    .join("\n\n");

  const productDetailLines = products
    .map(
      (item) =>
        `• *${item.productName ?? "Unknown Product"}*\n` +
        `   ID: ${item.id ?? "N/A"}\n` +
        (item.color ? `   Color: ${item.color}\n` : "") +
        (item.size ? `   Size: ${item.size}\n` : "") +
        `   Qty: ${item.purchasedQuantity}`
    )
    .join("\n\n");

  const paymentLabel =
    paymentMethod === "delivery" ? "Cash on Delivery" : (paymentMethod ?? "N/A");

  const message =
    `🛍️ *NEW ORDER #${orderId}*\n\n` +
    `👤 *Customer:* ${shippingInfo?.fullName ?? "N/A"}\n` +
    `📱 *Phone:* ${shippingInfo?.phoneNumber ?? "N/A"}\n` +
    `📍 *Address:* ${address}\n` +
    `💳 *Payment:* ${paymentLabel}\n\n` +
    `🛒 *Order Items:*\n${itemLines}\n\n` +
    `📊 *Order Summary:*\n` +
    `Subtotal: $${formatCurrency(subtotal)}\n` +
    (deliveryFee > 0 ? `🚚 Delivery Fee: $${formatCurrency(deliveryFee)}\n` : "") +
    (pointsUsed > 0 ? `⭐ Points Used: ${pointsUsed}\n` : "") +
    (pointsDiscount > 0 ? `⭐ Points Discount: -$${formatCurrency(pointsDiscount)}\n` : "") +
    (firstOrderDiscount > 0 ? `🎉 First Order Discount: -$${formatCurrency(firstOrderDiscount)}\n` : "") +
    (discountCode ? `🏷️ Discount Code: ${discountCode}\n` : "") +
    (codeDiscount > 0 ? `🏷️ Code Discount: -$${formatCurrency(codeDiscount)}\n` : "") +
    `💰 *TOTAL: $${formatCurrency(finalTotal)}*\n\n` +
    `🏬 *Product Details:*\n${productDetailLines}`;

  const firstImageUrl = products[0]?.productImagePaths?.[0];

  try {
    if (firstImageUrl) {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        chat_id: chatId,
        photo: firstImageUrl,
        caption: message,
        parse_mode: "Markdown",
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      });
    }

    console.log(`Telegram notification sent for order #${orderId}`);
    return { success: true };
  } catch (error) {
    console.error("Telegram notification failed:", error.message);

    // Fallback: retry as plain text if photo send failed
    if (firstImageUrl && error.response?.data?.description?.includes("photo")) {
      try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
        });
        return { success: true, note: "Sent as text — image failed" };
      } catch (fallbackError) {
        console.error("Fallback text send also failed:", fallbackError.message);
        return { success: false, error: fallbackError.message };
      }
    }

    return { success: false, error: error.message };
  }
}

// Function to check if order ID already exists
async function isOrderIdUnique(orderId, client) {
    const checkQuery = `SELECT "orderId" FROM "1464_orders" WHERE "orderId" = $1`;
    const result = await client.query(checkQuery, [orderId]);
    return result.rows.length === 0;
}

// Function to generate unique order ID
async function generateUniqueOrderId(client) {
    let orderId;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;
    
    while (!isUnique && attempts < maxAttempts) {
        orderId = generateOrderId(); // Use your custom generator
        isUnique = await isOrderIdUnique(orderId, client);
        attempts++;
        
        if (!isUnique) {
            console.log(`Order ID ${orderId} already exists, generating another...`);
        }
    }
    
    if (!isUnique) {
        throw new Error('Unable to generate unique order ID after maximum attempts');
    }
    
    return orderId;
}

// Function to check product availability
async function checkProductAvailability(products, client) {
    const unavailableProducts = [];
    
    for (const product of products) {
        // Query to get product variants
        const productQuery = `
            SELECT "productVariants" 
            FROM "1464_products" 
            WHERE id = $1
        `;
        
        const productResult = await client.query(productQuery, [product.id]);
        
        if (productResult.rows.length === 0) {
            unavailableProducts.push({
                productId: product.id,
                productName: product.productName,
                reason: 'Product not found'
            });
            continue;
        }
        
        const productVariants = productResult.rows[0].productVariants;
        
        // Find matching variant by size and color
        const matchingVariant = productVariants.find(variant => 
            variant.size.toLowerCase() === product.size.toLowerCase() && 
            variant.color.toLowerCase() === product.color.toLowerCase()
        );
        
        if (!matchingVariant) {
            unavailableProducts.push({
                productId: product.id,
                productName: product.productName,
                requestedSize: product.size,
                requestedColor: product.color,
                reason: 'Variant not available'
            });
            continue;
        }
        
        // Check if enough quantity is available
        const availableQuantity = parseInt(matchingVariant.availableQuantity);
        const requestedQuantity = product.purchasedQuantity;
        
        if (availableQuantity < requestedQuantity) {
            unavailableProducts.push({
                productId: product.id,
                productName: product.productName,
                requestedQuantity: requestedQuantity,
                availableQuantity: availableQuantity,
                reason: 'Insufficient quantity'
            });
        }
    }
    
    return {
        isAvailable: unavailableProducts.length === 0,
        unavailableProducts: unavailableProducts
    };
}

//Function to update points used from the user
async function updateUserPoints(userId, pointsUsed, client) {
    if (pointsUsed > 0) {
        const updatePointsQuery = `
        UPDATE users 
        SET points = points - $1,
            updatedAt = CURRENT_TIMESTAMP 
        WHERE id = $2 AND points >= $1
        `
    }
}

// Function to update product inventory after successful order
async function updateProductInventory(products, client) {
    for (const product of products) {
        const updateInventoryQuery = `
            UPDATE "1464_products" 
            SET "productVariants" = (
                SELECT jsonb_agg(
                    CASE 
                        WHEN (variant->>'size')::text = $2 AND (variant->>'color')::text = $3
                        THEN jsonb_set(
                            variant, 
                            '{availableQuantity}', 
                            to_jsonb((variant->>'availableQuantity')::int - $4)
                        )
                        ELSE variant
                    END
                )
                FROM jsonb_array_elements("productVariants") AS variant
            )
            WHERE id = $1
        `;
        
        await client.query(updateInventoryQuery, [
            product.id,
            product.size,
            product.color,
            product.purchasedQuantity
        ]);
    }
}

async function calculateTotalFromDatabase(products, deliveryFee, pointsDiscount, firstOrderDiscount = 0, codeDiscount = 0, client) {
    let subtotal = 0;
    
    for (const product of products) {
        const priceQuery = `
            SELECT 
                variant->>'productPrice' as "productPrice",
                variant->>'discountedPrice' as "discountedPrice"
            FROM "1464_products", 
            jsonb_array_elements("productVariants") as variant
            WHERE id = $1 
            AND variant->>'size' = $2 
            AND variant->>'color' = $3
        `;
        const priceResult = await client.query(priceQuery, [product.id, product.size, product.color]);
        const { productPrice, discountedPrice } = priceResult.rows[0];
        const actualPrice = discountedPrice && parseFloat(discountedPrice) > 0
            ? parseFloat(discountedPrice)
            : parseFloat(productPrice);

        subtotal += actualPrice * product.purchasedQuantity;
    }
    
    return {
        subtotal,
        totalAmount: subtotal + deliveryFee - pointsDiscount - firstOrderDiscount - codeDiscount
    }
}

// Function to create order with availability check
async function createOrderWithAvailabilityCheck(orderData, client) {
    const { 
        products, shippingInfo, deliveryFee, paymentMethod, 
        pointsUsed, pointsDiscount, userId, firstOrderDiscount,
        discountCode, codeDiscount  // new
    } = orderData;
    
    // Validate discount code if provided
    if (discountCode) {
        const discountResult = await client.query(
            `SELECT * FROM "1464_discount_codes" WHERE code = $1`,
            [discountCode]
        );

        if (discountResult.rows.length === 0) {
            throw { statusCode: 400, title: 'Invalid Code', message: 'Discount code not found' };
        }

        const dc = discountResult.rows[0];

        // Check expiry
        if (dc.expiresAt && new Date() > new Date(dc.expiresAt)) {
            throw { statusCode: 400, title: 'Expired Code', message: 'This discount code has expired' };
        }

        // Check global usage limit
        if (dc.usageLimit !== null && dc.usedCount >= dc.usageLimit) {
            throw { statusCode: 400, title: 'Code Exhausted', message: 'This discount code has reached its usage limit' };
        }

        // Check per-user usage limit
        const userUsageResult = await client.query(
            `SELECT COUNT(*) FROM "1464_orders" WHERE "userId" = $1 AND "discountCode" = $2`,
            [userId, discountCode]
        );
        if (parseInt(userUsageResult.rows[0].count) >= dc.userUsageLimit) {
            throw { statusCode: 400, title: 'Already Used', message: 'You have already used this discount code' };
        }

        // Increment usage count
        await client.query(
            `UPDATE "1464_discount_codes" SET "usedCount" = COALESCE("usedCount", 0) + 1 WHERE code = $1`,
            [discountCode]
        );
    }

    const availabilityCheck = await checkProductAvailability(products, client);
    if (!availabilityCheck.isAvailable) {
        const unavailableProductNames = availabilityCheck.unavailableProducts
            .map(item => item.productName).join(', ');
        throw {
            statusCode: 400,
            title: 'Availability Error',
            message: `${unavailableProductNames} is out of stock.`,
            unavailableProducts: availabilityCheck.unavailableProducts
        };
    }

     const enrichedProducts = await Promise.all(products.map(async (product) => {
        const result = await client.query(
            `SELECT 
                p."productName",
                p."productImagePaths",
                v->>'productPrice' AS "productPrice",
                v->>'discountedPrice' AS "discountedPrice"
             FROM "1464_products" p,
             jsonb_array_elements(p."productVariants") AS v
             WHERE p.id = $1
               AND v->>'size' = $2
               AND v->>'color' = $3`,
            [product.id, product.size, product.color]
        );

        const row = result.rows[0];
        const effectivePrice = row.discountedPrice && parseFloat(row.discountedPrice) > 0
            ? parseFloat(row.discountedPrice)
            : parseFloat(row.productPrice);

        return {
            ...product,
            productName: row.productName,
            productImagePaths: row.productImagePaths ?? [],
            price: effectivePrice,
            productPrice: parseFloat(row.productPrice),
        };
    }));

     const customOrderId = await generateUniqueOrderId(client);

    const { subtotal, totalAmount } = await calculateTotalFromDatabase(
        enrichedProducts, deliveryFee, pointsDiscount, firstOrderDiscount, codeDiscount || 0, client
    );

 
    const orderInsertQuery = `
        INSERT INTO "1464_orders" (
            "orderId", "userId", "totalAmount", "originalTotalAmount",
            "pointsUsed", "shippingInfo", "statusHistories", "currentStatus",
            "firstOrderDiscount", "discountCode", "codeDiscount", "paymentMethod", "deliveryFee",
            "createdAt", "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING "orderId"
    `;

    const initialStatus = [{
        status: 'ordered',
        timestamp: new Date().toISOString(),
        description: 'Order created'
    }];

    const orderResult = await client.query(orderInsertQuery, [
        customOrderId,
        userId || null,
        totalAmount,
        subtotal,
        pointsUsed,
        JSON.stringify(shippingInfo),
        JSON.stringify(initialStatus),
        'ordered',
        firstOrderDiscount || 0,
        discountCode || null,   // new
        codeDiscount || 0,      // new
        paymentMethod || "cod",
        deliveryFee || 1.0, // Default delivery fee if not provided
        new Date().toISOString(),
        new Date().toISOString()
    ]);

    const orderId = orderResult.rows[0].orderId;

    for (const product of products) {
        const productInsertQuery = `
            INSERT INTO "1464_order_items" (
                "orderId", "productId", "productName", "variant",
                "quantity", "effectivePrice", "originalPrice",
                "createdAt", "updatedAt", "statusHistories", "currentStatus"
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `;
        const variantInfo = { size: product.size, color: product.color };

        await client.query(productInsertQuery, [
            orderId, product.id, product.productName,
            JSON.stringify(variantInfo), product.purchasedQuantity,
            product.price, product.productPrice ?? product.price,
            new Date().toISOString(), new Date().toISOString(),
            JSON.stringify(initialStatus), 'ordered'
        ]);
    }

    await updateProductInventory(enrichedProducts, client);

    return { orderId, enrichedProducts, message: 'Order created successfully' };
}

//to validate discounted code
router.post("/1464/validate-discount-code", authenticateFirebaseToken, async (req, res) => {
    console.log("========== 1464 Validate Discount Code Route Hit ==========");
    const { code } = req.body;
    const client = await zingoPool.connect();
    console.log("Received discount code:", code);
    try {
        const discountQuery = `
            SELECT * FROM "1464_discount_codes"
            WHERE code = $1 
        `;
        const result = await client.query(discountQuery, [code]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Invalid or expired discount code"
            });
        }
        
        const discount = result.rows[0];
        return res.status(200).json({
            success: true,
            discount: {
                code: discount.code,
                type: discount.discountType,    // was discount.type
                value: discount.discountValue,  // was discount.value
                description: discount.description,
                minOrderValue: discount.minOrderValue,
            }
        });
    } catch (e) {
        console.error("Error validating discount code:", e);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    } finally {
        client.release();  // you were missing this
    }
});

// Updated route using the functions
router.post("/1464/order/create", authenticateFirebaseToken, 
    async (req, res) => {
        upload.single('paymentReceipt')(req, res, async (err) => {
            if (err) {
                console.error("Multer error:", err);
                return res.status(400).json({
                    success: false,
                    error: "File upload error",
                    details: err.message
                });
            }

            console.log("========== 1464 Create Order Route Hit ==========");
            console.log("Req Body:", req.body);
        
            const client = await zingoPool.connect();
            await client.query("BEGIN");
        
            try {
                let orderDetails, shippingInfo, paymentMethod, pointsUsed, pointsDiscount, 
                    firstOrderDiscount, discountCode, codeDiscount;

                if (req.body.orderData) {
                    const parsedOrderData = JSON.parse(req.body.orderData);
                    orderDetails      = parsedOrderData.orderDetails;
                    shippingInfo      = parsedOrderData.shippingInfo;
                    paymentMethod     = parsedOrderData.paymentMethod;
                    pointsUsed        = parsedOrderData.pointsUsed;
                    pointsDiscount    = parsedOrderData.pointsDiscount;
                    firstOrderDiscount = parsedOrderData.firstOrderDiscount || 0;
                    discountCode      = parsedOrderData.discountCode || null;
                    codeDiscount      = parsedOrderData.codeDiscount || 0;
                } else {
                    orderDetails      = req.body.orderDetails;
                    shippingInfo      = req.body.shippingInfo;
                    paymentMethod     = req.body.paymentMethod;
                    pointsUsed        = req.body.pointsUsed;
                    pointsDiscount    = req.body.pointsDiscount;
                    firstOrderDiscount = req.body.firstOrderDiscount || 0;
                    discountCode      = req.body.discountCode || null;
                    codeDiscount      = req.body.codeDiscount || 0;
                }

                if (!orderDetails || !orderDetails.products || !Array.isArray(orderDetails.products)) {
                    return res.status(400).json({
                        success: false,
                        error: "Invalid order details - products array is required"
                    });
                }
                
                if (!shippingInfo) {
                    return res.status(400).json({
                        success: false,
                        error: "Shipping information is required"
                    });
                }

                // Fetch postedBy from DB — never trust the client for this
                const productIds = orderDetails.products.map(p => p.id);
                const { rows: productRows } = await client.query(
                    `SELECT id, "postedBy" FROM "1464_products" WHERE id = ANY($1)`,
                    [productIds]
                );
                const postedByMap = Object.fromEntries(productRows.map(r => [r.id, r.postedBy]));
                console.log("postedByMap from DB:", postedByMap);

                const deliveryFee = getDeliveryFee(paymentMethod);
                
                const orderData = {
                    products: orderDetails.products,
                    shippingInfo,
                    deliveryFee,
                    paymentMethod,
                    pointsUsed,
                    pointsDiscount,
                    userId: req.user?.id || null,
                    paymentReceiptFile: req.file || null,
                    firstOrderDiscount: firstOrderDiscount || 0,
                    discountCode: discountCode || null,  
                    codeDiscount: codeDiscount || 0,      
                };

                const result = await createOrderWithAvailabilityCheck(orderData, client);

                const adminTelegramId = process.env.TELEGRAM_DEFAULT_CHAT_ID ?? 131693106;

                const notificationArgs = [
                    result.orderId, { ...orderDetails, products: result.enrichedProducts }, shippingInfo, deliveryFee,
                    paymentMethod, pointsUsed, pointsDiscount, firstOrderDiscount,
                    discountCode, codeDiscount,
                ];

                // Notify admin
                await sendTelegramOrderDetailsToId(adminTelegramId, ...notificationArgs);

                // Notify each unique seller using DB-sourced postedBy
                const uniqueSellerIds = [...new Set(Object.values(postedByMap))].filter(Boolean);
              for (const sellerId of uniqueSellerIds) {
                  const sellerResult = await client.query(
                      `SELECT "telegramId", "fullName", "phoneNumber" FROM users WHERE id = $1`,
                      [sellerId]
                  );
                  const seller = sellerResult.rows[0];
                  const sellerTelegramId = seller?.telegramId;
                  if (sellerTelegramId) {
                      await sendTelegramOrderDetailsToId(
                          sellerTelegramId,
                          ...notificationArgs,
                          seller.fullName,      // <-- now passed
                          seller.phoneNumber    // <-- now passed
                      );
                  }
              }

                if (req.file != null) {
                    await uploadMediaFilesToS3(req.file, req.user?.id, result.orderId, { pathPrefix: '1464/receipts' });
                }
                
                await client.query("COMMIT");
                
                return res.status(200).json({
                    success: true,
                    message: result.message,
                    orderId: result.orderId
                });

            } catch (e) {
                await client.query('ROLLBACK');
                console.error('Full error:', e);
                return res.status(e.statusCode || 500).json({
                    success: false,
                    error: e.message || "An unexpected error occurred",
                    title: e.title || "Error",
                    unavailableProducts: e.unavailableProducts || undefined
                });
            } finally {
                client.release();
            }
        });
    }
);
// For guest checkout. Any updates from the order/ceate will need to be update here as well
router.post("/1464/order/create/guest",
  async (req, res) => {
    upload.single('paymentReceipt')(req, res, async (err) => {
      if (err) {
        console.error("Multer error:", err);
        return res.status(400).json({
          success: false,
          error: "File upload error",
          details: err.message
        });
      }

      console.log("========== 1464 Create Guest Order Route Hit ==========");
      console.log("Req Body:", req.body);

      const client = await zingoPool.connect();
      await client.query("BEGIN");

      try {
        let orderDetails, shippingInfo, paymentMethod, discountCode, codeDiscount;

        if (req.body.orderData) {
          const parsed = JSON.parse(req.body.orderData);
          orderDetails  = parsed.orderDetails;
          shippingInfo  = parsed.shippingInfo;
          paymentMethod = parsed.paymentMethod;
          discountCode  = parsed.discountCode || null;
          codeDiscount  = parsed.codeDiscount || 0;
        } else {
          orderDetails  = req.body.orderDetails;
          shippingInfo  = req.body.shippingInfo;
          paymentMethod = req.body.paymentMethod;
          discountCode  = req.body.discountCode || null;
          codeDiscount  = req.body.codeDiscount || 0;
        }

        if (!orderDetails?.products || !Array.isArray(orderDetails.products)) {
          return res.status(400).json({
            success: false,
            error: "Invalid order details - products array is required"
          });
        }

        if (!shippingInfo) {
          return res.status(400).json({
            success: false,
            error: "Shipping information is required"
          });
        }

        // Fetch postedBy from DB
        const productIds = orderDetails.products.map(p => p.id);
        const { rows: productRows } = await client.query(
          `SELECT id, "postedBy" FROM "1464_products" WHERE id = ANY($1)`,
          [productIds]
        );
        const postedByMap = Object.fromEntries(productRows.map(r => [r.id, r.postedBy]));

        const deliveryFee = getDeliveryFee(paymentMethod);

        const orderData = {
          products:           orderDetails.products,
          shippingInfo,
          deliveryFee,
          paymentMethod,
          pointsUsed:         0,
          pointsDiscount:     0,
          userId:             null,
          paymentReceiptFile: req.file || null,
          firstOrderDiscount: 0,
          discountCode:       discountCode || null,
          codeDiscount:       codeDiscount || 0,
        };

        console.log("Guest Order Data:", orderData);

        const result = await createOrderWithAvailabilityCheck(orderData, client);

        const adminTelegramId = process.env.TELEGRAM_DEFAULT_CHAT_ID ?? 131693106;

        const notificationArgs = [
          result.orderId, { ...orderDetails, products: result.enrichedProducts }, shippingInfo, deliveryFee,
          paymentMethod, 0, 0, 0,   // pointsUsed, pointsDiscount, firstOrderDiscount all 0 for guests
          discountCode, codeDiscount,
        ];

        // Notify admin
        await sendTelegramOrderDetailsToId(adminTelegramId, ...notificationArgs);

        // Notify each unique seller
        const uniqueSellerIds = [...new Set(Object.values(postedByMap))].filter(Boolean);
        for (const sellerId of uniqueSellerIds) {
          const sellerResult = await client.query(
            `SELECT "telegramId", "fullName", "phoneNumber" FROM users WHERE id = $1`,
            [sellerId]
          );
          const seller = sellerResult.rows[0];
          if (seller?.telegramId) {
            await sendTelegramOrderDetailsToId(
              seller.telegramId,
              ...notificationArgs,
              seller.fullName,
              seller.phoneNumber
            );
          }
        }

        if (req.file) {
          await uploadMediaFilesToS3(req.file, 'guest', result.orderId, { pathPrefix: '1464/receipts' });
        }

        await client.query("COMMIT");

        return res.status(200).json({
          success: true,
          message: result.message,
          orderId: result.orderId
        });

      } catch (e) {
        await client.query("ROLLBACK");
        console.error("Guest order error:", e);
        return res.status(e.statusCode || 500).json({
          success: false,
          error: e.message || "An unexpected error occurred",
          title: e.title || "Error",
          unavailableProducts: e.unavailableProducts || undefined
        });
      } finally {
        client.release();
      }
    });
  }
);


module.exports = router;