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

class OrderError extends Error {
  constructor(message, statusCode, title = "Error") {
    super(message);
    this.statusCode = statusCode;
    this.title = title;
  }
}

// New effective price logic supporting discountMode
const getEffectivePrice = (variant) => {
  if (variant.discountMode === 'percentage' && Number(variant.discountPercentage) > 0) {
    return Number(variant.productPrice) * (1 - Number(variant.discountPercentage) / 100);
  }
  if (variant.discountMode === 'price' && Number(variant.discountedPrice) > 0) {
    return Number(variant.discountedPrice);
  }
  return Number(variant.productPrice);
};

// ---- Telegram notification (kept mostly same, trimmed for brevity) ----
async function sendTelegramOrderDetailsToId(
  chatId, orderId, orderDetails, shippingInfo, deliveryFee,
  paymentMethod, deliveryMethod, pointsUsed, pointsDiscount, firstOrderDiscount,
  discountCode, codeDiscount, userFullName, userPhoneNumber
) {
  const botToken = process.env.TELEGRAM_ORDERS_BOT_TOKEN?.trim();
  if (!botToken || !chatId) {
    console.error("Missing bot token or chat ID");
    return { success: false, error: "Missing credentials" };
  }

  const products = orderDetails.products ?? [];
  const subtotal = products.reduce(
    (sum, item) => sum + (item.price ?? 0) * item.purchasedQuantity, 0
  );
  const finalTotal =
    subtotal + (deliveryFee ?? 0) - (pointsDiscount ?? 0) - (firstOrderDiscount ?? 0) - (codeDiscount ?? 0);

  const formatCurrency = (n) => Number(n).toFixed(2);

  const address =
    [shippingInfo?.address, shippingInfo?.commune, shippingInfo?.district, shippingInfo?.city]
      .filter(Boolean).join(", ") || "Address not provided";

  const itemLines = products.map((item) => {
    const price = item.price ?? 0;
    const meta = [item.color && `Color: ${item.color}`, item.size && `Size: ${item.size}`]
      .filter(Boolean).join(" | ");
    return (
      `• ${item.purchasedQuantity}x *${item.productName ?? "Unknown Product"}*\n` +
      (meta ? `   ${meta}\n` : "") +
      `   Price: $${formatCurrency(price)} → Subtotal: $${(price * item.purchasedQuantity).toFixed(2)}`
    );
  }).join("\n\n");

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
    `├ Delivery Method: ${deliveryMethod === 'pickup' ? 'Store Pickup' : deliveryMethod === 'grabExpress' ? 'Grab Express' : 'Normal'}\n` +
    `└ Payment: ${paymentLabel}\n` +
    `\n🛒 *ORDER ITEMS*\n${itemLines}\n` +
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
    console.error("Telegram error response:", error.response?.data);
    return { success: false, error: error.message };
  }
}

// ---- Order ID helpers ----
async function isOrderIdUnique(orderId, client) {
  const result = await client.query(
    `SELECT "orderId" FROM "33orders" WHERE "orderId" = $1`,
    [orderId]
  );
  return result.rows.length === 0;
}

