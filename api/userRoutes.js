const express = require("express");
const router = express.Router();
const zingoPool = require('../database/pgZingo')
const authenticateFirebaseToken = require('../auth/authFirebaseToken')
const rateLimiterMiddleware = require('./rateLimiter');
const multer = require('multer');
const { uploadFileToS3, deleteFileFromS3 } = require("../database/s3");
const createRateLimiterMiddleware = require("./rateLimiter");
const {admin} = require("../auth/firebase-admin");
const suspiciousPatternDetector = require("../utils/security/suspiciousPattern");

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 8
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: MAX_FILES
    },
    fileFilter: (req, file, cb) => {
        // Log the file information correctly using the 'file' parameter
        console.log('Received file:', {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype
        });

        if (file.mimetype.startsWith('image/')) {
            console.log('File accepted as image:', file.mimetype);
            cb(null, true);
        } else {
            console.log('File rejected - invalid mime type:', file.mimetype);
            cb(new Error(`Not an image! File type ${file.mimetype} is not supported.`), false);
        }
    }
});

const sanitizeFileName = (fileName) => {
    return fileName
        .toLowerCase() // Convert to lowercase
        .replace(/\s+/g, '_') // Replace spaces with underscore
        .replace(/[^a-z0-9._-]/g, '') // Remove all special characters except dots, underscores, and hyphens
};


//=================Route to add anon Id to database =========================
router.post('/user/page-visit', async (req, res) => {
    console.log('page visit route hit')
    const { userId } = req.body;
    console.log('userId', userId)
    try {
        // Check if anonId already exists
        const checkQuery = 'SELECT * FROM user_login WHERE "userId" = $1';
        const checkResult = await zingoPool.query(checkQuery, [userId]);
        
        if (checkResult.rows.length > 0) {
            return res.status(200).json({ 
                message: 'Anon ID already exists',
                user: checkResult.rows[0]
            });
        }
        
        // If not exists, insert new anon user
        const insertQuery = `
            INSERT INTO user_login("userId", "loginTime") 
            VALUES($1, $2) 
            RETURNING *`;
        const insertResult = await zingoPool.query(insertQuery, [userId, new Date()]);
        
        res.status(200).json({ 
            message: 'Anon ID created successfully',
            user: insertResult.rows[0]
        });
    } catch (error) {
        console.error('Error in anon-id route:', error);
        res.status(500).json({ error: 'Failed to process anon ID' });
    }
});


//-----------------Route to Create User in Postgresql ---------------------------
router.post('/create-user-profile', async (req, res) => {
  console.log('=====create user route hit=====')
  const { email, fullName, fcmToken } = req.body;
  console.log("User Email", email) 
  console.log("FullName", fullName)
  console.log('fcmToken', fcmToken)
  const phoneNumber = email.split('@')[0]

  // Running a promotion where new users receive 200 points

    const points = 0;
    let username = fullName.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '_');


  
  try {
      // First, check if the user already exists
      const checkUserQuery = 'SELECT * FROM users WHERE email = $1';
      const checkUserResult = await zingoPool.query(checkUserQuery, [email]);
      
      if (checkUserResult.rows.length > 0) {
          // User already exists, return the existing user data
          return res.status(200).json({ 
              message: 'User profile already exists',
              user: checkUserResult.rows[0]
          });
      }
      
      // If user doesn't exist, create a new profile
      const insertUserQuery = `
      INSERT INTO users(email, role, "fullName", "phoneNumber", "fcmToken", "points", "username") 
      VALUES($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`;
      const insertUserValues = [email, 'buyer', fullName, phoneNumber, fcmToken, points, username];
      
      const insertResult = await zingoPool.query(insertUserQuery, insertUserValues);
      
      res.status(200).json({ 
          message: 'User profile created successfully',
          user: insertResult.rows[0]
      });
  } catch (error) {
      console.error('Error in create-user-profile route:', error);
      res.status(500).json({ error: 'Failed to process user profile' });
  }
});



router.post('/user/activity', authenticateFirebaseToken, async (req, res) => {
    console.log('user activity route hit')
   
})

