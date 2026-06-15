const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateOrderId } = require("../../utils/generateOrderId");
const { ContentAndApprovalsListInstance } = require("twilio/lib/rest/content/v1/contentAndApprovals");
require('dotenv').config();


router.get('/1464/orders', authenticateFirebaseToken, async (req, res) => {
    console.log('==========33 orders route hit==========')
    const userId = req.user.uid
    const page = parseInt(req.query.page) || 1
    const limit = 5  // 5 orders per page
    const offset = (page - 1) * limit
    console.log('userId:', userId, "userId Type", typeof(userId), 'page', page, 'offset:', offset)
    

    try {
        // First, get total count of orders
        const countQuery = `
            SELECT COUNT(DISTINCT o."orderId") 
            FROM "33orders" o 
            WHERE o."userId" = $1
        `
        const countResult = await zingoPool.query(countQuery, [userId])
        const totalOrders = parseInt(countResult.rows[0].count)
        
        console.log('Total orders for user:', totalOrders); // Debug log

        // If user has no orders at all, return empty result
        if (totalOrders === 0) {
            return res.status(200).json({
                message: "No orders found",
                orders: [],
                pagination: {
                    currentPage: page,
                    totalPages: 0,
                    totalOrders: 0,
                    ordersPerPage: limit
                }
            });
        }

        // Calculate total pages
        const totalPages = Math.ceil(totalOrders / limit);
        
        // If requesting a page beyond available pages, return empty but with correct pagination
        if (page > totalPages) {
            return res.status(200).json({
                message: "No orders found for this page",
                orders: [],
                pagination: {
                    currentPage: page,
                    totalPages: totalPages,
                    totalOrders: totalOrders,
                    ordersPerPage: limit
                }
            });
        }

        // Get the orderIds for this page
        const orderIdsQuery = `
            SELECT "orderId"
            FROM "33orders"
            WHERE "userId" = $1
            ORDER BY "createdAt" DESC
            LIMIT $2 OFFSET $3
        `
        const orderIdsResult = await zingoPool.query(orderIdsQuery, [userId, limit, offset])
        
        console.log('Order IDs found:', orderIdsResult.rows.map(r => r.orderId)); // Debug log
        
        if (orderIdsResult.rows.length === 0) {
            return res.status(200).json({
                message: "No orders found for this page",
                orders: [],
                pagination: {
                    currentPage: page,
                    totalPages: totalPages,
                    totalOrders: totalOrders,
                    ordersPerPage: limit
                }
            });
        }

        // Extract orderIds for the IN clause
        const orderIds = orderIdsResult.rows.map(row => row.orderId);
        const placeholders = orderIds.map((_, index) => `$${index + 2}`).join(', ');

        // Get full order details with items and products for these specific orders
        const query = `
            SELECT 
                o."orderId",
                o."userId",
                o."totalAmount",
                o."statusHistories",
                o."paymentStatus",
                o."createdAt" as "orderCreatedAt",
                o."updatedAt" as "orderUpdatedAt",
                -- Order Items
                oi."id" as "orderItemId",
                oi."productId",
                oi."quantity",
                oi."effectivePrice" as "itemPrice",
                oi."variant" as "productVariant",
                oi."createdAt" as "itemCreatedAt",
                -- Products
                p."id" as "productDbId",
                p."productName",
                p."productPrice",
                p."productImagePaths"
            FROM "33orders" o
            LEFT JOIN "33orderItems" oi ON o."orderId" = oi."orderId"
            LEFT JOIN "33products" p ON oi."productId" = p."id"
            WHERE o."userId" = $1 AND o."orderId" IN (${placeholders})
            ORDER BY o."createdAt" DESC, oi."id";
        `
        
        const result = await zingoPool.query(query, [userId, ...orderIds])
        
        console.log('Query result rows:', result.rows.length); // Debug log

        // Group the results by order
        const ordersMap = new Map();
        
        result.rows.forEach(row => {
            const orderId = row.orderId;
            
            // Get the current status from statusHistories
            let currentStatus = 'ordered'; // default
            if (row.statusHistories && Array.isArray(row.statusHistories)) {
                const latestStatus = row.statusHistories[row.statusHistories.length - 1];
                currentStatus = latestStatus?.status || 'ordered';
            }
            
            // If order doesn't exist in map, create it
            if (!ordersMap.has(orderId)) {
                ordersMap.set(orderId, {
                    orderId: row.orderId,
                    userId: row.userId,
                    totalAmount: row.totalAmount,
                    paymentStatus: row.paymentStatus,
                    currentStatus: currentStatus,
                    statusHistories: row.statusHistories,
                    createdAt: row.orderCreatedAt,
                    updatedAt: row.orderUpdatedAt,
                    items: []
                });
            }
            
            // Add order item and product info if they exist
            if (row.orderItemId) {
                const orderItem = {
                    id: row.orderItemId,
                    productId: row.productId,
                    productVariant: row.productVariant,
                    orderedQuantity: row.quantity,
                    priceAtOrder: row.itemPrice,
                    productName: row.productName,
                    productPrice: row.productPrice,
                    productImagePaths: row.productImagePaths,
                    createdAt: row.itemCreatedAt
                };
                
                ordersMap.get(orderId).items.push(orderItem);
            }
        });

        // Convert map to array and ensure correct order
        const orders = orderIds.map(orderId => ordersMap.get(orderId)).filter(Boolean);

        // console.log("Structured orders:", JSON.stringify(orders, null, 2));
        // console.log("Final orders count:", orders.length); // Debug log

        res.status(200).json({
            message: "Orders retrieved successfully",
            orders: orders,
            pagination: {
                currentPage: page,
                totalPages: totalPages,
                totalOrders: totalOrders,
                ordersPerPage: limit
            }
        });

    } catch (error) {
        console.error('Error with fetching user orders:', error)
        res.status(500).json({
            message: "Error fetching orders",
            error: error.message
        })
    }
})

