const express = require("express");
const router = express.Router();
const zingoPool = require("../database/pgZingo");
const authenticateFirebaseToken = require("../auth/authFirebaseToken");
const { 
    extractAndValidateRequestData, 
    createOrder,
    createOrderItems,
    updateProductStatus, 
    sendEmailVerificationToBuyer} 
    = require("../helper/orderRoutesHelper");

const {generateOrderId} = require("../utils/generateOrderId");
const { sendOrderConfirmationEmail } = require("../lib/email");
const {sendEmailWithRetry} = require("../lib/sendEmailWithRetry");

require('dotenv').config();
const ADMIN_USER_ID = process.env.ADMIN_ID


//--------------------------Route to create order ------------------------
router.post('/order/create', authenticateFirebaseToken, async(req, res) => {
    /* 
    orderStatus can only be 'ordered', 'delivery', 'delivered', 'deleted'
    */
    console.log('/order/create route hit')
    const client = await zingoPool.connect()
    const userId = req.user.id

    try {
        await client.query("BEGIN")
        // Checking and validating the form submitted
        const { orderDetails, validationError } = extractAndValidateRequestData(req, userId);

        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        // Create order in orders table
        const orderResult = await createOrder(client, orderDetails)
        if (!orderResult) {
            return res.status(404).json({ error: "Error inserting order to orders table"});
        }
        console.log('Order Result Complete')
        // console.log('Order Result', orderResult.rows[0])
        // console.log('Order Result orderId:', orderResult.rows[0].orderID)
      
        const createOrderItemsResult = await createOrderItems(client, orderResult.rows[0].orderId, orderDetails)
        if (!createOrderItemsResult) {
            return res.status(404).json({ error: "Error inserting order to order in order_items"});

        }
        console.log('Order Items Complete')
        // console.log('orderDetails.items', orderDetails)
        // const updateProductSuccess = await updateProductStatus(client, orderDetails)
        // if (!updateProductSuccess) {
        //     return res.status(404).json({ error: "Error updating product in database" });
        // }
        // console.log('Update Product Complete')

      

        await client.query('COMMIT');

          // Handle email sending separately
          try {
            const emailResult = await sendEmailWithRetry(orderResult, orderDetails, userId);
            if (emailResult.success) {
                console.log('Email verification sent successfully');
            } else {
                console.error('Failed to send email verification:', emailResult.error);
            }
        } catch (emailError) {
            console.error('Critical error in email verification:', emailError);
        }

       console.log("Order added Succesfully");
        return res.status(200).json({
            message: "Order added successfully",
            orderId: orderResult.rows[0].orderId,
            order: orderResult.rows[0],
            orderItems: orderResult.rows[0],
            // emailSent: emailResult.success
        });

    } catch (error) {
        // If anything fails, roll back the transaction
        await client.query('ROLLBACK');
       
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : "An unexpected error occurred";

        return res.status(statusCode).json({
            success:false,
            error: message
        })
    } finally {
        // Always release the client back to the pool
        client.release();
    }
});