async function generateUniqueOrderId(client) {
  let orderId;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!isUnique && attempts < maxAttempts) {
    orderId = generateOrderId();
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

// ---- Availability check against 33products ----
async function checkProductAvailability(products, client) {
  const unavailableProducts = [];

  for (const product of products) {
    const productQuery = `
      SELECT "productVariants"
      FROM "33products"
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

    const availableQuantity = parseInt(matchingVariant.availableQuantity);
    const requestedQuantity = product.purchasedQuantity;

    if (availableQuantity < requestedQuantity) {
      unavailableProducts.push({
        productId: product.id,
        productName: product.productName,
        requestedQuantity,
        availableQuantity,
        reason: 'Insufficient quantity'
      });
    }
  }

  return {
    isAvailable: unavailableProducts.length === 0,
    unavailableProducts
  };
}

// ---- Inventory update against 33products ----
async function updateProductInventory(products, client) {
  for (const product of products) {
    const updateInventoryQuery = `
      UPDATE "33products"
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

// ---- Totals calculation from DB, using new variant shape ----
async function calculateTotalFromDatabase(products, deliveryFee, pointsDiscount, firstOrderDiscount = 0, codeDiscount = 0, client) {
  let subtotal = 0;

  for (const product of products) {
    const variantQuery = `
      SELECT variant
      FROM "33products",
      jsonb_array_elements("productVariants") AS variant
      WHERE id = $1
        AND variant->>'size' = $2
        AND variant->>'color' = $3
    `;
    const variantResult = await client.query(variantQuery, [product.id, product.size, product.color]);
    const variant = variantResult.rows[0].variant;

    const actualPrice = getEffectivePrice(variant);
    subtotal += actualPrice * product.purchasedQuantity;
  }

  const fee = Number(deliveryFee) || 0;
  const points = Number(pointsDiscount) || 0;
  const firstOrder = Number(firstOrderDiscount) || 0;
  const code = Number(codeDiscount) || 0;

  return {
    subtotal,
    totalAmount: subtotal + fee - points - firstOrder - code
  };
}
// ---- Create order ----
async function createOrderWithAvailabilityCheck(orderData, client) {
const {
  products, shippingInfo, deliveryFee, paymentMethod,
  pointsUsed, pointsDiscount, userId, firstOrderDiscount,
  discountCode, codeDiscount, deliveryMethod
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

    if (dc.expiresAt && new Date() > new Date(dc.expiresAt)) {
      throw { statusCode: 400, title: 'Expired Code', message: 'This discount code has expired' };
    }

    if (dc.usageLimit !== null && dc.usedCount >= dc.usageLimit) {
      throw { statusCode: 400, title: 'Code Exhausted', message: 'This discount code has reached its usage limit' };
    }

    const userUsageResult = await client.query(
      `SELECT COUNT(*) FROM "33orders" WHERE "userId" = $1 AND "discountCode" = $2`,
      [userId, discountCode]
    );
    if (parseInt(userUsageResult.rows[0].count) >= dc.userUsageLimit) {
      throw { statusCode: 400, title: 'Already Used', message: 'You have already used this discount code' };
    }

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

  // Enrich products with name, image, effective price, original price, and full variant
  const enrichedProducts = await Promise.all(products.map(async (product) => {
    const result = await client.query(
      `SELECT
          p."productName",
          p."productImagePaths",
          v AS "variant"
       FROM "33products" p,
       jsonb_array_elements(p."productVariants") AS v
       WHERE p.id = $1
         AND v->>'size' = $2
         AND v->>'color' = $3`,
      [product.id, product.size, product.color]
    );

    const row = result.rows[0];
    const variant = row.variant;
    const effectivePrice = getEffectivePrice(variant);

    return {
      ...product,
      productName: row.productName,
      productImagePaths: row.productImagePaths ?? [],
      price: effectivePrice,
      productPrice: Number(variant.productPrice),
      variant // keep full variant snapshot for storage
    };
  }));

  const customOrderId = await generateUniqueOrderId(client);

  const { subtotal, totalAmount } = await calculateTotalFromDatabase(
    enrichedProducts, deliveryFee, pointsDiscount, firstOrderDiscount, codeDiscount || 0, client
  );

  const orderInsertQuery = `
    INSERT INTO "33orders" (
      "orderId", "userId", "totalAmount", "originalTotalAmount",
      "pointsUsed", "shippingInfo", "statusHistories", "currentStatus",
      "discountCode", "codeDiscount", "paymentMethod", "paymentStatus", "deliveryFee",
      "deliveryMethod", "createdAt", "updatedAt"
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
  discountCode || null,
  codeDiscount || 0,
  paymentMethod || "cod",
  'pending',
  deliveryFee || 1.0,
  deliveryMethod || 'normal',
  new Date().toISOString(),
  new Date().toISOString()
]);

  const orderId = orderResult.rows[0].orderId;

  for (const product of enrichedProducts) {
    const itemInsertQuery = `
      INSERT INTO "33orderItems" (
        "orderId", "productId", "productName", "variant",
        "quantity", "effectivePrice", "originalPrice",
        "createdAt", "updatedAt", "statusHistories", "currentStatus"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;

    await client.query(itemInsertQuery, [
      orderId,
      product.id,
      product.productName,
      JSON.stringify(product.variant), // full variant snapshot, including size/color/discountMode/etc
      product.purchasedQuantity,
      product.price,          // effectivePrice
      product.productPrice,   // originalPrice (base productPrice)
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify(initialStatus),
      'ordered'
    ]);
  }

  await updateProductInventory(enrichedProducts, client);

  return { orderId, enrichedProducts, message: 'Order created successfully' };
}

// ---- Validate discount code ----
router.post("/33/validate-discount-code", authenticateFirebaseToken, async (req, res) => {
  console.log("========== 33 Validate Discount Code Route Hit ==========");
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
        type: discount.discountType,
        value: discount.discountValue,
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
    client.release();
  }
});

// ---- Authenticated order create ----
router.post("/33/order/create", authenticateFirebaseToken,
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

      console.log("========== 33 Create Order Route Hit ==========");
      console.log("Req Body:", req.body);
      console.log("User Info from token:", req.user.uid || req.user?.user_id);


      const client = await zingoPool.connect();
      await client.query("BEGIN");

      try {
       let orderDetails, shippingInfo, paymentMethod, deliveryMethod, pointsUsed, pointsDiscount,
        firstOrderDiscount, discountCode, codeDiscount;

        pointsUsed = 0;
        pointsDiscount = 0;
        firstOrderDiscount = 0;

    if (req.body.orderData) {
      const parsed = JSON.parse(req.body.orderData);
      orderDetails   = parsed.orderDetails;
      shippingInfo   = parsed.shippingInfo;
      paymentMethod  = parsed.paymentMethod;
      deliveryMethod = parsed.deliveryMethod || 'normal';
      discountCode   = parsed.discountCode || null;
      codeDiscount   = parsed.codeDiscount || 0;
    } else {
      orderDetails   = req.body.orderDetails;
      shippingInfo   = req.body.shippingInfo;
      paymentMethod  = req.body.paymentMethod;
      deliveryMethod = req.body.deliveryMethod || 'normal';
      discountCode   = req.body.discountCode || null;
      codeDiscount   = req.body.codeDiscount || 0;
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
          `SELECT id, "postedBy" FROM "33products" WHERE id = ANY($1)`,
          [productIds]
        );
        const postedByMap = Object.fromEntries(productRows.map(r => [r.id, r.postedBy]));
        console.log("postedByMap from DB:", postedByMap);

        const deliveryFee = getDeliveryFee(paymentMethod, deliveryMethod);


     const orderData = {
        products: orderDetails.products,
        shippingInfo,
        deliveryFee,
        deliveryMethod,
        paymentMethod,
        pointsUsed,
        pointsDiscount,
        userId: req.user?.uid || req.user?.user_id || null,
        paymentReceiptFile: req.file || null,
        firstOrderDiscount: firstOrderDiscount || 0,
        discountCode: discountCode || null,
        codeDiscount: codeDiscount || 0,
      };

        const result = await createOrderWithAvailabilityCheck(orderData, client);

        const adminTelegramId = process.env.TELEGRAM_DEFAULT_CHAT_ID ?? 131693106;

     const notificationArgs = [
          result.orderId, { ...orderDetails, products: result.enrichedProducts }, shippingInfo, deliveryFee,
          paymentMethod, deliveryMethod, 0, 0, 0,
          discountCode, codeDiscount,
        ];

        await sendTelegramOrderDetailsToId(adminTelegramId, ...notificationArgs);

        const uniqueSellerIds = [...new Set(Object.values(postedByMap))].filter(Boolean);
        for (const sellerId of uniqueSellerIds) {
          const sellerResult = await client.query(
            `SELECT "telegramChatId", "name", "phone" FROM "33studentusers" WHERE "userId" = $1`,
            [sellerId]
          );
          const seller = sellerResult.rows[0];
          const sellerTelegramId = seller?.telegramId;
          if (sellerTelegramId) {
            await sendTelegramOrderDetailsToId(
              sellerTelegramId,
              ...notificationArgs,
              seller.fullName,
              seller.phoneNumber
            );
          }
        }

        if (req.file != null) {
          await uploadMediaFilesToS3(req.file, req.user?.id, result.orderId, { pathPrefix: '33/receipts' });
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

// ---- Guest order create ----
router.post("/33/order/create/guest",
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

      console.log("========== 33 Create Guest Order Route Hit ==========");
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

        const productIds = orderDetails.products.map(p => p.id);
        const { rows: productRows } = await client.query(
          `SELECT id, "postedBy" FROM "33products" WHERE id = ANY($1)`,
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
          paymentMethod, 0, 0, 0,
          discountCode, codeDiscount,
        ];

        await sendTelegramOrderDetailsToId(adminTelegramId, ...notificationArgs);

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
          await uploadMediaFilesToS3(req.file, 'guest', result.orderId, { pathPrefix: '33/receipts' });
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