router.get('/33/order/:orderId', authenticateFirebaseToken, async (req, res) => {
    console.log('==========33 orderId route hit==========')
    const userId = req.user.uid
    console.log("req query", req.query)
    console.log("req params", req.params)
    const page = parseInt(req.query.page) || 1
    const limit = 5  // 5 orders per page
    const offset = (page - 1) * limit
    
    // Fix: Get orderId from req.params, not req.query
    const orderId = req.params.orderId

    try {
        // Modified query to get a specific order by orderId and userId
        const query = `
            SELECT 
                o."orderId",
                o."userId",
                o."totalAmount",
                o."statusHistories",
                o."pointsUsed",
                o."shippingInfo",
                o."paymentMethod",
                o."paymentStatus",
                o."deliveryFee",
                o."createdAt" as "orderCreatedAt",
                o."updatedAt" as "orderUpdatedAt",
                o."storeLocationId",
                -- Order Items
                oi."id" as "orderItemId",
                oi."productId",
                oi."quantity",
                oi."effectivePrice" as "itemPrice",
                oi."currentStatus" as "itemCurrentStatus",
                oi."statusHistories" as "itemStatusHistories",
                oi."variant",
                oi."createdAt" as "itemCreatedAt",
                -- Products
                p."id" as "productDbId",
                p."productName",
                p."productPrice",
                p."productImagePaths",
                p."productVariants",
                -- Store
                sl."storeId",
                sl."locationName" as "storeName",
                sl."address" as "storeAddress",
                sl."city" as "storeCity",
                sl."googleMapUrl" as "storeGoogleMapUrl",
                sl."phoneNumber" as "storePhone"

            FROM "33orders" o
            LEFT JOIN "33orderItems" oi ON o."orderId" = oi."orderId"
            LEFT JOIN "33products" p ON oi."productId" = p."id"
            LEFT JOIN "33storeLocations" sl ON o."storeLocationId" = sl."storeId"
            WHERE o."userId" = $1 AND o."orderId" = $2
            ORDER BY oi."id";
        `
        const result = await zingoPool.query(query, [userId, orderId])
    
        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Order not found"
            });
        }

        // Process the first row to get order details
        const firstRow = result.rows[0];
        
        // Get the current status from statusHistories
        let currentStatus = 'ordered'; // default
        if (firstRow.statusHistories && Array.isArray(firstRow.statusHistories)) {
            const latestStatus = firstRow.statusHistories[firstRow.statusHistories.length - 1];
            currentStatus = latestStatus?.status || 'ordered';
        }

        // Build the order object
        const order = {
            orderId: firstRow.orderId,
            userId: firstRow.userId,
            totalAmount: firstRow.totalAmount,
            deliveryFee: firstRow.deliveryFee,
            currentStatus: currentStatus,
            paymentMethod: firstRow.paymentMethod,
            paymentStatus: firstRow.paymentStatus,
            order: {
                createdAt: firstRow.orderCreatedAt,
                updatedAt: firstRow.orderUpdatedAt,
                buyerAddress: firstRow.buyerAddress,
                buyerCity: firstRow.buyerCity,
                buyerPhoneNumber: firstRow.buyerPhoneNumber,
                totalAmount: firstRow.totalAmount,
                ordersStatusHistories: firstRow.statusHistories || [],
                pointsUsed: firstRow.pointsUsed || 0,
                shippingInfo: firstRow.shippingInfo || {}
            },
            items: [],
            storeLocation: firstRow.storeId ? {
                    storeId: firstRow.storeId,
                    name: firstRow.storeName,
                    address: firstRow.storeAddress,
                    city: firstRow.storeCity,
                    googleMapUrl: firstRow.storeGoogleMapUrl,
                    phone: firstRow.storePhone,
                } : null,
                        };

        // Add all order items with their individual status histories
        result.rows.forEach(row => {
            if (row.orderItemId) {
                const orderItem = {
                    id: row.orderItemId,
                    productId: row.productId,
                    quantity: row.quantity,
                    priceAtOrder: row.itemPrice,
                    productName: row.productName,
                    productPrice: row.productPrice,
                    productImagePaths: row.productImagePaths,
                    variant: row.variant,
                    currentStatus: row.itemCurrentStatus || 'ordered', // Default to 'ordered' if not set
                    statusHistories: row.itemStatusHistories || [], // Added item status histories
                    createdAt: row.itemCreatedAt
                };
                
                order.items.push(orderItem);
            }
        });

        console.log("Order details:", JSON.stringify(order, null, 2));

        res.status(200).json(order);

    } catch (error) {
        console.error('Error with fetching order details:', error)
        res.status(500).json({
            message: "Error fetching order details",
            error: error.message
        })
    }
})

