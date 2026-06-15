const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const {upload, uploadFileToS3, deleteFileFromS3, uploadMediaFilesToS3} = require("../../database/s3")
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateAndUpdateProductTags } = require("../../helper/productRoutesHelper/addTagHelper");
const createRateLimiterMiddleware = require("../rateLimiter");
const { sanitizeProductDescription } = require("../../utils/sanatizeHtml");
const { sanitizeFileName } = require("../../utils/sanitzieFileName");
const path = require('path');
const fs = require('fs');

router.post('/cart/add', authenticateFirebaseToken, async(req, res) => {
    console.log('=====33 add to cart route hit=====')
    const logPrefix = '[Cart/Add]';
     const userId = req.user?.uid || req.user?.user_id;
    const { productId, purchasedQuantity = 1, variantId, selectedColor, selectedSize, variantPrice, action } = req.body;

    console.log(`${logPrefix} Request body:`, req.body);
    console.log(`${logPrefix} userId: ${userId}`);

    const client = await zingoPool.connect();
    try {
        await client.query('BEGIN');

        // Check if the cart exists for the user
        const cartResult = await client.query(`
            SELECT id FROM "33carts" WHERE "userId" = $1
        `, [userId]);

        let cartId;
        if (cartResult.rows.length === 0) {
            const newCartResult = await client.query(`
                INSERT INTO "33carts" ("userId") VALUES ($1) RETURNING id
            `, [userId]);
            cartId = newCartResult.rows[0].id;
        } else {
            cartId = cartResult.rows[0].id;
        }

        // Insert the item into 33cartItems
const result = await client.query(`
    INSERT INTO "33cartItems" ("cartId", "productId", "purchasedQuantity", "selectedColor", "selectedSize")
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT ("cartId", "productId", "selectedColor", "selectedSize") DO UPDATE
    SET "purchasedQuantity" = "33cartItems"."purchasedQuantity" + EXCLUDED."purchasedQuantity",
        "updatedAt" = CURRENT_TIMESTAMP
`, [cartId, productId, purchasedQuantity, selectedColor || null, selectedSize || null]);

        console.log(`${logPrefix} Insert/Update result:`, result.rowCount);

        await client.query('COMMIT');
        res.status(200).json({ message: "Item added to cart successfully" });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`${logPrefix} Error:`, error);
        res.status(500).json({ error: 'Failed to add item to cart' });
    } finally {
        client.release();
    }
});

router.post('/33/cart/remove', authenticateFirebaseToken, async (req,res) => {
    /**
    * This route requires productId and cartId. 
    */
    const userId = req.user?.uid || req.user?.user_id;
    console.log('deleting item from cart route hit');
    console.log('req body of deleting', req.body)
    console.log("userId", userId)

    const {cartItemsId} = req.body
    // console.log(`productId:${cartId}, type: ${(typeof(cartId))}`)


    if (!cartItemsId) {
        console.error('Product ID is missing');
        return res.status(400).json({ error: 'Product ID is missing' });
      }
      

    const  client = await zingoPool.connect();
    try {
        await client.query('BEGIN')
        // deletion 
        const deleteQuery = `
            DELETE FROM "33cartItems"
            WHERE "id" = $1
        `
        const result = await client.query(deleteQuery, [cartItemsId]);
        console.log('Query:', {
            text: deleteQuery,
            values: [cartItemsId]
        });

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Cart item not found' })
          }

        const getCartItemsQuery = `
          SELECT * FROM "33cartItems"
          WHERE "cartId" = $1
        `;
        const updatedCartItems = await client.query(getCartItemsQuery, [cartItemsId]);

        await client.query('COMMIT');


        res.status(200).json({ message: "Item removed from cart successfully",items: updatedCartItems.rows });
    } catch (error) {
        // Rollback the transaction in case of error
        await client.query('ROLLBACK');
        console.error('Error deleting cart item:', error)
        res.status(500).json({ error: 'Failed to delete cart item' });
    } finally {
        client.release()
    }
}) 

router.get('/cart/get', authenticateFirebaseToken, async(req,res) => {
    console.log('=====33student get cart route hit=====')
    const userId = req.user?.uid || req.user?.user_id;

    console.log('user id', userId)
    // console.log('user id from params', req.params)
    let client;
    try {
        client = await zingoPool.connect()


     const cartItems = await client.query(
    `
    SELECT
        c.id as "cartId",
        ci.id as "id",
        ci."selectedSize",
        ci."selectedColor",
        p.id as "productId",
        p."productName",
        p."productDescription",
        p."isSold",
        ci."purchasedQuantity",
        p."slug",
        p."productImagePaths"[0] as "productImage",
        (variant->>'productPrice')::numeric AS "productPrice",
        (variant->>'discountedPrice')::numeric AS "discountedPrice",
        (variant->>'discountPercentage')::numeric AS "discountPercentage",
        p."productBrand",
        p."isStorePickUpOnly"

    FROM "33carts" c
    JOIN "33cartItems" ci ON c.id = ci."cartId"
    JOIN "33products" p ON ci."productId" = p.id
    LEFT JOIN LATERAL (
        SELECT value AS variant
        FROM jsonb_array_elements(p."productVariants")
        WHERE value->>'color' = ci."selectedColor"
          AND value->>'size' = ci."selectedSize"
        LIMIT 1
    ) v ON true
    WHERE c."userId" = $1
    ORDER BY ci."createdAt" DESC
    `,
    [userId]
)
       

        res.status(200).json({
            cartId: cartItems.rows.cartId,
            items: cartItems.rows
        });
    } catch (error) {
        console.error('Error fetching cart items:', error);
        res.status(500).json({
            error: 'Failed to fetch cart items'
            
        });
    } finally {
        if (client) {
            client.release();
        }
    }
})

router.post('/33/cart/clear' , authenticateFirebaseToken, async(req,res) => {
    console.log('1464/cart/clear route hit')
    const userId = req.user?.uid || req.user?.user_id;
    console.log('userId', userId, typeof(userId))
    try {
        const query = `
            DELETE FROM "33carts"
            WHERE "userId" = $1
        `
        const deleteCartResult = await zingoPool.query(query, [userId])
        // console.log('deleteCartResult', deleteCartResult)
        
        if (deleteCartResult.rowsCount === 0) {
            return res.status(500).json({
                message: "Error with clearing cart"
            });
        }
        res.status(200).json({ message: "Successfully clear cart items" });
    } catch (err) {
        console.error(`Error with clearing cart ${err}`)
    }
})



module.exports = router