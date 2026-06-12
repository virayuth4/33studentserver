    const express = require("express");
    const router = express.Router();
    const zingoPool = require("../../../database/pgZingo");
    const multer = require('multer');
    const authenticateFirebaseToken = require("../../../auth/authFirebaseToken")
    const axios = require('axios');
    const createRateLimiterMiddleware = require("../../rateLimiter");
    const { generateOrderId } = require("../../../utils/generateOrderId");


router.get("/dashboard/orders/:status?", authenticateFirebaseToken, async (req, res) => {
    console.log("==========Dashboard Orders Route Hit==========");
    const userId = req.user.id;
    const status = req.params.status;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    console.log("status", status)

    const productIdQuery = `
    SELECT id FROM products
    WHERE "postedBy" = $1
    `;
    const productIdResult = await zingoPool.query(productIdQuery, [userId]);
    const productIds = productIdResult.rows.map(product => product.id);

    if (productIds.length > 0) {
        let orderItemsQuery = `
            SELECT oi.*, 
            p."productName", 
            p."productCategory", 
            p."phoneNumber", 
            p."productPrice", 
            p."productDescription", 
            p."productImagePaths", 
            p."slug", 
            p."productCondition", 
            p."productStockStatus",
            p."productBrand",
            o."buyerAddress", 
            o."buyerFullName", 
            o."buyerCity", 
            o."buyerPhoneNumber",
            o."buyerLastName",
            o."buyerFirstName"
        FROM order_items oi
        LEFT JOIN products p ON oi."productId" = p.id
        LEFT JOIN orders o ON oi."orderId" = o."orderId"
        WHERE oi."productId" IN (${productIds.join(',')})
        `;

        // Add status filter if status parameter is provided
        if (status) {
            switch (status) {
                case 'ordered':
                    orderItemsQuery += ` AND oi."currentStatus" = 'ordered'`;
                    break;
                case 'accepted':
                    orderItemsQuery += ` AND oi."currentStatus" = 'accepted'`;
                    break;
                case 'preparing-for-delivery':
                    orderItemsQuery += ` AND oi."currentStatus" = 'preparingForDelivery'`;
                    break;
                case 'out-for-delivery':
                    orderItemsQuery += ` AND oi."currentStatus" = 'outForDelivery'`;
                    break;
                case 'delivered':
                    orderItemsQuery += ` AND oi."currentStatus" = 'delivered'`;
                    break;
                case 'cancelled':
                    orderItemsQuery += ` AND oi."currentStatus" = 'cancelled'`;
                    break;
                default:
                    return res.status(400).json({ error: 'Invalid status parameter' });
            }
        }

        // Add count query to get total number of records
        const countQuery = `SELECT COUNT(*) FROM (${orderItemsQuery}) AS count_query`;

        try {
            // Add pagination to the main query
            orderItemsQuery += ` ORDER BY oi."createdAt" DESC LIMIT $1 OFFSET $2`;
            
            const [orderItemsResult, countResult] = await Promise.all([
                zingoPool.query(orderItemsQuery, [limit, offset]),
                zingoPool.query(countQuery)
            ]);
       

            const total = parseInt(countResult.rows[0].count);
            
            res.status(200).json({ 
                orderItems: orderItemsResult.rows,
                total,
                currentPage: page,
                totalPages: Math.ceil(total / limit)
            });
        } catch (error) {
            console.error('Database query error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    } else {
        res.status(200).json({ 
            orderItems: [],
            total: 0,
            currentPage: 1,
            totalPages: 0
        });
    }
});

module.exports = router;