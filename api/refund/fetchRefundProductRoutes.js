const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");


const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');


router.get('/order/:orderId/:productId', authenticateFirebaseToken, async(req,res) => {
    console.log('==========/orders/:orderId/:productId route hit==========')
    console.log('req params', req.params)
    const { orderId, productId } = { 
        orderId: Number(req.params.orderId), 
        productId: Number(req.params.productId) 
      };
    const userId = req.user.id

    console.log('orderId:', orderId, "orderId Type", typeof(orderId))
    console.log('productId',productId, "productId type", typeof(productId))

    try {
        const ownershipQuery = `
            SELECT "userId"
                FROM "orders"
                WHERE "orderId" = $1
                LIMIT 1;
        `
   
        const ownershipCheck = await zingoPool.query(ownershipQuery, [orderId])
        console.log('Database userId:', ownershipCheck.rows[0]?.userId, typeof(ownershipCheck.rows[0]?.userId))
        console.log('Comparison result:', ownershipCheck.rows[0]?.userId === userId)
        // if no order found or userId doesn't match
        if (ownershipCheck.rows.length === 0) {
            return res.status(404).json({
                message: "Order not found",
                order: null,
                items:[]
            })
        }
        if (ownershipCheck.rows[0].userId !== userId) {
            return res.status(403).json({
                message: "Unauthorized access to order",
                order: null,
                items: [],
                isOwner:false
            });
        }

        const query = `
        SELECT 
            o."id", o."userId", o."currentStatus", o."totalAmount", o."buyerPhoneNumber", o."paymentMethod",
            o."buyerAddress", o."buyerCity", o."buyerFirstName", o."buyerLastName", o."assignedDriver", o."assignedTime",
            o."deliveredTime", o."createdAt", o."orderId",
            oi."purchasedQuantity" as "orderedQuantity",
            oi."productPrice" as "priceAtOrder",
            p."productName", p."productCategory",
            p."phoneNumber" as "sellerPhone", p."productImagePaths",
            p."sellerAddress",
            p."sellerCity",
            p."productCondition",
            p."productStockStatus",
            p."productBrand",
            p."productDescription"
        FROM "orders" o
        LEFT JOIN "order_items" oi ON o."orderId" = oi."orderId"
        LEFT JOIN "products" p ON oi."productId" = p."id"
        WHERE o."orderId" = $1 AND oi."productId" = $2;

        `
        const result = await zingoPool.query(query, [orderId, productId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "No order confirmation found",
                order: null,
                items: [],
                
            });
        }

        const orderInfo = {
            id: result.rows[0].id,
            orderId: result.rows[0].orderId,
            userId: result.rows[0].userId,
            orderStatus: result.rows[0].orderStatus,
            totalAmount: result.rows[0].totalAmount,
            buyerPhoneNumber: result.rows[0].buyerPhoneNumber,
            buyerAddress: result.rows[0].buyerAddress,
            buyerCity: result.rows[0].buyerCity,
            buyerFirstName: result.rows[0].buyerFirstName,
            buyerLastName: result.rows[0].buyerLastName,
            assignedDriver: result.rows[0].assignedDriver,
            assignedTime: result.rows[0].assignedTime,
            deliveredTime: result.rows[0].deliveredTime,
            createdAt: result.rows[0].createdAt
        };

        // Each row represents an item in the order
        const items = result.rows.map(row => ({
            quantity: row.orderedQuantity,
            priceAtOrder: row.priceAtOrder,
            productImagePaths: row.productImagePaths,
            productName: row.productName,
            productCategory: row.productCategory,
            sellerPhone: row.sellerPhone,
            sellerAddress: row.sellerAddress,
            sellerCity: row.sellerCity,
            productCondition: row.productCondition,
            productStockStatus: row.productStockStatus,
            productDescription: row.productDescription
        }));
        // console.log('items', items)
        // console.log('order', orderInfo)
        res.status(200).json({
            order: orderInfo,
            isOwner: true,
            items: items,
            paymentMethod: result.rows[0].paymentMethod
        });



    } catch(error) {
        console.error(`Error with fetching confirmation product information`)
    }
})

module.exports = router