router.get('/order/:orderId/receipt-image', authenticateFirebaseToken, async(req, res) => {
    console.log('/order/:orderId/receipt-image route hit');
    const {orderId} = req.params;
    const id = parseInt(orderId);
    const userId = req.user.id;
    
    try {
      // Reuse the same query from your order confirmation route
      const query = `
      SELECT 
          o."id", o."userId", o."currentStatus", o."totalAmount", o."buyerPhoneNumber", o."paymentMethod", 
          o."statusHistories" as "ordersStatusHistories",
          o."buyerAddress", o."buyerCity", o."buyerFirstName", o."buyerLastName", o."assignedDriver", o."assignedTime",
          o."deliveredTime", o."createdAt", o."orderId", o."pointsUsed", o."pointsDiscount", o."deliveryFee",
          oi."purchasedQuantity" as "orderedQuantity",
          oi."productPrice" as "priceAtOrder",
          oi."statusHistories" as "orderItemsStatusHistories",
          p."productName", p."productCategory",
          p."phoneNumber" as "sellerPhone", p."productImagePaths",
          p."sellerAddress",
          p."sellerCity",
          p."productCondition",
          p."productBrand",
          p."productDescription"
      FROM "orders" o
      LEFT JOIN "order_items" oi ON o."orderId" = oi."orderId"
      LEFT JOIN "products" p ON oi."productId" = p."id"
      WHERE o."orderId" = $1;
      `;
      
      const result = await zingoPool.query(query, [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          message: "Order not found"
        });
      }
      
      // Check if user is authorized to access this order
      if (result.rows[0].userId !== userId && userId !== ADMIN_USER_ID) {
        return res.status(403).json({
          message: "Unauthorized access to order"
        });
      }
      
      const orderInfo = {
        id: result.rows[0].id,
        orderId: result.rows[0].orderId,
        userId: result.rows[0].userId,
        currentStatus: result.rows[0].currentStatus,
        ordersStatusHistories: result.rows[0].ordersStatusHistories,
        totalAmount: parseFloat(result.rows[0].totalAmount),
        buyerPhoneNumber: result.rows[0].buyerPhoneNumber,
        buyerAddress: result.rows[0].buyerAddress,
        buyerCity: result.rows[0].buyerCity,
        buyerFirstName: result.rows[0].buyerFirstName,
        buyerLastName: result.rows[0].buyerLastName,
        assignedDriver: result.rows[0].assignedDriver,
        assignedTime: result.rows[0].assignedTime,
        deliveredTime: result.rows[0].deliveredTime,
        pointsUsed: result.rows[0].pointsUsed,
        pointsDiscount: parseFloat(result.rows[0].pointsDiscount) || 0.00,
        deliveryFee: parseFloat(result.rows[0].deliveryFee) || 0.00,
        createdAt: result.rows[0].createdAt,
        paymentMethod: result.rows[0].paymentMethod
      };
      
      const items = result.rows.map(row => ({
        productName: row.productName,
        quantity: row.orderedQuantity,
        priceAtOrder: row.priceAtOrder
      }));
      
    //   // Generate the receipt image
    //   const imageBuffer = await generateReceiptImage(orderInfo, items);
      
    //   // Set response headers for image download
    //   res.setHeader('Content-Type', 'image/png');
    //   res.setHeader('Content-Disposition', `attachment; filename=receipt-${orderInfo.orderId}.png`);
      
    //   // Send the image buffer
    //   res.send(imageBuffer);
      
    } catch (error) {
      console.error('Error generating receipt image:', error);
      res.status(500).json({
        message: "Error generating receipt image",
        error: error.message
      });
    }
  });


  router.get('/order/:orderId/guest/:guestUSerId/receipt-image', async(req, res) => {
    console.log('/order/:orderId/receipt-image route hit');
    const {orderId, guestUserId} = req.params;
    const id = parseInt(orderId);
    
    try {
        const getUserIdFromGuestUserIdQuery = `
            SELECT id
                FROM users
            WHERE "guestUserId" = $1 
            `;
            const getUserIdResult = await zingoPool.query(getUserIdFromGuestUserIdQuery, [guestUserId]);
            
            if (getUserIdResult.rows.length === 0) {
            return res.status(404).json({ message: "Guest user not found" });
            }
            
            const userId = getUserIdResult.rows[0].id;

      const query = `
      SELECT 
          o."id", o."userId", o."currentStatus", o."totalAmount", o."buyerPhoneNumber", o."paymentMethod", 
          o."statusHistories" as "ordersStatusHistories",
          o."buyerAddress", o."buyerCity", o."buyerFirstName", o."buyerLastName", o."assignedDriver", o."assignedTime",
          o."deliveredTime", o."createdAt", o."orderId", o."pointsUsed", o."pointsDiscount", o."deliveryFee",
          oi."purchasedQuantity" as "orderedQuantity",
          oi."productPrice" as "priceAtOrder",
          oi."statusHistories" as "orderItemsStatusHistories",
          p."productName", p."productCategory",
          p."phoneNumber" as "sellerPhone", p."productImagePaths",
          p."sellerAddress",
          p."sellerCity",
          p."productCondition",
          p."productBrand",
          p."productDescription"
      FROM "orders" o
      LEFT JOIN "order_items" oi ON o."orderId" = oi."orderId"
      LEFT JOIN "products" p ON oi."productId" = p."id"
      WHERE o."orderId" = $1;
      `;
      
      const result = await zingoPool.query(query, [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          message: "Order not found"
        });
      }
      
      // Check if user is authorized to access this order
      if (result.rows[0].userId !== userId && userId !== ADMIN_USER_ID) {
        return res.status(403).json({
          message: "Unauthorized access to order"
        });
      }
      
      const orderInfo = {
        id: result.rows[0].id,
        orderId: result.rows[0].orderId,
        userId: result.rows[0].userId,
        currentStatus: result.rows[0].currentStatus,
        ordersStatusHistories: result.rows[0].ordersStatusHistories,
        totalAmount: parseFloat(result.rows[0].totalAmount),
        buyerPhoneNumber: result.rows[0].buyerPhoneNumber,
        buyerAddress: result.rows[0].buyerAddress,
        buyerCity: result.rows[0].buyerCity,
        buyerFirstName: result.rows[0].buyerFirstName,
        buyerLastName: result.rows[0].buyerLastName,
        assignedDriver: result.rows[0].assignedDriver,
        assignedTime: result.rows[0].assignedTime,
        deliveredTime: result.rows[0].deliveredTime,
        pointsUsed: result.rows[0].pointsUsed,
        pointsDiscount: parseFloat(result.rows[0].pointsDiscount) || 0.00,
        deliveryFee: parseFloat(result.rows[0].deliveryFee) || 0.00,
        createdAt: result.rows[0].createdAt,
        paymentMethod: result.rows[0].paymentMethod
      };
      
      const items = result.rows.map(row => ({
        productName: row.productName,
        quantity: row.orderedQuantity,
        priceAtOrder: row.priceAtOrder
      }));
      
    //   // Generate the receipt image
    //   const imageBuffer = await generateReceiptImage(orderInfo, items);
      
    //   // Set response headers for image download
    //   res.setHeader('Content-Type', 'image/png');
    //   res.setHeader('Content-Disposition', `attachment; filename=receipt-${orderInfo.orderId}.png`);
      
    //   // Send the image buffer
    //   res.send(imageBuffer);
      
    } catch (error) {
      console.error('Error generating receipt image:', error);
      res.status(500).json({
        message: "Error generating receipt image",
        error: error.message
      });
    }
  });
