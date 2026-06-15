const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateOrderId } = require("../../utils/generateOrderId");
const { calculateOrderStatus, OrderItemStatus } = require("../../utils/order/orderStatus");
require('dotenv').config();

router.post("/33/orders/:action/:orderId/:productId", authenticateFirebaseToken, async (req, res) => {
    const { action, orderId, productId } = req.params;
    const productIdInt = parseInt(productId, 10);
    const userId = req.user.uid;

    // Guard early
    if (!orderId || isNaN(productIdInt)) {
        return res.status(400).json({ error: "Invalid orderId or productId" });
    }

    try {
        await zingoPool.query('BEGIN');

        // 1. Update item status
        await zingoPool.query(
            `UPDATE "33orderItems"
             SET "currentStatus" = $1
             WHERE "orderId" = $2 AND "productId" = $3`,
            [action, orderId, productIdInt]
        );

        // 2. Log item-level history → new table
        await zingoPool.query(
            `INSERT INTO "33orderItemStatusHistories" ("orderId", "productId", "status", "changedById")
             VALUES ($1, $2, $3, $4)`,
            [orderId, productIdInt, action, userId]
        );

        // 3. Recalculate order status
        const { rows } = await zingoPool.query(
            `SELECT "currentStatus" FROM "33orderItems" WHERE "orderId" = $1`,
            [orderId]
        );
        const newOrderStatus = calculateOrderStatus(rows);

        // 4. Update order status
        await zingoPool.query(
            `UPDATE "33orders" SET "currentStatus" = $1 WHERE "orderId" = $2`,
            [newOrderStatus, orderId]
        );

        // 5. Log order-level history → original table (no productId)
        await zingoPool.query(
            `INSERT INTO "33orderStatusHistories" ("orderId", "status")
             VALUES ($1, $2)`,
            [orderId, newOrderStatus]
        );

        await zingoPool.query('COMMIT');
        res.status(200).json({ message: "Order status updated successfully", orderStatus: newOrderStatus });

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