//=========================Route to get user profile ===================
router.get('/user/profile', authenticateFirebaseToken, async (req, res) => {
    console.log('33 students /user/profile route hit')
    console.log('Firebase UID from user-profile route', req.user.uid)
    
    try {
        const firebaseUid = req.user.uid;

      const query = `
            SELECT "33studentUsers".*,
                    COALESCE(
                    json_agg(
                        json_build_object(
                        'id', addr.id,
                        'studentUid', addr."studentId",
                        'address', addr.address,
                        'city', addr.city,
                        'phoneNumber', addr."phoneNumber",
                        'isDefault', addr."isDefault",
                        'createdAt', addr."createdAt",
                        'district', addr.district,
                        'commune', addr.commune,
                        'updatedAt', addr."updatedAt"
                        )
                    ) FILTER (WHERE addr.id IS NOT NULL),
                    '[]'::json
                    ) AS addresses,
                    COALESCE(
                    json_agg(
                        json_build_object(
                        'storeId', sl."storeId",
                        'locationName', sl."locationName",
                        'address', sl."address",
                        'city', sl."city",
                        'phoneNumber', sl."phoneNumber",
                        'openingHours', sl."openingHours",
                        'bannerUrl', sl."bannerUrl",
                        'isActive', sl."isActive"
                        )
                    ) FILTER (WHERE sl."storeId" IS NOT NULL),
                    '[]'::json
                    ) AS stores
            FROM "33studentUsers"
            LEFT JOIN "33studentUsersAddress" addr ON "33studentUsers"."userId" = addr."studentId"
            LEFT JOIN "33storeLocations" sl ON "33studentUsers"."userId" = sl."userId"
            WHERE "33studentUsers"."userId" = $1
            GROUP BY "33studentUsers"."userId"
            `;
        const result = await zingoPool.query(query, [firebaseUid]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Not Found",
                message: "User not found"
            });
        }

        const userData = result.rows[0];

        const sessionInfo = {
            uid: req.user.uid,
            email: req.user.email,
            emailVerified: req.user.email_verified,
            ...(req.user.name && { name: req.user.name }),
            ...(req.user.picture && { picture: req.user.picture }),
            iat: req.user.iat, 
            exp: req.user.exp, 
            aud: req.user.aud, 
            iss: req.user.iss  
        };

        res.status(200).json({ 
            user: userData,
            session: sessionInfo
        });

    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred'
        });
    }
});
//================Route to update user information ===============================
router.post('/user/profile/update',
    createRateLimiterMiddleware,
    authenticateFirebaseToken,
    upload.fields([
        { name: 'profileImage', maxCount: 1 },
        { name: 'heroImage', maxCount: 1 }
    ]),
    async (req, res) => {
    console.log('user/profile/update route hit')
    console.log('req body', req.body)
    console.log('files', req.files)
    try {
        const id = req.user.id
        const profileData = JSON.parse(req.body.profileData);
        const { 
            bio,
            fullName,
            username,
            instagram,
            telegram,
            tiktok,
            phoneNumber,
            firstName,
            lastName,
            deleteProfileImage,
            deleteHeroImage 
        } = profileData;
        
        // First, get the current user profile to check if there's existing images
        const currentUser = await zingoPool.query(
            'SELECT "userProfilePath", "heroSectionImagePath" FROM users WHERE id = $1',
            [id]
        );
        
        let userProfilePath = currentUser.rows[0]?.userProfilePath;
        let heroSectionImagePath = currentUser.rows[0]?.heroSectionImagePath;
        
        // Delete profile image first if requested
        if (deleteProfileImage && userProfilePath) {
            await deleteFileFromS3(userProfilePath)
            userProfilePath = null;
        } else if (req.files && req.files.profileImage && req.files.profileImage[0]) {
            // Upload profile image to s3
            const profileFile = req.files.profileImage[0];
            const timestamp = Date.now();
            const sanitizedName = sanitizeFileName(profileFile.originalname);
            const fileNameWithoutExtension = sanitizedName.split('.').slice(0, -1).join('.');
            const fileName = `users/${timestamp}_${fileNameWithoutExtension}.avif`;
            const imagePath = `${process.env.S3_BUCKET_URL}/${fileName}`;
            console.log("Profile fileName", fileName);
            console.log("Profile imagePath", imagePath);
            
            // If there's an existing profile image, delete it first
            if (userProfilePath) {
                await deleteFileFromS3(userProfilePath);
            }
              
            await uploadFileToS3(profileFile, fileName);
            userProfilePath = imagePath;
        }

        // Delete hero image first if requested
        if (deleteHeroImage && heroSectionImagePath) {
            await deleteFileFromS3(heroSectionImagePath)
            heroSectionImagePath = null;
        } else if (req.files && req.files.heroImage && req.files.heroImage[0]) {
            // Upload hero image to s3
            const heroFile = req.files.heroImage[0];
            const timestamp = Date.now();
            const sanitizedName = sanitizeFileName(heroFile.originalname);
            const fileNameWithoutExtension = sanitizedName.split('.').slice(0, -1).join('.');
            const fileName = `users/hero/${timestamp}_${fileNameWithoutExtension}.avif`;
            const imagePath = `${process.env.S3_BUCKET_URL}/${fileName}`;
            console.log("Hero fileName", fileName);
            console.log("Hero imagePath", imagePath);
            
            // If there's an existing hero image, delete it first
            if (heroSectionImagePath) {
                await deleteFileFromS3(heroSectionImagePath);
            }
              
            await uploadFileToS3(heroFile, fileName);
            heroSectionImagePath = imagePath;
        }

        const updatedFields = {
            bio,
            fullName,
            username,
            instagram,
            tiktok,
            telegram,
            firstName,
            lastName,
            phoneNumber,
            userProfilePath,
            heroSectionImagePath
        };

        let updateQuery = 'UPDATE users SET ';
        const updateValues = [];
        let index = 1;

        // Filter out undefined values but keep null values for image paths
        const validUpdatedFields = Object.fromEntries(
            Object.entries(updatedFields).filter(([key, value]) => 
                value !== undefined && (['userProfilePath', 'heroSectionImagePath'].includes(key) || value !== null)
            )
        );

        for (const [key, value] of Object.entries(validUpdatedFields)) {
            updateQuery += `"${key}" = $${index}, `;
            updateValues.push(value);
            index++;
        }
       
        // Remove the trailing ', '
        updateQuery = updateQuery.slice(0,-2);
        updateQuery += ' WHERE id = $' + index + ' RETURNING *';
        updateValues.push(id)

        console.log('Update Query:', updateQuery);
        console.log('Update Values:', updateValues);

        const result = await zingoPool.query(updateQuery, updateValues)

        if (result.rows.length === 0) {
            return res.status(500).json({
                message: "Error with updating user profile in database",
            });
        }

        const updatedUser = result.rows[0];
        res.status(200).json({
            message: "Successfully updated user profile",
            user: updatedUser
        });
        
    } catch (err) {
        console.error(`Unexpected error occurred while updating user profile: ${err}`)
        res.status(500).json({
            message: "Internal server error",
            error: err.message
        });
    }
})
//=================Route to complete signup====================
router.post('/user/profile/complete', authenticateFirebaseToken, async(req,res) => {
    console.log('user profile complete route hit')
    console.log('req body', req.body)
    
    try {
        const userId = req.user.id
        const {firstName, lastName, phoneNumber, address, city} = req.body
        const query = `
        UPDATE users 
        SET "firstName" = $1, "lastName" = $2, "phoneNumber" = $3, "address" = $4, "city" = $5 , "isNew" = FALSE, "isCompleted"=TRUE
        WHERE id = $6;
    `;
        const result = await zingoPool.query(query, [firstName, lastName, phoneNumber, address, city, userId ])
        res.status(200).json({message: "Succesfully updated user profile"})
    } catch (err) {
        console.error(`Unexpectedd error occured while trying to complete user profile ${err}`)
        res.status(500).json({error: "Unexpected error occured while trying to complete user profile"})
    }
})