router.get('/1464/order/track/:orderId', async (req, res) => {
  console.log('==========1464 order track route hit==========')
  const { orderId } = req.params

  // ── Auto-detect: 19 digits = orderId, anything shorter = phone number ──
  const digitsOnly = orderId.replace(/\D/g, '')
  const isOrderId = digitsOnly.length === 19

  console.log(`Input: "${orderId}" → detected as ${isOrderId ? 'orderId' : 'phone number'}`)

  try {
    const itemFields = `
      oi."id" as "orderItemId",
      oi."productId",
      oi."quantity",
      oi."effectivePrice" as "itemPrice",
      oi."currentStatus" as "itemCurrentStatus",
      oi."statusHistories" as "itemStatusHistories",
      oi."variant",
      oi."createdAt" as "itemCreatedAt",
      p."productName",
      p."productPrice",
      p."productImagePaths"
    `

    const orderFields = `
      o."orderId",
      o."userId",
      o."totalAmount",
      o."statusHistories",
      o."pointsUsed",
      o."shippingInfo",
      o."paymentMethod",
      o."paymentStatus",
      o."deliveryFee",
      o."createdAt" as "orderCreatedAt",
      o."updatedAt" as "orderUpdatedAt"
    `

    let result

    if (isOrderId) {
      // ── Lookup by orderId ──
      const query = `
        SELECT ${orderFields}, ${itemFields}
        FROM "1464_orders" o
        LEFT JOIN "1464_order_items" oi ON o."orderId" = oi."orderId"
        LEFT JOIN "1464_products" p ON oi."productId" = p."id"
        WHERE o."orderId" = $1
        ORDER BY oi."id"
      `
      result = await zingoPool.query(query, [orderId])

    } else {
      // ── Lookup by phone number (inside shippingInfo JSONB) ──
      const query = `
        SELECT ${orderFields}, ${itemFields}
        FROM "1464_orders" o
        LEFT JOIN "1464_order_items" oi ON o."orderId" = oi."orderId"
        LEFT JOIN "1464_products" p ON oi."productId" = p."id"
        WHERE o."shippingInfo"->>'phoneNumber' = $1
        ORDER BY o."createdAt" DESC, oi."id"
      `
      result = await zingoPool.query(query, [orderId])
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: isOrderId ? 'Order not found' : 'No orders found for that phone number'
      })
    }

    // ── Shape rows into order(s) ──
    const buildOrder = (rows) => {
      const first = rows[0]

      let currentStatus = 'ordered'
      if (Array.isArray(first.statusHistories)) {
        const latest = first.statusHistories[first.statusHistories.length - 1]
        currentStatus = latest?.status || 'ordered'
      }

      return {
        orderId:       first.orderId,
        userId:        first.userId,
        totalAmount:   first.totalAmount,
        deliveryFee:   first.deliveryFee,
        currentStatus,
        paymentMethod: first.paymentMethod,
        paymentStatus: first.paymentStatus,
        order: {
          createdAt:    first.orderCreatedAt,
          updatedAt:    first.orderUpdatedAt,
          totalAmount:  first.totalAmount,
          pointsUsed:   first.pointsUsed || 0,
          shippingInfo: first.shippingInfo || {},
        },
        items: rows
          .filter(row => row.orderItemId)
          .map(row => ({
            id:                row.orderItemId,
            productId:         row.productId,
            quantity:          row.quantity,
            priceAtOrder:      row.itemPrice,
            productName:       row.productName,
            productPrice:      row.productPrice,
            productImagePaths: row.productImagePaths,
            variant:           row.variant,
            currentStatus:     row.itemCurrentStatus || 'ordered',
            statusHistories:   row.itemStatusHistories || [],
            createdAt:         row.itemCreatedAt,
          })),
      }
    }

    if (isOrderId) {
      // Single order response (same shape as before — no breaking change)
      return res.status(200).json(buildOrder(result.rows))
    }

    // Phone lookup — group rows by orderId, return array of orders
    const grouped = {}
    for (const row of result.rows) {
      if (!grouped[row.orderId]) grouped[row.orderId] = []
      grouped[row.orderId].push(row)
    }

    const orders = Object.values(grouped).map(buildOrder)

    // If only one order found, still return array so frontend handles it uniformly
    return res.status(200).json(orders)

  } catch (error) {
    console.error('Error fetching order:', error)
    res.status(500).json({ message: 'Error fetching order details', error: error.message })
  }
})

