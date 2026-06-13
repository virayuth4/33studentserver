const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateOrderId } = require("../../utils/generateOrderId");
const { calculateOrderStatus, OrderItemStatus } = require("../../utils/order/orderStatus");
require('dotenv').config();

router.post("/33/orders/:action/:orderId/:productId", authenticateFirebaseToken, async(req, res) => {
    console.log("====== 33 Update Order Status ======");
    const {action, orderId, productId} = req.params;
    const {sellerId} = req.body;
    const orderIdInt = parseInt(orderId, 10);
    const productIdInt = parseInt(productId, 10);
    const fees = 0.08;
    console.log("action", action)

    try {
        await zingoPool.query('BEGIN');

        // 1. Update the specific order item
        const updateItemQuery = `
      UPDATE "33orderItems"
        SET "statusHistories" = CASE
            WHEN "statusHistories" IS NULL THEN 
                jsonb_build_array(
                    jsonb_build_object(
                        'status', $1::text,
                        'description', '',
                        'timestamp', NOW()
                    )
                )
            ELSE
                "statusHistories" || jsonb_build_array(
                    jsonb_build_object(
                        'status', $1::text,
                        'description', '',
                        'timestamp', NOW()
                    )
                )
            END,
            "currentStatus" = $1
        WHERE "orderId" = $2 AND "productId" = $3
    `;
        await zingoPool.query(updateItemQuery, [action, orderIdInt, productIdInt]);

        // 2. Get all items for this order
        const itemsQuery = `
            SELECT "currentStatus" 
            FROM "33orderItems" 
            WHERE "orderId" = $1
        `;
        const itemsResult = await zingoPool.query(itemsQuery, [orderIdInt]);

        // 3. Calculate and update order status
        const newOrderStatus = calculateOrderStatus(itemsResult.rows);
        console.log("New Order Status:", newOrderStatus);
        const updateOrderQuery = `
        UPDATE "33orders"
            SET "statusHistories" = CASE
                WHEN "statusHistories" IS NULL THEN 
                    jsonb_build_array(
                        jsonb_build_object(
                            'status', $1::text,
                            'description', '',
                            'timestamp', NOW()
                        )
                    )
                ELSE
                    "statusHistories" || jsonb_build_array(
                        jsonb_build_object(
                            'status', $1::text,
                            'description', '',
                            'timestamp', NOW()
                        )
                    )
                END,
                "currentStatus" = $1
            WHERE "orderId" = $2
                `;
        await zingoPool.query(updateOrderQuery, [newOrderStatus, orderIdInt]);

        //  Get Buy Information and FCMToken
        const getBuyerQuery = `
        SELECT  o."userId"
        FROM "33orders" o
        JOIN "33studentUsers" u on o."userId" = u."userId"
        WHERE o."orderId" = $1
        `

        const buyerResult = await zingoPool.query(getBuyerQuery, [orderIdInt]);
        const buyerFCMToken = buyerResult.rows[0]?.fcmToken;

        // Send notification to buyer
        if (buyerFCMToken) {
            await notificationService.sendOrderStatusNotification(
                buyerFCMToken,
                action,
                orderIdInt,
                productIdInt,
                "order"
            );
        }

        await zingoPool.query('COMMIT');
        res.status(200).json({ 
            message: "Order status updated successfully",
            orderStatus: newOrderStatus
        });

    } catch (error) {
        await zingoPool.query('ROLLBACK');
        console.error("Error updating order status:", error);
        res.status(500).json({ error: "Failed to update order status" });
    }
});


// ====== Update Payment Status ======
router.post("/33/orders/:orderId/payment-status", authenticateFirebaseToken, async (req, res) => {
    console.log("====== 33 Update Payment Status ======");
    const { orderId } = req.params;
    const { paymentStatus, note } = req.body;

    const VALID_PAYMENT_STATUSES = ['paid', 'unpaid', 'refunded'];

    if (!paymentStatus) {
        return res.status(400).json({ error: "paymentStatus is required" });
    }

    if (!VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
        return res.status(400).json({ 
            error: `Invalid paymentStatus. Must be one of: ${VALID_PAYMENT_STATUSES.join(', ')}` 
        });
    }

    try {
        await zingoPool.query('BEGIN');

        // 1. Check order exists
        const orderCheckQuery = `SELECT "orderId" FROM "33orders" WHERE "orderId" = $1`;
        const orderCheckResult = await zingoPool.query(orderCheckQuery, [orderId]);

        if (orderCheckResult.rows.length === 0) {
            await zingoPool.query('ROLLBACK');
            return res.status(404).json({ error: "Order not found" });
        }

        // 2. Update paymentStatus on the order
        const updatePaymentStatusQuery = `
            UPDATE "33orders"
            SET "paymentStatus" = $1
            WHERE "orderId" = $2
        `;
        await zingoPool.query(updatePaymentStatusQuery, [paymentStatus, orderId]);

        // 3. Insert into payment status history
        const insertHistoryQuery = `
            INSERT INTO "33ordersPaymentStatus" ("orderId", "status", "note")
            VALUES ($1, $2, $3)
        `;
        await zingoPool.query(insertHistoryQuery, [orderId, paymentStatus, note || null]);

        await zingoPool.query('COMMIT');

        res.status(200).json({
            message: "Payment status updated successfully",
            orderId,
            paymentStatus,
        });

    } catch (error) {
        await zingoPool.query('ROLLBACK');
        console.error("Error updating payment status:", error);
        res.status(500).json({ error: "Failed to update payment status" });
    }
});


module.exports = router;