//=================Route to get User's Post Individually (Require authenticateFirebaseToken)=============
router.get('/user/posts', authenticateFirebaseToken,async(req,res) => {
    console.log('===/user/posts route hit===')
    const userId = req.user.id
    const page = parseInt(req.query.page) || 1;
    //console.log('page', page)
    const limit = 20;
    const offset = (page-1) * limit;
    //console.log(`userID:${userId}, type:${typeof(userId)}`)
    try {
        const countQuery = `
            SELECT COUNT(*)
            FROM products
            WHERE "postedBy" = $1
            AND "isDeleted" = FALSE
        `
        const countResult = await zingoPool.query(countQuery, [userId]);
        const totalPosts = parseInt(countResult.rows[0].count)

        const query = `
            SELECT * 
            FROM products 
            WHERE "postedBy" = $1
            AND "isDeleted" = FALSE
            ORDER BY "createdAt" DESC
            LIMIT $2 OFFSET $3
    
        `
        const result = await zingoPool.query(query, [userId, limit, offset])

        
        res.status(200).json({
            message: result.rows.length === 0 ? "No products found" : "Products retrieved successfully",
            products: result.rows,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalPosts / limit),
                totalItems: totalPosts,
                itemsPerPage: limit
            }
        });
    } catch (err) {
        console.error(`Error with fetching users posts: ${err}`);
        res.status(500).json({
            error: "Internal Server Error",
            message: "Failed to fetch posts"
        });
    }
})


