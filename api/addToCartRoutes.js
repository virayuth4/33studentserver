const express = require("express");
const router = express.Router();
const zingoPool = require("../database/pgZingo");
const authenticateFirebaseToken = require("../auth/authFirebaseToken")
const winston = require('winston');
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

const debug = process.env.NODE_ENV === 'development';
const log = (message, data) => {
    if (debug) {
        console.log(`${logPrefix} ${message}`, data || '');
    }
};

router.post('/cart/add', authenticateFirebaseToken, async(req, res) => {
    const logPrefix = '[Cart/Add]';
    const userId = req.user.id;
    const { productId, purchasedQuantity } = req.body;

    console.log(`${logPrefix} Request body:`, req.body); // Log the request body
    console.log(`${logPrefix} userId: ${userId}`);

    const client = await zingoPool.connect();
    try {
        await client.query('BEGIN');

        // Check if the cart exists for the user
        const cartResult = await client.query(`
            SELECT id FROM carts WHERE "userId" = $1
        `, [userId]);

        let cartId;
        if (cartResult.rows.length === 0) {
            // Create a new cart if it doesn't exist
            const newCartResult = await client.query(`
                INSERT INTO carts ("userId") VALUES ($1) RETURNING id
            `, [userId]);
            cartId = newCartResult.rows[0].id;
        } else {
            cartId = cartResult.rows[0].id;
        }

        // Insert the item into cart_items directly
        const result = await client.query(`
            INSERT INTO cart_items ("cartId", "productId", "purchasedQuantity",)
            VALUES ($1, $2, $3)
            ON CONFLICT ("cartId", "productId") DO UPDATE
            SET "purchasedQuantity" = cart_items."purchasedQuantity" + EXCLUDED."purchasedQuantity",
                "updatedAt" = CURRENT_TIMESTAMP
        `, [cartId, productId, purchasedQuantity]);

        console.log(`${logPrefix} Insert/Update result:`, result); // Log the result of the query

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



//Router to get the cart items
router.get('/cart', authenticateFirebaseToken, async(req,res) => {
    console.log('get cart route hit')
    console.log('user id', req.user.id)
    console.log('user id from params', req.params)
    let client;
    try {
        client = await zingoPool.connect()
        const userId = req.user.id;

        const cartItems = await client.query(
            `
            SELECT
                c.id as "cartId",
                ci.id as "id",
                p.id as "productId",
                p."productName",
                p."productDescription",
                p."productPrice",
                p."discountedPrice",
                p."isSold",
                p."soldAt",
                ci."purchasedQuantity",
                p."slug",
                p."productImagePaths"[0] as "productImage",
                p."productVariants"

            FROM carts c
            JOIN cart_items ci ON c.id = ci."cartId"
            JOIN products p ON ci."productId" = p.id
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

//=================================Route to delete item from cart============================================
router.post('/cart/remove', authenticateFirebaseToken, async (req,res) => {
    /**
    * This route requires productId and cartId. 
    */
    
    // console.log('deleting item from cart route hit');
    // console.log('req body of deleting', req.body)
    // console.log("userId", req.user.id)

    const {cartId} = req.body
    // console.log(`productId:${cartId}, type: ${(typeof(cartId))}`)


    if (!cartId) {
        console.error('Product ID is missing');
        return res.status(400).json({ error: 'Product ID is missing' });
      }
      

    const  client = await zingoPool.connect();
    try {
        await client.query('BEGIN')
        // deletion 
        const deleteQuery = `
            DELETE FROM cart_items
            WHERE "id" = $1
        `
        const result = await client.query(deleteQuery, [cartId]);
        console.log('Query:', {
            text: deleteQuery,
            values: [cartId]
        });

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Cart item not found' })
          }

        const getCartItemsQuery = `
          SELECT * FROM cart_items
          WHERE "cartId" = $1
        `;
        const updatedCartItems = await client.query(getCartItemsQuery, [cartId]);

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


//=================================Route to delete all items from cart============================================
router.post('/cart/clear' , authenticateFirebaseToken, async(req,res) => {
    console.log('/cart/clear route hit')
    const userId = req.user.id
    console.log('userId', userId, typeof(userId))
    try {
        const query = `
            DELETE FROM carts
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

//=================================Route to clear items from cart by id===========================================


router.post('/cart/clear/batch', authenticateFirebaseToken, async(req, res) => {
    console.log('/cart/clear/batch route hit');
    const userId = req.user.id;
    console.log('userId', userId, typeof(userId));
    console.log("req body", req.body);

    // Extract productIds and cartItemIds from the request body
    const itemsToDelete = req.body.map(item => ({
        productId: item.productId,
        cartItemId: item.cartItemId
    }));

    const client = await zingoPool.connect();
    try {
        await client.query('BEGIN');

        for (const { cartItemId, productId } of itemsToDelete) {
            const deleteQuery = `
                DELETE FROM cart_items
                WHERE "id" = $1 
            `;
            const result = await client.query(deleteQuery, [cartItemId]);
            if (result.rowCount === 0) {
                console.log(`No matching item found for cartItemId: ${cartItemId} and productId: ${productId}`);
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ message: "Successfully cleared specified cart items" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Error with clearing cart ${err}`);
        res.status(500).json({ error: 'Failed to clear cart items' });
    } finally {
        client.release();
    }
});

router.post('/cart/update', authenticateFirebaseToken, async(req, res) => {
    const logPrefix = '[Cart/Update]';
    const userId = req.user.id;
    const { cartId, productId, purchasedQuantity, operation } = req.body;

    console.log(`${logPrefix} Request body:`, req.body); // Log the request body

    const client = await zingoPool.connect();
    try {
        await client.query('BEGIN');

        // Check if the product exists
        const productCheck = await client.query(`
            SELECT id FROM products WHERE id = $1
        `, [productId]);

        if (productCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Product does not exist' });
        }

        // Check current cart quantity
        const currentCart = await client.query(`
            SELECT "purchasedQuantity"
            FROM cart_items
            WHERE "id" = $1 
        `, [cartId]);

        let newQuantity;

        if (operation === 'increment') {
            if (currentCart.rows.length > 0) {
                // Item exists, increment the quantity
              
                newQuantity = purchasedQuantity + 1; // Increment by the requested quantity
                console.log(`${logPrefix} New quantity after increment:`, newQuantity); // Log new quantity
                await client.query(`
                    UPDATE cart_items
                    SET "purchasedQuantity" = $1, "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "cartId" = (SELECT id FROM carts WHERE "userId" = $2) AND "productId" = $3
                `, [newQuantity, userId, productId]);
            } else {
                // Item does not exist, insert it
                newQuantity = purchasedQuantity; // Set new quantity to the requested quantity
                console.log(`${logPrefix} Inserting new item with quantity:`, newQuantity); // Log new quantity
                await client.query(`
                    INSERT INTO cart_items ("cartId", "productId", "purchasedQuantity")
                    VALUES ((SELECT id FROM carts WHERE "userId" = $1), $2, $3)
                `, [userId, productId, newQuantity]);
            }
        } else if (operation === 'decrement') {
            if (currentCart.rows.length > 0) {
                // Item exists, decrement the quantity
                newQuantity = Math.max(0, currentCart.rows[0].purchasedQuantity - 1); // Decrement by 1, ensure it doesn't go below 0
                console.log(`${logPrefix} New quantity after decrement:`, newQuantity); // Log new quantity
                    // Remove the item if quantity is 0
                    if (newQuantity === 0) {
                        await client.query(`
                            DELETE FROM cart_items
                            WHERE "cartId" = (SELECT id FROM carts WHERE "userId" = $1) AND "productId" = $2
                        `, [userId, productId]);
                    }

                await client.query(`
                    UPDATE cart_items
                    SET "purchasedQuantity" = $1, "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "cartId" = (SELECT id FROM carts WHERE "userId" = $2) AND "productId" = $3
                `, [newQuantity, userId, productId]);

                
            } else {
                // If trying to decrement an item that doesn't exist, you might want to handle this case
                console.log(`${logPrefix} Attempted to decrement a non-existent item.`);
                return res.status(404).json({ error: 'Item not found in cart' });
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ message: "Cart updated successfully" });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`${logPrefix} Error:`, error);
        res.status(500).json({ error: 'Failed to update cart' });
    } finally {
        client.release();
    }
});

module.exports = router