const express = require("express");
const router = express.Router();
const zingoPool = require("../../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../../rateLimiter");
const { generateOrderId } = require("../../../utils/generateOrderId");
const notificationService = require("../../../utils/notifications/deliveryStatusNotifications")
const { OrderItemStatus, calculateOrderStatus } = require('../../../utils/order/orderStatus');



router.post('/orders/cancel/:orderId', authenticateFirebaseToken, async (req, res) => {
    console.log("======Cancel Order ======");
    const { orderId } = req.params;
    const { status } = req.body;
    console.log("status", status);
    console.log(orderId, orderId);
    
    const newStatusHistory = {
        status: status,
        description: "Order cancelled by customer",
        timestamp: new Date(),
    };
    
    // Begin a transaction to ensure all operations succeed or fail together
    const client = await zingoPool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. Update the main order status
        const updateOrderQuery = `
            UPDATE orders
            SET "currentStatus" = $1,
                "statusHistories" = "statusHistories" || $2::jsonb
            WHERE "orderId" = $3
        `;
        
        await client.query(updateOrderQuery, [status, JSON.stringify([newStatusHistory]), orderId]);
        
        // 2. Get all product IDs from order_items for this order
        const getOrderItemsQuery = `
            SELECT "productId" FROM order_items
            WHERE "orderId" = $1
        `;
        
        const orderItemsResult = await client.query(getOrderItemsQuery, [orderId]);
        const productIds = orderItemsResult.rows.map(row => row.productId);
        
        // 3. Update each product's status in order_items
        if (productIds.length > 0) {
            const updateOrderItemsQuery = `
                UPDATE order_items
                SET "currentStatus" = $1,
                    "statusHistories" = "statusHistories" || $2::jsonb
                WHERE "orderId" = $3
            `;
            
            await client.query(updateOrderItemsQuery, [status, JSON.stringify([newStatusHistory]), orderId]);
            
            console.log(`Updated status for ${productIds.length} products in order ${orderId}`);
        }
        
        await client.query('COMMIT');
        res.status(200).json({ message: "Order and associated products cancelled successfully" });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error cancelling order:", error);
        res.status(500).json({ error: "Failed to cancel order" });
    } finally {
        client.release();
    }
});

router.post("/orders/:action/:orderId/:productId", authenticateFirebaseToken, async(req, res) => {
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
      UPDATE order_items
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
            FROM order_items 
            WHERE "orderId" = $1
        `;
        const itemsResult = await zingoPool.query(itemsQuery, [orderIdInt]);

        // 3. Calculate and update order status
        const newOrderStatus = calculateOrderStatus(itemsResult.rows);
        const updateOrderQuery = `
     UPDATE orders
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

        

        // Handle delivered status and fees
        if (action === OrderItemStatus.DELIVERED) {
            const getProductPriceQuery = `
                SELECT "productPrice" 
                FROM order_items
                WHERE "orderId" = $1 AND "productId" = $2
            `;
            const productPriceResult = await zingoPool.query(getProductPriceQuery, [orderIdInt, productIdInt]);
            const productPrice = productPriceResult.rows[0]?.productPrice;
            
            if (productPrice) {
                const billableAmount = productPrice * fees;
                const updateBillableAmountQuery = `
                    UPDATE users
                    SET "billableAmount" = "billableAmount" + $1
                    WHERE "id" = $2
                `;
                await zingoPool.query(updateBillableAmountQuery, [billableAmount, sellerId]);
            }
        }

        //  Get Buy Information and FCMToken
        const getBuyerQuery = `
        SELECT u."fcmToken", o."userId"
        FROM orders o
        JOIN users u on o."userId" = u."id"
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


module.exports = router;