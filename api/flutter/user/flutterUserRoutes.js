const express = require("express");
const router = express.Router();
const zingoPool = require("../../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../../rateLimiter");

//=================Route to complete signup====================
router.post('/user/profile/complete', authenticateFirebaseToken, async(req,res) => {
    console.log('user profile complete route hit')
    console.log('req body', req.body)
    
    try {
        const userId = req.user.id
        console.log('userId', userId)
        const {fullName, telephone, address} = req.body
        const query = `
        UPDATE users 
        SET 
        "fullName" = $1, 
        "phoneNumber" = $2, 
        "address" = $3, 
        "isNew" = FALSE, 
        "isCompleted" = TRUE
        WHERE id = $4;
    `;
        const result = await zingoPool.query(query, [fullName, telephone, address, userId])
        res.status(200).json({message: "Successfully updated user profile"})
    } catch (err) {
        console.error(`Unexpected error occurred while trying to complete user profile ${err}`)
        res.status(500).json({error: "Unexpected error occurred while trying to complete user profile"})
    }
})



// router.post('/user/address/add', authenticateFirebaseToken, async (req,res) => {
//     console.log("==========Add User Address to Addresses==========")
//     try {
//         const userId = req.user.id
//         const {address, city, district, commune, phoneNumber, isDefault} = req.body
//         console.log("req body:", req.body)

//         //If the new address is set as default, update existings default addresses to False
//         if (isDefault) {
//             const updateDefaultQuery = `
//             UPDATE addresses
//             SET "isDefault" = false
//             WHERE "userId" = $1 AND "isDefault" = true
//             `;
//             await zingoPool.query(updateDefaultQuery, [userId]);
//         }

//         // Insert the new address 
//         const addQuery = `
//         INSERT INTO addresses 
//             ("userId", "address", "city", "district", "commune", "phoneNumber", "isDefault")
//             VALUES ($1, $2, $3, $4, $5, $6, $7);
//     `;

//     const addValues = [userId, address, city, district, commune, phoneNumber, isDefault]
//     const queryResult = zingoPool.query(addQuery, addValues)

//     res.status(200).json({message: "Success"})
    

//     } catch(e) {
//         console.error(`Unexpected error with adding user address`)
//         res.status(500).json({error: "Unexpected error occurred while adding new address"}); // Added error response
//     }
// })

//=======================Update User Address ===========================
router.post('/user/address/update/:id?', authenticateFirebaseToken, async (req, res) => {
    console.log('======Updating User Address=====')
    try {
        const userId = req.user.id
        console.log('user id', userId)
        console.log('req body:', req.body)
        const {id} = req.params
        const {address, city, phoneNumber, isDefault} = req.body
        console.log("userId", userId)
        console.log("id", id)
        // If setting as default, first clear existing defaults
        if (isDefault) {
            const clearDefaultQuery = `
                UPDATE addresses 
                SET "isDefault" = false 
                WHERE "userId" = $1 AND "isDefault" = true
            `;
            await zingoPool.query(clearDefaultQuery, [userId]);
        }

        const updateQuery = `
            UPDATE addresses 
            SET 
                "address" = COALESCE($1, "address"), 
                "city" = COALESCE($2, "city"),
                "phoneNumber" = COALESCE($3, "phoneNumber"),
                "isDefault" = COALESCE($4, "isDefault")
            WHERE "userId" = $5 AND id = $6
        `;
        await zingoPool.query(updateQuery, [address, city, phoneNumber, isDefault, userId, id]);

        res.status(200).json({message: "Successful"});

    } catch(e) {
        console.error(`Unexpected error with updating user address`, e)
        res.status(500).json({error: "Unexpected error occurred while updating address"});
    }
})

