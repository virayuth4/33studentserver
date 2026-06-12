const express = require("express");
const router = express.Router();
const zingoPool = require("../../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../../rateLimiter");
const { generateOrderId } = require("../../../utils/generateOrderId");
const { sanitizeFileName } = require("../../../utils/sanitzieFileName");
const { uploadFileToS3 } = require("../../../database/s3");
const { sanitizeProductDescription } = require("../../../utils/sanatizeHtml");
const { inverseFormatCityName } = require("../../../utils/cityFormat");

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


//==============To POST PRODUCT
router.post('/product/post',createRateLimiterMiddleware,authenticateFirebaseToken,  (req, res) => {
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


        try {
        console.log('==========/Flutter Post Product route hit==========')
        console.log('req body in post-product route', req.body)
     
            const userId = req.user.id
            

            // console.log('userId:', userId)

            let productImagePaths = [];

            // Upload image to s3
            if (req.files && req.files.length > 0) {
                for (let file of req.files) {
                    const timestamp = Date.now();
                    const sanitizedName = sanitizeFileName(file.originalname);
                    const fileName = `product-images/sales/${timestamp}_${sanitizedName}`;
                    const imagePath = await uploadFileToS3(file, fileName);
                    console.log('imagePath', imagePath);
                    productImagePaths.push(imagePath);
                }
            }

            // Extract data from req.body
            const {productName,
                 productPrice, productCondition, productStockStatus, availableQuantity,
                 productCategory, address, sellerCity, phoneNumber, bankAccountNumber, bankAccountName, productBrand,
                moneyBackGuarantee } = req.body
            const productDescription = sanitizeProductDescription(req.body.productDescription);
                 
            if (!productName ||
                    !productDescription || 
                    !productPrice || 
                    !availableQuantity || 
                    !productCondition ||
                    !productStockStatus || 
                    !productCategory || 
                    !address ||
                    !sellerCity || 
                    !phoneNumber || 
                    !bankAccountNumber || 
                    !bankAccountName 
                 
                ) {
                    return res.status(400).json({ message: "All fields are required" });
                }

            let saleState = true
            let reviewState = false
            let verifyState = false
            let featureState= false
            let productTags = []
            const slug = `/${productCategory.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${productName.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${Date.now()}`;
            const finalProductBrand = productBrand?.trim() || "N/A";
                
            // Insert data into PostgreSQL
            const query = `
            INSERT INTO products (
               "productName",  "productCategory", "productPrice", 
                "availableQuantity", "productCondition", "productStockStatus", "productDescription", 
                "productImagePaths", "phoneNumber", "sellerAddress", "sellerCity", 
                "bankAccountNumber","bankAccountName", "saleState","reviewState", "verifyState",
                "featureState", "slug","postedBy", "productTags", "productBrand", "moneyBackGuarantee"
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,$15, $16, $17, $18, $19, $20, $21)
            RETURNING id
        `;

        const values = [
            productName, productCategory,  productPrice,
            availableQuantity, productCondition, productStockStatus, productDescription,
            JSON.stringify(productImagePaths), phoneNumber, address, inverseFormatCityName(sellerCity) ,
            bankAccountNumber, bankAccountName, saleState, reviewState, verifyState, featureState, slug, userId, productTags, finalProductBrand, moneyBackGuarantee

        ];
            const result = await zingoPool.query(query, values);

            const productId = result.rows[0].id;

            console.log('Inserted product:', result.rows[0]);
            //Generate Tags using FASTAPI. Helper is in addTagHelper.js
        
            // try {
            //     await generateAndUpdateProductTags({
            //         productId,
            //         pool: zingoPool,
            //         fastapiUrl: process.env.NEXT_PUBLIC_FASTAPI
            //     });
            // } catch (tagError) {
            //     // Just log the error and continue
            //     console.error('Warning: Tag generation failed:', tagError.message);
            // }
            
            res.status(200).json({ 
                message: "Successfully Added Product For Review",
                productId: productId
            });
            

        } catch (error) {
            console.error('Error in post-product route:', error);
            res.status(500).json({ error: "An unexpected error occurred" });
        }
    });
});


router.post("/product/increment-views/:productId", async (req, res) => {
    try {
        console.log('==========Increment Views route hit==========')
        const productId = req.params.productId;
        console.log('productId:', productId);
        const query = `
            UPDATE products
            SET views = views + 1
            WHERE id = $1
        `;
        const values = [productId];
        await zingoPool.query(query, values);
        res.status(200).json({ message: "Successfully incremented views" });

    } catch (e) {
        console.error('Error in increment-views route:', e);
        res.status(500).json({ error: "An unexpected error occurred" });
    }
});

module.exports = router;