//-------------------------Route to confirm GUEST order---------------------------------
router.get('/order/:orderId/guest/:guestUserId', async(req, res) => {
    console.log('===guest /orders/:orderId route hit===')
    console.log('req params', req.params)
    const {orderId, guestUserId} = req.params
    const _orderId = parseInt(orderId) // convert orderId from string that was sent from the server to Int

    console.log('====================Confirm Guest Order====================')
    console.log('orderId:', _orderId, "orderId Type", typeof(_orderId))
    console.log("guestUserId", guestUserId)
    try {

        const getUserIdFromGuestUserIdQuery = `
        SELECT id
            FROM users
        WHERE "guestUserId" = $1 
        `
        const getUserIdResult = await zingoPool.query(getUserIdFromGuestUserIdQuery, [guestUserId])
        // console.log("getUserId", getUserIdResult)
        const userId = getUserIdResult.rows[0].id
        console.log("userId", userId)

        const query = `
        SELECT 
            o."id", o."userId", o."currentStatus", o."totalAmount", o."buyerPhoneNumber", o."paymentMethod", 
            o."statusHistories" as "ordersStatusHistories",
            o."buyerAddress", o."buyerCity", o."buyerFirstName", o."buyerLastName", o."assignedDriver", o."assignedTime",
            o."deliveredTime", o."createdAt", o."orderId", o."pointsUsed", o."pointsDiscount", o."deliveryFee",
            oi."purchasedQuantity" as "orderedQuantity",
            oi."productPrice" as "priceAtOrder",
            oi."statusHistories" as "orderItemsStatusHistories",
            p."productName", p."productCategory",
            p."phoneNumber" as "sellerPhone", p."productImagePaths",
            p."sellerAddress",
            p."sellerCity",
            p."productCondition",
            p."productBrand",
            p."productDescription"
        FROM "orders" o
        LEFT JOIN "order_items" oi ON o."orderId" = oi."orderId"
        LEFT JOIN "products" p ON oi."productId" = p."id"
        WHERE o."orderId" = $1;

        `
        const result = await zingoPool.query(query, [_orderId]);
        console.log("result", result.rows)

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "No order confirmation found",
                order: null,
                items: [],
                
            });
        }   

        console.log("result in guest confirmation", result.rows);

        const orderInfo = {
            id: result.rows[0].id,
            orderId: result.rows[0].orderId,
            userId: result.rows[0].userId,
            currentStatus: result.rows[0].currentStatus,
            ordersStatusHistories: result.rows[0].ordersStatusHistories,
            totalAmount: parseFloat(result.rows[0].totalAmount),
            buyerPhoneNumber: result.rows[0].buyerPhoneNumber,
            buyerAddress: result.rows[0].buyerAddress,
            buyerCity: result.rows[0].buyerCity,
            buyerFirstName: result.rows[0].buyerFirstName,
            buyerLastName: result.rows[0].buyerLastName,
            assignedDriver: result.rows[0].assignedDriver,
            assignedTime: result.rows[0].assignedTime,
            deliveredTime: result.rows[0].deliveredTime,
            pointsUsed: result.rows[0].pointsUsed,
            pointsDiscount: parseFloat(result.rows[0].pointsDiscount) || 0.00,
            deliveryFee: parseFloat(result.rows[0].deliveryFee) || 0.00,
            createdAt: result.rows[0].createdAt
        };

       

        // Each row represents an item in the order
        const items = result.rows.map(row => ({
            orderItemsStatusHistories: row.orderItemsStatusHistories,
            quantity: row.orderedQuantity,
            priceAtOrder: row.priceAtOrder,
            productImagePaths: row.productImagePaths,
            productName: row.productName,
            productCategory: row.productCategory,
            sellerPhone: row.sellerPhone,
            sellerAddress: row.sellerAddress,
            sellerCity: row.sellerCity,
            productCondition: row.productCondition,
            productDescription: row.productDescription
        }));
        console.log('items', items)
        console.log('order', orderInfo)
        res.status(200).json({
            order: orderInfo,
            isOwner: true,
            items: items,
            paymentMethod: result.rows[0].paymentMethod
        });

          // Generate the receipt image
    //   const imageBuffer = await generateReceiptImage(orderInfo, items);
      
    //   // Set response headers for image download
    //   res.setHeader('Content-Type', 'image/png');
    //   res.setHeader('Content-Disposition', `attachment; filename=receipt-${orderInfo.orderId}.png`);
      
    //   // Send the image buffer
    //   res.send(imageBuffer);



    } catch(error) {
        console.error(`Error with fetching confirmation product information`)
    }
})