//=======================Delete User Address ===========================
router.post("/user/address/delete/:id", authenticateFirebaseToken, async (req, res) => {
    console.log("==========Delete User Address==========")
    const userId = req.user.id
    const { id } = req.params;
    console.log("userId", userId)
    console.log("id", id)
    const client = await zingoPool.connect();
   
    try {
        await client.query('BEGIN');
        const query = `
        DELETE FROM addresses
        WHERE id = $1 AND "userId" = $2
        `;

        const deleteResult = await client.query(query, [id, userId]);
        await client.query('COMMIT');
        console.log("Delete result", deleteResult)
        if (deleteResult.rowCount > 0) {
            res.status(200).json({ message: "Address deleted successfully" });
        } else {
            res.status(404).json({ error: "Address not found or does not belong to user" });
        }
        
    }   catch (e) {
        client.query('ROLLBACK');
        console.error(`Unexpected error with deleting user address`, e)
        res.status(500).json({error: "Unexpected error occurred while deleting address"});
    } finally {
        client.release();
    }
})
//=======================Add User Address ===========================
router.post('/user/address/add', authenticateFirebaseToken, async (req, res) => {
    console.log('======Add User Address=====')
    console.log("==========Add Address Route Hit==========")
    const userId = req.user.id;
    const { address, city, phoneNumber, isDefault, commune, district } = req.body;
    console.log("req body", req.body)

    // Validate required fields
    if (!address || !city || !phoneNumber) {
        return res.status(400).json({
            success: false,
            error: "Address, city, and phone number are required"
        });
    }

    try {
        // First check if the address already exists for this user
        const checkQuery = `
            SELECT * FROM addresses 
            WHERE "userId" = $1 
            AND address = $2
            AND city = $3
        `;
        
        const existingAddress = await zingoPool.query(checkQuery, [userId, address, city]);
        
        if (existingAddress.rows.length > 0) {
            // Address exists, update it
            const updateQuery = `
                UPDATE addresses
                SET "phoneNumber" = $1,
                    "isDefault" = $2,
                    commune = $3,
                    district = $4,
                    "updatedAt" = NOW()
                WHERE "userId" = $5
                AND address = $6
                AND city = $7
                RETURNING *;
            `;
            
            const updateResponse = await zingoPool.query(updateQuery, [
                phoneNumber,
                isDefault,
                commune || "",
                district || "",
                userId,
                address,
                city
            ]);
            
            console.log("Address updated successfully:", updateResponse.rows[0]);
            return res.status(200).json({
                success: true,
                message: "Address updated successfully",
            });
        }
        
        // If address doesn't exist, proceed with insertion
        const insertQuery = `
            INSERT INTO addresses (
                "userId", address, city, "phoneNumber", "isDefault", commune, district, "createdAt", "updatedAt"
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, NOW(), NOW()
            ) RETURNING *;
        `;

        // Pass individual parameters in the correct order
        const response = await zingoPool.query(insertQuery, [
            userId, 
            address, 
            city, 
            phoneNumber, 
            isDefault, 
            commune || "", 
            district || ""
        ]);
        
        console.log("Address added successfully:", response.rows[0]);
        res.status(200).json({
            success: true,
            message: "Address added successfully",
        });
     
    } catch (e) {
        console.error("Error occurred:", e);
        res.status(500).json({ success: false, error: e.message });
    }
})

//==============Route to change defualt address =====================
router.post("/user/address/change-default/:id", authenticateFirebaseToken, async (req, res) => {
    console.log("==========Change Default Address==========")
    const userId = req.user.id
    const { id } = req.params;
    console.log("userId", userId)
    console.log("id", id)
    try {
        // First, set all addresses to not default
        const clearDefaultQuery = `
            UPDATE addresses 
            SET "isDefault" = false 
            WHERE "userId" = $1 AND "isDefault" = true
        `;
        await zingoPool.query(clearDefaultQuery, [userId]);

        // Then, set the specified address to default
        const setDefaultQuery = `
            UPDATE addresses 
            SET "isDefault" = true 
            WHERE id = $1 AND "userId" = $2
        `;
        await zingoPool.query(setDefaultQuery, [id, userId]);

        res.status(200).json({ message: "Default address changed successfully" });
    } catch (e) {
        console.error(`Unexpected error with changing default address`, e)
        res.status(500).json({error: "Unexpected error occurred while changing default address"});
    }
})

router.get('/public/user/profile/:userId',  async (req,res) => {
    console.log('=========/user/profile/seller route hit==========')

    try {
        const userId = parseInt(req.params.userId, 10);
        console.log('userId', userId, typeof(userId));
        const query = `
        SELECT * FROM users WHERE id = $1
        `

        const result = await zingoPool.query(query, [userId])
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Not Found",
                message: "User not found"})
        }

        const userData = result.rows[0];

        res.status(200).json({ user: userData  });

    } catch (error) {
        console.error('Error fetching user profile:', error)
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred'
          });
    }
})