router.get("/public/user/:username", rateLimiterMiddleware, suspiciousPatternDetector,async (req, res) => {
    console.log('==========user/:username route hit==========')
    console.log('req params', req.params)
    const username = req.params.username;
    console.log("username", username)
    try {
        // Get user data
        const userQuery = `
            SELECT * FROM users WHERE "username" = $1
        `;
        const userResult = await zingoPool.query(userQuery, [username]);

        
        if (userResult.rows.length === 0) {
            return res.status(404).json({
                message: "User not found",
                user: null
            });
        }
        
        const user = userResult.rows[0];
        const userId = user.id;
        
    
        
        // Return the complete data with pagination info
        res.status(200).json({
            message: "User found",
            user: user
           
        });
    } catch (err) {
        console.error(`Error with fetching user by username ${err}`);
        res.status(500).json({
            error: "Internal Server Error",
            message: "Failed to fetch user"
        });
    }
});

// router.get("/public/user/:username/posts", rateLimiterMiddleware, suspiciousPatternDetector, async (req, res) => {
//     console.log('========== User / :userId / posts route hit ===========');
//     console.log("req params", req.params)
//     console.log("req query", req.query)
    
//     const username = req.params.username;
//     const page = parseInt(req.query.page) || 1;
//     const limit = 20;
//     const offset = (page - 1) * limit;
    
//     // Get the table name from query parameter, default to "products"
//     const tableName = req.query.db || "products";
    
//     // Validate table name to prevent SQL injection
//     const allowedTables = ["products", "1464_products"];
//     if (!allowedTables.includes(tableName)) {
//         console.error(`Invalid table name: ${tableName}`);
//         return res.status(400).json({
//             error: "Invalid table parameter",
//             message: "Table not allowed"
//         });
//     }
    
//     // Additional validation: ensure table name only contains allowed characters
//     if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
//         console.error(`Invalid table name format: ${tableName}`);
//         return res.status(400).json({
//             error: "Invalid table parameter format"
//         });
//     }

//     if (username.includes('.') || username.length > 50 || /[^a-zA-Z0-9_-]/.test(username)) {
//         console.error(`Invalid username format: ${username}`);
//         return res.status(404).send('Not found');
//     }
    
//     try {
//         // First, get the user ID from the username
//         const userQuery = `
//             SELECT id FROM users WHERE username = $1
//         `;
        
//         console.log(`Looking up user with username: ${username}`);
//         const userResult = await zingoPool.query(userQuery, [username]);
        