//-------------------------Route to confirm order---------------------------------

router.get('/order/:orderId', authenticateFirebaseToken, async(req,res) => {
    console.log('====================Confirm Order====================')
    console.log('/orders/:orderId route hit')
    console.log('req params', req.params)
    const {orderId} = req.params
    const id = parseInt(orderId) // convert orderId from string that was sent from the server to Int
    const userId = req.user.id

    console.log('orderId:', id, "orderId Type", typeof(id))

    try {
        const ownershipQuery = `
            SELECT "userId"
                FROM "orders"
                WHERE "orderId" = $1
                LIMIT 1;
        `
   
        const ownershipCheck = await zingoPool.query(ownershipQuery, [id])
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
            o."statusHistories" as "ordersStatusHistories",
            o."buyerAddress", o."buyerCity", o."buyerFirstName", o."buyerLastName", o."assignedDriver", o."assignedTime",
            o."deliveredTime", o."createdAt", o."orderId", o."pointsUsed", o."pointsDiscount", o."deliveryFee",
            oi."purchasedQuantity" as "orderedQuantity",
            oi."productPrice" as "priceAtOrder",
            oi."statusHistories" as "orderItemsStatusHistories",
            p."productName", p."productCategory",
            p."phoneNumber" as "sellerPhone", p."productImagePaths",
            p."sellerAddress",
            p."sellerCity",
            p."productCondition",
            p."productBrand",
            p."productDescription"
        FROM "orders" o
        LEFT JOIN "order_items" oi ON o."orderId" = oi."orderId"
        LEFT JOIN "products" p ON oi."productId" = p."id"
        WHERE o."orderId" = $1;

        `
        const result = await zingoPool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "No order confirmation found",
                order: null,
                items: [],
                
            });
        }   

        console.log("result", result.rows);

        const orderInfo = {
            id: result.rows[0].id,
            orderId: result.rows[0].orderId,
            userId: result.rows[0].userId,
            currentStatus: result.rows[0].currentStatus,
            ordersStatusHistories: result.rows[0].ordersStatusHistories,
            totalAmount: parseFloat(result.rows[0].totalAmount),
            buyerPhoneNumber: result.rows[0].buyerPhoneNumber,
            buyerAddress: result.rows[0].buyerAddress,
            buyerCity: result.rows[0].buyerCity,
            buyerFirstName: result.rows[0].buyerFirstName,
            buyerLastName: result.rows[0].buyerLastName,
            assignedDriver: result.rows[0].assignedDriver,
            assignedTime: result.rows[0].assignedTime,
            deliveredTime: result.rows[0].deliveredTime,
            pointsUsed: result.rows[0].pointsUsed,
            pointsDiscount: parseFloat(result.rows[0].pointsDiscount) || 0.00,
            deliveryFee: parseFloat(result.rows[0].deliveryFee) || 0.00,
            createdAt: result.rows[0].createdAt
        };

       

        // Each row represents an item in the order
        const items = result.rows.map(row => ({
            orderItemsStatusHistories: row.orderItemsStatusHistories,
            quantity: row.orderedQuantity,
            priceAtOrder: row.priceAtOrder,
            productImagePaths: row.productImagePaths,
            productName: row.productName,
            productCategory: row.productCategory,
            sellerPhone: row.sellerPhone,
            sellerAddress: row.sellerAddress,
            sellerCity: row.sellerCity,
            productCondition: row.productCondition,
            productDescription: row.productDescription
        }));
        console.log('items', items)
        console.log('order', orderInfo)
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



//----------------------Route to fetch users order --------------------------
router.get('/orders', authenticateFirebaseToken, async (req, res) => {
    console.log('==========orders route hit==========')
    const userId = req.user.id
    const page = parseInt(req.query.page) || 1
    const limit = 5  // 10 posts per page
    const offset = (page - 1) * limit
    console.log('userId:', userId, "userId Type", typeof(userId), 'page', page)
    

    try {
        // First, get total count of orders
        const countQuery = `
            SELECT COUNT(DISTINCT o.id) 
            FROM "orders" o 
            WHERE o."userId" = $1
        `
        const countResult = await zingoPool.query(countQuery, [userId])
        const totalOrders = parseInt(countResult.rows[0].count)

        // Then get paginated orders
        const query = `
        SELECT 
            o."id",
            o."orderId",
            o."userId",
            o."currentStatus",
            o."totalAmount",
            o."buyerPhoneNumber",
            o."paymentMethod",
            o."buyerAddress",
            o."buyerCity",
            o."buyerFirstName",
            o."buyerLastName",
            o."assignedDriver",
            o."assignedTime",
            o."deliveredTime",
            o."createdAt",
            oi."purchasedQuantity" as "orderedQuantity",
            oi."productPrice" as "priceAtOrder",
            oi."productId",
            p."productName",
            p."productCategory",
            p."productImagePaths",
            p."phoneNumber" as "sellerPhone",
            p."sellerAddress",
            p."sellerCity",
            p."productCondition",
            p."productDescription"
        FROM "orders" o
        LEFT JOIN "order_items" oi ON o."orderId" = oi."orderId"
        LEFT JOIN "products" p ON oi."productId" = p."id"
        WHERE o."userId" = $1
        ORDER BY o."createdAt" DESC
        LIMIT $2 OFFSET $3;
        `
        const result = await zingoPool.query(query, [userId, limit, offset])
    
        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "No order confirmation found",
                order: null,
                items: [],
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(totalOrders / limit),
                    totalOrders,
                    ordersPerPage: limit
                }
            });
        }

        // Create a map to group orders by order ID
        const ordersMap = new Map();

        result.rows.forEach(row => {
            if (!ordersMap.has(row.id)) {
                ordersMap.set(row.id, {
                    id: row.id,
                    orderId: row.orderId,
                    userId: row.userId,
                    currentStatus: row.currentStatus,
                    totalAmount: row.totalAmount,
                    buyerPhoneNumber: row.buyerPhoneNumber,
                    paymentMethod: row.paymentMethod,
                    buyerAddress: row.buyerAddress,
                    buyerCity: row.buyerCity,
                    buyerFirstName: row.buyerFirstName,
                    buyerLastName: row.buyerLastName,
                    assignedDriver: row.assignedDriver,
                    assignedTime: row.assignedTime,
                    deliveredTime: row.deliveredTime,
                    createdAt: row.createdAt,
                    items: []
                });
            }

            const order = ordersMap.get(row.id);
            order.items.push({
                productName: row.productName,
                productCategory: row.productCategory,
                sellerPhone: row.sellerPhone,
                sellerAddress: row.sellerAddress,
                sellerCity: row.sellerCity,
                productCondition: row.productCondition,
                productDescription: row.productDescription,
                orderedQuantity: row.orderedQuantity,
                productImagePaths: row.productImagePaths,
                priceAtOrder: row.priceAtOrder,
                productId: row.productId
            });
        });

        const orders = Array.from(ordersMap.values());

        // console.log("orders", orders)

        res.status(200).json({
            message: "Orders retrieved successfully",
            orders: orders,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalOrders / limit),
                totalOrders,
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


//---------------------------Route to get all orders -----------------------------This is just the duplicate but without the userId
router.get('/all-orders/admin', authenticateFirebaseToken, async(req,res) => {
    console.log('all-orders/admin route hit')
    const userId = req.user.id
    // console.log(`userId:${userId}, adminUserId:${ADMIN_USER_ID}`)

    if (userId != ADMIN_USER_ID) {
        console.error(`This route is only accessible to admin`)
        return res.status(403).json({ error: "This route is only accessible to admin" });
    } else {
        console.log('is Admin true')
    }

    try {
        const query = `
        SELECT 
            o."id",
            o."userId",
            o."currentStatus",
            o."totalAmount",
            o."buyerPhoneNumber",
            o."paymentMethod",
            o."buyerAddress",
            o."buyerCity",
            o."buyerFirstName",
            o."buyerLastName",
            o."assignedDriver",
            o."assignedTime",
            o."deliveredTime",
            o."paymentComplete",
            o."createdAt",
            oi."purchasedQuantity" as "orderedQuantity",
            oi."productPrice" as "priceAtOrder",
            p."productName",
            p."productCategory",
            p."phoneNumber" as "sellerPhone",
            p."sellerAddress",
            p."sellerCity",
            p."productCondition",
            p."productDescription",
            p."productImagePaths"
          
        FROM "orders" o
        LEFT JOIN "order_items" oi ON o."id" = oi."orderId"
        LEFT JOIN "products" p ON oi."productId" = p."id"
        `

        const result = await zingoPool.query(query)

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "No order confirmation found",
                order: null,
                items: []
            });
        }

          // Create a map to group orders by order ID
        const ordersMap = new Map();

        result.rows.forEach(row => {
            if (!ordersMap.has(row.id)) {
                // Create new order object with base order information
                ordersMap.set(row.id, {
                    id: row.id,
                    userId: row.userId,
                    currentStatus: row.currentStatus,
                    totalAmount: row.totalAmount,
                    buyerPhoneNumber: row.buyerPhoneNumber,
                    paymentMethod: row.paymentMethod,
                    buyerAddress: row.buyerAddress,
                    buyerCity: row.buyerCity,
                    buyerFirstName: row.buyerFirstName,
                    buyerLastName: row.buyerLastName,
                    assignedDriver: row.assignedDriver,
                    assignedTime: row.assignedTime,
                    deliveredTime: row.deliveredTime,
                    createdAt: row.createdAt,
                    paymentComplete: row.paymentComplete,
                    items: [] // Array to hold order items
                });
            }

            // Add order item to the order
            const order = ordersMap.get(row.id);
            order.items.push({
                productName: row.productName,
                productCategory: row.productCategory,
                sellerPhone: row.sellerPhone,
                sellerAddress: row.sellerAddress,
                sellerCity: row.sellerCity,
                productCondition: row.productCondition,
                productDescription: row.productDescription,
                orderedQuantity: row.orderedQuantity,
                productImagePaths: row.productImagePaths,
                priceAtOrder: row.priceAtOrder
            });
        });

        // Convert the orders map to an array
        const products = Array.from(ordersMap.values());

        res.status(200).json({
            message: "Orders retrieved successfully",
            orders: products
        });


    } catch (error) {
        console.error(`Error with fetching all active orders`)
    }
})




module.exports = router