const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../rateLimiter");

router.get('/offers/:productId', authenticateFirebaseToken, async (req, res) => {
    console.log('Route fetch offers hit')
    try {
        const userId = req.user.id
        const productId = parseInt(req.params.productId, 10)
        console.log('productId', productId)
        
        if (isNaN(productId)) {
            return res.status(400).json({ error: 'Invalid product ID' });
        }

        // First, get the product details including who posted it
        const productQuery = `
            SELECT "postedBy"
            FROM products 
            WHERE id = $1
            AND "isSold" = FALSE
            AND "isDeleted" = FALSE
        `;

        const productResult = await zingoPool.query(productQuery, [productId]);
        
        // Check if product exists
        if (productResult.rowCount === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // Check if the authenticated user is the one who posted the product
        const product = productResult.rows[0];
        if (product.postedBy !== userId) {
            return res.status(403).json({ 
                error: 'Unauthorized: You can only view offers for products you posted' 
            });
        }

        // If authorized, fetch the offers
        const offersQuery = `
            SELECT o.*,
                   u."firstName",
                   u."lastName"
            FROM offers o
            JOIN users u ON o."userId" = u.id
            WHERE o."productId" = $1
            ORDER BY o."createdAt" DESC
        `;

        const offersResult = await zingoPool.query(offersQuery, [productId]);
        const offers = offersResult.rows;

        res.status(200).json({ offers });

    } catch (err) {
        console.error(`Unexpected error occurred while fetching offers: ${err}`);
        res.status(500).json({ error: 'Internal server error' });
    }
});
module.exports = router