// backend/routes/posts.js
const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const createRateLimiterMiddleware = require("../rateLimiter");

// ============================================================
// GET /api/user/:userId/posts
// Fetches a student's profile info and all the products they've posted
// ============================================================
router.get('/user/:userId/posts', createRateLimiterMiddleware, async (req, res) => {
    try {
        // userId here will now be the Firebase UID string passed from the frontend
        const userId = req.params.userId; 
        console.log('========== Fetching Posts for Firebase UID:', userId, '===========');

        // Refactored Query to match our new Google Sign-In table schema
        const userQuery = `
            SELECT 
                json_build_object(
                    'uid', users.firebase_uid,
                    'name', users.name,
                    'email', users.email,
                    'picture', users.picture,
                    'phone', users.phone,
                    'address', users.address,
                    'school', users.school,
                    'createdAt', users.created_at
                ) as user,
                json_agg(
                    json_build_object(
                        'productId', products."id",
                        'productName', products."productName",
                        'productDescription', products."productDescription",
                        'productPrice', products."productPrice",
                        'productCategory', products."productCategory",
                        'productCondition', products."productCondition",
                        'createdAt', products."createdAt",
                        'productImagePaths', products."productImagePaths",
                        'slug', products."slug"
                    )
                ) FILTER (WHERE products.id IS NOT NULL) as products
            FROM users 
            -- 🔥 CRITICAL FIX: Match the product owner to the firebase_uid column
            LEFT JOIN products ON users.firebase_uid = products."postedBy"
            WHERE users.firebase_uid = $1
            GROUP BY users.firebase_uid
        `;
        
        const result = await zingoPool.query(userQuery, [userId]);
        
        // If the user profile row doesn't exist in Postgres yet
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student profile not found' });
        }

        // Send back the cleanly formatted JSON payload
        res.status(200).json({
            success: true,
            data: result.rows[0] // Contains { user: {...}, products: [...] }
        });

    } catch (error) {
        console.error('Error fetching user products:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

module.exports = router;