//         if (userResult.rows.length === 0) {
//             console.log(`No user found with username: ${username}`);
//             return res.status(404).json({
//                 message: "User not found",
//                 posts: []
//             });
//         }
        
//         const userId = userResult.rows[0].id;
//         console.log(`Found user with ID: ${userId}, querying table: ${tableName}`);
        
//         // Now fetch posts using the numeric userId and dynamic table name
//         // Note: Table name must be interpolated directly (not parameterized) but is safe due to allowlist validation
//         const postsQuery = `
//            SELECT p.*, u."fullName", u."instagram" 
//             FROM "${tableName}" p
//             JOIN users u ON p."postedBy" = u.id
//             WHERE p."postedBy" = $1
//             AND p."isDeleted" = false
//             ORDER BY p."createdAt" DESC
//             LIMIT $2 OFFSET $3
//         `;
        
//         const postsResult = await zingoPool.query(postsQuery, [userId, limit, offset]);
        
//         // Get total count for pagination
//         const countQuery = `
//             SELECT COUNT(*) FROM "${tableName}" WHERE "postedBy" = $1 AND "isDeleted" = false
//         `;
//         const countResult = await zingoPool.query(countQuery, [userId]);
//         const totalPosts = parseInt(countResult.rows[0].count);
//         const totalPages = Math.ceil(totalPosts / limit);
        
//         res.status(200).json({
//             message: "Posts retrieved successfully",
//             posts: postsResult.rows,
//             pagination: {
//                 totalPosts,
//                 totalPages,
//                 currentPage: page,
//                 postsPerPage: limit,
//                 hasNextPage: page < totalPages,
//                 hasPrevPage: page > 1
//             }
//         });
//     } catch (err) {
//         console.error(`Error fetching user products: ${err}`);
//         res.status(500).json({
//             error: "Internal Server Error",
//             message: "Failed to fetch user posts",
//             details: err.message
//         });
//     }
// });

