const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const {uploadFileToS3, deleteFileFromS3} = require("../../database/s3")
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../rateLimiter");
const { sanitizeFileName } = require("../../utils/sanitzieFileName");


require('dotenv').config();

const ADMIN_USER_ID = process.env.ADMIN_ID

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 2MB
const MAX_FILES = 8

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: MAX_FILES
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Not an image! Please upload only image files.'), false);
        }
    }
});



router.post('/refund/post',createRateLimiterMiddleware,authenticateFirebaseToken, async (req, res) => {
    upload.array('productImages', MAX_FILES)(req, res, async (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: `File size is too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.` });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILES} files.` });
            }
            return res.status(400).json({ error: err.message });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }
        // console.log(console.log('/post product route hit');)
      

    console.log('=========Add Refund Route Hit=====')
    try {
        const userId = req.user.id
        const {orderId, refundReason, productId, refundQuantity} = req.body
        let imagePaths = [];
        
        const status="pending"
         // Upload image to s3
         if (req.files && req.files.length > 0) {
            for (let file of req.files) {
                const timestamp = Date.now();
                const sanitizedName = sanitizeFileName(file.originalname);
                const fileName = `products/refund/${timestamp}_${sanitizedName}`;
                const imagePath = await uploadFileToS3(file, fileName);
                console.log('imagePath', imagePath);
                imagePaths.push(imagePath);
            }
        }
    
        const query = `
        INSERT INTO refund_requests (
        "orderId", "userId", "refundReason", "imagePaths", "status", "productId", "refundQuantity"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        `
        const values = [orderId, userId, refundReason, imagePaths, status, productId, refundQuantity]
        const result = await zingoPool.query(query, values);
           
        res.status(200).json({ 
            message: "Successfully Added Product For Review",
            refundId: result.rows[0].id
        });
    

    } catch (e) {
        console.error('Unexpecte error in create refund route:', e);
        res.status(500).json({ error: "An unexpected error occurred" });
    }
})
})

module.exports = router