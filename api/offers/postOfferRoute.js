const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../rateLimiter");

//==============To POST Offered Price to PRODUCT
router.post('/product/offer/create', createRateLimiterMiddleware, authenticateFirebaseToken, async(req,res) => {
    console.log('/product/offer/create route hit')
    try {
        let userId = parseInt(req.user.id)
        const {offeredAmount, productId} = req.body
        const intOfferedAmount = parseInt(offeredAmount)
        console.log('type', typeof(userId))
        console.log('Req Body', req.body)
        
        const status = "pending"
        // Add RETURNING * to get the updated row
        const query = `
        INSERT INTO offers ("productId", "offeredAmount", "userId", status)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
        `;
        const values = [productId, intOfferedAmount, userId, status]
        const result = await zingoPool.query(query, values)
        console.log('result', result.rows[0])
        
        // Check if any rows were updated
        if (result.rowCount === 0) {
            return res.status(404).json({
                message: "No products found with the given ID",
                products: []
            });
        }
        
        // Fixed the response syntax
        return res.status(200).json({
            message: "Successfully made an offer.",
            product: result.rows[0]  // Now we can return the updated product
        })

    } catch (err) {
        console.error(`Error with creating offer: ${err}`)
        res.status(500).json({ error: "An unexpected error occurred" });
    }
})

module.exports = router;