router.post("/user/forgot-password/initiate", async (req,res) => {
    console.log("==========Initiate Forgot Password ==========")
    const { phoneNumber } = req.body;
    let formattedPhoneNumber = phoneNumber.replace('+', '');
        if (formattedPhoneNumber.startsWith('0')) {
        formattedPhoneNumber = formattedPhoneNumber.slice(1);
        }
    console.log("Formatted Phone Number", formattedPhoneNumber)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log("OTP", otp)
    
    const client = await zingoPool.connect();
    await client.query('BEGIN');
    
    const userInfo = {"forgot_password": "initiated"}
    // Add explicit expiration time (10 minutes from now)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    
    const query = `
        INSERT INTO otp ("phoneNumber", "otpCode", "userInfo", "expiresAt")
        VALUES ($1, $2, $3, $4)
        ON CONFLICT ("phoneNumber") 
        DO UPDATE SET 
        "otpCode" = EXCLUDED."otpCode",
        attempts = 0,
        "userInfo" = EXCLUDED."userInfo",
        "createdAt" = CURRENT_TIMESTAMP,
        "expiresAt" = EXCLUDED."expiresAt"
        RETURNING *;
    `;
    const values = [
        formattedPhoneNumber,
        otp,
        userInfo,
        expiresAt
    ];

    try {
        console.log("Executing query with values:", values);
        const result = await client.query(query, values);
        await client.query('COMMIT');
        
        console.log("Query Result:", result.rows[0]);
        res.json({ 
            success: true, 
            message: 'OTP sent successfully',
            expiresAt: expiresAt // Return expiration time to client
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error executing query:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        client.release();
    }
}); 

router.post("/user/forgot-password/otp-confirmation", async (req, res) => {
    console.log("=====Forgot Password OTP-Confirmation==========");
    const client = await zingoPool.connect();
    const { phoneNumber, otpCode, newPassword } = req.body;
    // console.log("Req Body", req.body)
    
     let formattedPhoneNumber = phoneNumber.replace('+', '');
        if (formattedPhoneNumber.startsWith('0')) {
        formattedPhoneNumber = formattedPhoneNumber.slice(1);
        }
    // console.log("Formatted Phone Number", formattedPhoneNumber)
    // console.log("OTP Code", otpCode)
    // console.log("New Password", newPassword)
    
    try {
        await client.query('BEGIN');
        
        const getOtpQuery = `
            UPDATE otp
            SET attempts = attempts + 1
            WHERE "phoneNumber" = $1
            RETURNING *, 
                     EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - "createdAt")) as age_seconds,
                     EXTRACT(EPOCH FROM ("expiresAt" - CURRENT_TIMESTAMP)) as remaining_seconds
        `;
        const otpResult = await client.query(getOtpQuery, [formattedPhoneNumber]);
        const otpRecord = otpResult.rows[0];

        if (!otpRecord) {
            await client.query('COMMIT');
            return res.status(400).json({ 
                success: false, 
                error: 'No OTP request found' 
            });
        }

        // Log detailed timing information for debugging
        console.log({
            currentTime: new Date(),
            createdAt: otpRecord.createdAt,
            expiresAt: otpRecord.expiresAt,
            ageSeconds: otpRecord.age_seconds,
            remainingSeconds: otpRecord.remaining_seconds
        });

        if (otpRecord.remaining_seconds <= 0) {
            await client.query('DELETE FROM otp WHERE "phoneNumber" = $1', [formattedPhoneNumber]);
            await client.query('COMMIT');
            return res.status(400).json({ 
                success: false, 
                error: 'OTP expired',
                timing: {
                    ageSeconds: otpRecord.age_seconds,
                    remainingSeconds: otpRecord.remaining_seconds
                }
            });
        }

        if (otpRecord.attempts >= 3) {
            await client.query('DELETE FROM otp WHERE "phoneNumber" = $1', [formattedPhoneNumber]);
            await client.query('COMMIT');
            return res.status(400).json({ 
                success: false, 
                error: 'Too many attempts' 
            });
        }

        if (otpRecord.otpCode !== otpCode) {
            await client.query('COMMIT');
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid OTP' 
            });
        }
        console.log("OTP code confirmed successfully");
        await client.query('DELETE FROM otp WHERE "phoneNumber" = $1', [formattedPhoneNumber]);
        await client.query('COMMIT'); 
        resetFirebasePassword(phoneNumber, newPassword);
        
        res.status(200).json({
            message: "OTP code confirmed",
            timing: {
                ageSeconds: otpRecord.age_seconds,
                remainingSeconds: otpRecord.remaining_seconds
            }
           
        });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Error occurred:", e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

const resetFirebasePassword = async (phoneNumber, newPassword) => {
    let formattedPhone = phoneNumber;
       if (phoneNumber.startsWith('0')) {
        formattedPhone = '855' + phoneNumber.substring(1);
        } else if (!phoneNumber.startsWith('855')) {
        formattedPhone = '855' + phoneNumber;
        }
    const email = `${formattedPhone}@phone.com`;
    console.log("Phone Email in Reset Firebase Password", email);
    console.log("New Password in Reset Firebase Password", newPassword);
     try {
        // Get user by email instead of phone number
        const userRecord = await admin.auth().getUserByEmail(email);
        
        // Update password using the user's UID
        await admin.auth().updateUser(userRecord.uid, {
            password: newPassword
        });
        
        console.log(`Password updated successfully for user ${userRecord.uid}`);
        
    } catch (error) {
        console.error('Error resetting password:', error);
       
    }
}


router.post('/user/admin-reset-password', async (req, res) => {
    console.log("admin password reset");
    const { phoneNumber, newPassword } = req.body;
    const email = `${phoneNumber}@phone.com`;
    
    try {
        // Get user by email instead of phone number
        const userRecord = await admin.auth().getUserByEmail(email);
        
        // Update password using the user's UID
        await admin.auth().updateUser(userRecord.uid, {
            password: newPassword
        });
        
        console.log(`Password updated successfully for user ${userRecord.uid}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ 
            error: 'Failed to reset password',
            details: error.message 
        });
    }
});




module.exports = router;