router.post('/1464/orders/cancel/:orderId', authenticateFirebaseToken, async (req, res) => {
    console.log("======1464 Cancel Order ======");
    const { orderId } = req.params;
    const { status } = req.body;
    console.log("status", status);
    console.log("orderId", orderId);
    
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
            UPDATE "1464_orders"
            SET "statusHistories" = "statusHistories" || $1::jsonb
            WHERE "orderId" = $2
        `;
        
        await client.query(updateOrderQuery, [JSON.stringify([newStatusHistory]), orderId]);
        
        // 2. Get all product IDs from order_items for this order
        const getOrderItemsQuery = `
            SELECT "productId" FROM "1464_order_items"
            WHERE "orderId" = $1
        `;
        
        const orderItemsResult = await client.query(getOrderItemsQuery, [orderId]);
        const productIds = orderItemsResult.rows.map(row => row.productId);
        
        // 3. Update each product's status in order_items
        if (productIds.length > 0) {
            const updateOrderItemsQuery = `
                UPDATE "1464_order_items"
                SET "statusHistories" = "statusHistories" || $1::jsonb,
                    "currentStatus" = 'cancelled'
                WHERE "orderId" = $2
            `;
            
            await client.query(updateOrderItemsQuery, [JSON.stringify([newStatusHistory]), orderId]);
            
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


router.get("/1464/dashboard/orders/:status?", authenticateFirebaseToken, async (req, res) => {
    console.log("==========33 Orders Route Hit==========");
    const userId = req.user.uid;
    const status = req.params.status;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    console.log("status", status)
    console.log("userId", userId)

    const productIdQuery = `
    SELECT id FROM "33products"
    WHERE "postedBy" = $1
    `;
    const productIdResult = await zingoPool.query(productIdQuery, [userId]);
    const productIds = productIdResult.rows.map(product => product.id);

    if (productIds.length > 0) {
        let orderItemsQuery = `
            SELECT oi.*, 
            p."productName", 
            p."productCategory",
            p."productPrice", 
            p."productDescription", 
            p."productImagePaths", 
            p."slug", 
            p."productCondition", 
            p."productStockStatus",
            p."productBrand",
            o."shippingInfo",
            o."paymentMethod",
            o."paymentStatus",
            o."deliveryMethod",
            o."deliveryFee"
        FROM "33orderItems" oi
        LEFT JOIN "33products" p ON oi."productId" = p.id
        LEFT JOIN "33orders" o ON oi."orderId" = o."orderId"
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
                    orderItemsQuery += ` AND oi."currentStatus" = 'preparing-for-delivery'`;
                    break;
                case 'out-for-delivery':
                    orderItemsQuery += ` AND oi."currentStatus" = 'out-for-delivery'`;
                    break;
                case 'delivered':
                    orderItemsQuery += ` AND oi."currentStatus" = 'delivered'`;
                    break;
                case 'store-picked-up':
                    orderItemsQuery += ` AND oi."currentStatus" = 'store-picked-up'`;
                    break;
                case 'cancelled':
                    orderItemsQuery += ` AND oi."currentStatus" = 'cancelled'`;
                    break;
                case 'refund':
                    orderItemsQuery += ` AND oi."currentStatus" = 'pendingRefund'`;
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

router.post('/1464/order/refund/:orderId', authenticateFirebaseToken, async(req, res) => {
    console.log9("==========1464 Refund Order Route Hit =========="); 
    console.log9("req params", req.params);
})

router.post('/orders/status/update/delivered',  authenticateFirebaseToken, async(req, res) => {
    console.log('/order/state/update/delivered route hit') 
    console.log('req body', req.body)
    const {orderId,updateOrderStatus} = req.body;
    console.log('updateOrderStatus', updateOrderStatus, typeof(updateOrderStatus))
    
    if (!["delivered", "ordered", "delivering"].includes(updateOrderStatus)) {
        return res.status(400).json({ error: "Update Order State can only be 'delivered', 'ordered', or 'delivering'." });
    }
  
    
    try {
        console.log(req.body)
        const updateStatusQuery = `
            UPDATE orders
            SET "currentStatus" = $1,
                "deliveredTime" = NOW ()
            WHERE "orderId" = $2
        `;
        const values = [updateOrderStatus, orderId]
        const updateStatusResult = await zingoPool.query(updateStatusQuery, values)
        
        if (updateStatusResult.rowCount === 0) {
            return res.status(404).json({error: "Unable to update order status" })
        }
        res.status(200).json({message: "Update status successfully"})
    } catch (err) {
        console.error(`Error with assigning driver`, err);
        res.status(500).json({ message: 'Error with assigning driver' });
    }
})






module.exports = router