router.get('/user/profile', authenticateFirebaseToken, async (req,res) => {
    console.log('==========/user/profile route hit==========')
    console.log('User id from user-profile/:email route', req.user.id)
    try {
        const userId = req.user.id;

        const query = `
       SELECT u.*, 
        ARRAY_AGG(DISTINCT sh.query) AS "searchHistory",
        (
            SELECT ARRAY_AGG(
                json_build_object(
                    'id', a.id,
                    'userId', a."userId",
                    'address', a."address",
                    'city', a.city,
                    'district', a.district,
                    'commune', a.commune,
                    'phoneNumber', a."phoneNumber",
                    'isDefault', a."isDefault",
                    'createdAt', a."createdAt"
                )
            )
            FROM (
                SELECT DISTINCT ON (id) *
                FROM addresses
                WHERE "userId" = u.id
            ) a
        ) AS "addresses"
    FROM users u
    LEFT JOIN search_history sh ON u.id = sh."userId"
    WHERE u.id = $1
    GROUP BY u.id
     `;

        const result = await zingoPool.query(query, [userId])
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Not Found",
                message: "User not found"})
        }

        const userData = result.rows[0];
        // console.log('User data being sent:', userData);

        res.status(200).json({ user: userData });

    } catch (error) {
        console.error('Error fetching user profile:', error)
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred'
          });
    }
})


router.get('/user/products-from-same-seller/:postedBy', async(req,res) => {
    // console.log("==========User/products-from-seller Id Route Hit===========");
    const {postedBy} = req.params;
    const _postedBy = parseInt(postedBy);
    const limit = 20;
    
    console.log("postedBy", _postedBy,'type', typeof(_postedBy));
    try {
        const result = await zingoPool.query(`
            SELECT 
                p."productName", 
                p."productPrice", 
                p."discountedPrice", 
                p."productImagePaths", 
                p."slug",
                p."directToSeller",
                u."instagram",
                u."username",
                u."fullName"
            FROM products p
            JOIN users u ON p."postedBy" = u.id
            WHERE p."postedBy" = $1
            LIMIT $2
        `, [_postedBy, limit]);
        res.status(200).json({ products: result.rows });

    } catch (err) {
        console.error(`Error fetching products: ${err.message}`);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


router.get('/user/comments/:productId', async (req, res) => {
    console.log("==========Comments/Product Id Route Hit===========")
    try {
        const { productId } = req.params;
        const _productId = parseInt(productId)
        const page = parseInt(req.query.page) || 1;  // Default to page 1
        const limit = 3;  // Comments per page
        const offset = (page - 1) * limit;
        // console.log("productId", _productId, typeof(_productId))

        // Modified query to include pagination and total count
        const commentQuery = `
            WITH comment_count AS (
                SELECT COUNT(*) as total
                FROM user_comments
                WHERE "productId" = $1
            ),
            user_details AS (
                SELECT u."fullName", u."userProfilePath", u."id"
                FROM users u
                WHERE u.id = $1
            )
            SELECT uc.*,
             ud."fullName", 
             ud."userProfilePath", 
                   (SELECT total FROM comment_count) as total_comments
            FROM user_comments uc
            LEFT JOIN user_details ud ON true
            WHERE uc."productId" = $1
            ORDER BY uc."createdAt" DESC
            LIMIT $2 OFFSET $3
        `;

        const queryResult = await zingoPool.query(commentQuery, [
            _productId,
            limit,
            offset
        ]);

        res.status(200).json({
            comments: queryResult.rows,
            pagination: {
                currentPage: page,
                totalComments: queryResult.rows[0]?.total_comments || 0,
                totalPages: Math.ceil((queryResult.rows[0]?.total_comments || 0) / limit),
                commentsPerPage: limit
            },
            sellerDetails: {
                userId: queryResult.rows[0]?.id || null,
                fullName: queryResult.rows[0]?.fullName || null,
                userProfilePath: queryResult.rows[0]?.userProfilePath || null
            }
        });
    } catch (e) {
        console.error(`Unexpected error with fetching comments ${e}`);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred'
        });
    }
});

router.post("/user/fcmToken/update", authenticateFirebaseToken, async (req, res) => {
    console.log("==========Update fcmToken==========");
    console.log("req.body", req.body);
    
    const { fcmToken } = req.body;
    console.log("fcmToken", fcmToken);
    

    const userId = req.user.id;

    const updateQuery = `
        UPDATE users
        SET "fcmToken" = $1
        WHERE id = $2
    `;

    try {
        const result = await zingoPool.query(updateQuery, [fcmToken, userId]);
        if (result.rowCount > 0) {
            res.status(200).json({ message: "FCM token updated successfully" });
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (error) {
        console.error("Error updating fcmToken:", error);
        res.status(500).json({ error: "Failed to update fcmToken" });
    }
});

module.exports = router;