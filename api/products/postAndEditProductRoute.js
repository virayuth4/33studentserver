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


require('dotenv').config();

const ADMIN_USER_ID = process.env.ADMIN_ID

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_FILES = 13; // 10 images + 3 videos

// Add global error handlers
process.on('uncaughtException', (error) => {
  console.error('=== UNCAUGHT EXCEPTION ===');
  console.error('Error:', error);
  console.error('Stack:', error.stack);
  console.error('========================');
  // Don't exit the process immediately, log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('=== UNHANDLED REJECTION ===');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  console.error('===========================');
});

// // Add memory monitoring
// setInterval(() => {
//   const memUsage = process.memoryUsage();
//   console.log('Memory Usage:', {
//     rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
//     heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
//     heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
//     external: `${(memUsage.external / 1024 / 1024).toFixed(2)} MB`
//   });
// }, 30000); // Log every 30 seconds

// Configure multer storage
// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     // Create directory if it doesn't exist
//     const uploadDir = path.join(__dirname, '../uploads');
//     if (!fs.existsSync(uploadDir)) {
//       fs.mkdirSync(uploadDir, { recursive: true });
//     }
//     cb(null, uploadDir);
//   },
//   filename: function (req, file, cb) {
//     // Generate unique filename with original extension
//     const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
//     const ext = path.extname(file.originalname);
//     cb(null, file.fieldname + '-' + uniqueSuffix + ext);
//   }
// });

// File filter for multer
// const fileFilter = (req, file, cb) => {
//   // Check if file is an image or video
//   if (file.fieldname === 'productImages') {
//     if (file.mimetype.startsWith('image/')) {
//       cb(null, true);
//     } else {
//       cb(new Error('Only image files are allowed for product images!'), false);
//     }
//   } else if (file.fieldname === 'productVideos') {
//     if (file.mimetype.startsWith('video/')) {
//       cb(null, true);
//     } else {
//       cb(new Error('Only video files are allowed for product videos!'), false);
//     }
//   } else {
//     cb(new Error('Unexpected field name'), false);
//   }
// };

// const upload = multer({
//   storage: storage,
//   fileFilter: fileFilter,
//   limits: {
//     fileSize: MAX_FILE_SIZE,
//     files: MAX_FILES
//   }
// });

router.post('/product/editing/:productId', 
  createRateLimiterMiddleware,
  authenticateFirebaseToken,
  (req, res) => {
    upload.fields([
      { name: 'newProductImages', maxCount: 10 },
      { name: 'newProductMedias', maxCount: 3 }
    ])(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        // Handle multer-specific errors
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ 
            error: `File size is too large. Maximum size is 50MB.` 
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ 
            error: `Too many files. Maximum is 11 files (8 images + 3 videos).` 
          });
        }
        return res.status(400).json({ error: err.message });
      } else if (err) {
        return res.status(400).json({ error: err.message });
      }

        console.log("===== Editing Route Hit =====");
        console.log("User Id:", req.user.id);
        console.log("Text data:", req.body);
        console.log("Product Id", req.params)
        const userId = req.user.id;
        console.log("userId", userId);
        const {productId} = req.params
        console.log("productId", productId, typeof(productId))

        

        const client = await zingoPool.connect();
        await client.query('BEGIN');

        // Access the files from multer
        const imageFiles = req.files['newProductImages'] || [];
        const mediaFiles = req.files['newProductMedias'] || [];
        
        console.log(`Received ${imageFiles.length} new images and ${mediaFiles.length} new videos`);

        const {
          productName,
          productPrice, 
          productCondition, 
          productStockStatus, 
          availableQuantity,
          productCategory, 
          productSubCategory,
          productTags,
          productDescription,
          sellerAddress, 
          sellerCity, 
          phoneNumber, 
          bankAccountNumber, 
          bankAccountName, 
          productBrand,
          moneyBackGuarantee, 
          directToSeller,
          isPrivate,
          existingImagePaths,
          existingMediaPaths,
          deletedImagePaths,
          deletedMediaPaths,
        } = req.body;
        console.log("DeletedImagePaths", deletedImagePaths)
        console.log("DeteledVideoPaths", deletedMediaPaths)
        console.log("Complete request body:", JSON.stringify(req.body));
      console.log("Raw productTags from request:", req.body.productTags);
      console.log("productTags type:", typeof req.body.productTags);
      console.log("All form field names:", Object.keys(req.body));
        const _productTags = [productTags]
        console.log("_productTags", _productTags)

        const _deletedImagePaths = JSON.parse(deletedImagePaths || '[]')
        const _deletedMediaPaths = JSON.parse(deletedMediaPaths || '[]')
        const newImageFiles = req.files['newProductImages'] || [];
        const newMediaFiles = req.files['newProductMedias'] || [];
        console.log("new image files", newImageFiles)
        console.log("new media files", newMediaFiles)

  
        // Handle deleted images
        for (const deletedPath of _deletedImagePaths) {
          await deleteFileFromS3(deletedPath);
        }

        for (const deletedPath of _deletedMediaPaths) {
          await deleteFileFromS3(deletedPath)
        }
        const newImagePaths = []
        const newMediaPaths = []

        const [imageUrls, mediaUrls] = await Promise.all([
          uploadMediaFilesToS3(imageFiles, userId, 'image'),
          uploadMediaFilesToS3(mediaFiles, userId, 'video')
        ]);
        newImagePaths.push(...imageUrls);  
        newMediaPaths.push(...mediaUrls)
        
        console.log("newImagePaths", newImagePaths)
        console.log("newMediaPaths", newMediaPaths)

        const _existingImagePaths = JSON.parse(existingImagePaths || '[]');
        const _existingMediaPaths = JSON.parse(existingMediaPaths || '[]');

        const updatedImagePaths = [
          ..._existingImagePaths.filter(path => !_deletedImagePaths.includes(path)), 
          ...newImagePaths
        ];

        console.log("updatedImagePaths", updatedImagePaths);
        
        const updatedMediaPaths = [
          ..._existingMediaPaths.filter(path => !_deletedMediaPaths.includes(path)), 
          ...newMediaPaths
        ];
        const finalProductBrand = productBrand?.trim() || "N/A";
        
        const slug = `/${productCategory.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/
        ${finalProductBrand.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/
        ${productName.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/
        ${Date.now()}`;
        
        console.log("slug", slug)
        console.log("updatedMediaPaths", updatedMediaPaths);
        const _isPrivate = req.body.isPrivate === 'true';
        const _moneyBackGuarantee = req.body.moneyBackGuarantee === 'true';
        const _directToSeller = req.body.directToSeller === 'true';
    
            // Create an object with only the updated fields
        const updatedFields = {
          slug: slug,
          productName: productName,
          productCategory: productCategory,
          productSubCategory: productSubCategory,
          productTags: _productTags,
          sellerCity: sellerCity,
          productPrice: productPrice,
          availableQuantity: availableQuantity,
          productCondition: productCondition,
          productStockStatus: productStockStatus,
          productBrand: productBrand,
          productDescription: productDescription,
          isPrivate: _isPrivate,
          productImagePaths: JSON.stringify(updatedImagePaths),
          productMediaPaths: JSON.stringify(updatedMediaPaths),
          bankAccountNumber: bankAccountNumber,
          bankAccountName: bankAccountName,
          moneyBackGuarantee: _moneyBackGuarantee,
          directToSeller: _directToSeller,
          updatedAt: 'NOW()', // This can be replaced with `new Date().toISOString()` if needed
        };

         // Build the update query dynamically
         let updateQuery = 'UPDATE products SET ';
         const updateValues = [];
         let index = 1;
   
         for (const [key, value] of Object.entries(updatedFields)) {
           updateQuery += `"${key}" = $${index}, `;
           updateValues.push(value);
           index++;
         }
   
         // Remove the trailing ', ' and add the WHERE clause
         updateQuery = updateQuery.slice(0, -2);
         updateQuery += ' WHERE id = $' + index + ' RETURNING *';
         updateValues.push(productId);
   
         const result = await client.query(updateQuery, updateValues);
   
         await client.query('COMMIT');
   
         res.status(200).json({
           message: 'Successfully updated product details',
           data: result.rows[0],
         });

    
    
    })
  }
);

//===========Updated Route to POST PRODUCT
// Updated Product posting route using memory storage NEW [May 2025]
router.post('/product/posting', 
  createRateLimiterMiddleware,
  authenticateFirebaseToken,
  (req, res) => {
    upload.fields([
      { name: 'productImages', maxCount: 10 },
      { name: 'productVideos', maxCount: 3 }
    ])(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        console.error('Multer Error:', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ 
            error: `File size is too large. Maximum size is 50MB.` 
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ 
            error: `Too many files. Maximum is 11 files (8 images + 3 videos).` 
          });
        }
        return res.status(400).json({ error: err.message });
      } else if (err) {
        console.error('Upload Error:', err);
        return res.status(400).json({ error: err.message });
      }

      try {
        console.log("===== Product Posting reached");
        console.log("User Id:", req.user.id);
        console.log("Text data:", req.body);
        const userId = req.user.id;
        console.log("userId", userId);
        
        const {
          productName,
          productPrice, 
          productCondition, 
          productStockStatus, 
          availableQuantity,
          productCategory, 
          productSubCategory,
          productTags,
          sellerAddress, 
          sellerCity, 
          phoneNumber, 
          bankAccountNumber, 
          bankAccountName, 
          productBrand,
          moneyBackGuarantee, 
          isPrivate,
          directToSeller 
        } = req.body;
        
        const productDescription = sanitizeProductDescription(req.body.productDescription);
        const _productTags = [productTags]
        let saleState = true;
        let reviewState = false;
        let verifyState = false;
        let featureState = false;

         const finalProductBrand = productBrand?.trim() || "N/A";

        const slug = `/${productCategory.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/
        ${productCategory.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/
        ${finalProductBrand.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/
        ${productName.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/
        ${Date.now()}`;
        
       

        console.log("productName", productName);
        console.log("final productBrand", finalProductBrand);
        console.log("slug", slug);
        
        // Access the files from multer
        const imageFiles = req.files['productImages'] || [];
        const videoFiles = req.files['productVideos'] || [];
        
        console.log(`Received ${imageFiles.length} images and ${videoFiles.length} videos`);
        
        // Add file size logging
        const totalSize = [...imageFiles, ...videoFiles].reduce((sum, file) => sum + file.size, 0);
        console.log(`Total file size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
        
        // Log individual file details
        imageFiles.forEach((file, index) => {
          console.log(`Image ${index + 1}: ${file.originalname}, Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
        });

        console.log("Starting S3 upload for images...");

        let imageUrls = [];
        let videoUrls = [];

        try {
          imageUrls = await uploadMediaFilesToS3(imageFiles, userId, 'image', {
            convertImages: false, // Explicitly disable conversion
            skipTypeValidation: false
          });
          console.log("S3 upload successful for images:", imageUrls);
       
        } catch (s3Error) {
          console.error("S3 upload failed for images:", s3Error);
  
          throw new Error(`S3 upload failed: ${s3Error.message}`);
        }

        try {
          videoUrls = await uploadMediaFilesToS3(videoFiles, userId, 'video', {
            convertImages: false,
            skipTypeValidation: false
          });
          console.log("S3 upload successful for videos:", videoUrls);
          // logMemoryUsage('After Video Upload');
        } catch (s3Error) {
          console.error("S3 upload failed for videos:", s3Error);
          throw new Error(`S3 upload failed: ${s3Error.message}`);
        }

        console.log("Starting database insertion...");

        // Add database connection check
        try {
          await zingoPool.query('SELECT 1');
          console.log("Database connection verified");
        } catch (dbError) {
          console.error("Database connection failed:", dbError);
          throw new Error(`Database connection failed: ${dbError.message}`);
        }

        // Insert data into PostgreSQL
        const query = `
          INSERT INTO products (
             "productName",  "productCategory","productSubCategory", "productTags","productPrice", 
              "availableQuantity", "productCondition", "productStockStatus", "productDescription", 
              "productImagePaths", "productMediaPaths", "phoneNumber", "sellerAddress", "sellerCity", 
              "bankAccountNumber","bankAccountName", "saleState","reviewState", "verifyState",
              "featureState", "slug","postedBy",  "productBrand", "moneyBackGuarantee", "directToSeller", "isPrivate"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,$15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
          RETURNING id
        `;

        const values = [
          productName, 
          productCategory,  
          productSubCategory,
          _productTags,
          productPrice,
          availableQuantity, 
          productCondition, 
          productStockStatus, 
          productDescription,
          JSON.stringify(imageUrls),
          JSON.stringify(videoUrls),
          phoneNumber, 
          sellerAddress, 
          sellerCity,
          bankAccountNumber, 
          bankAccountName, 
          saleState, 
          reviewState, 
          verifyState, 
          featureState, 
          slug, 
          userId, 
          finalProductBrand, 
          moneyBackGuarantee,
          directToSeller,
          isPrivate
        ];

        console.log("Executing database query with values:", values.map((v, i) => `$${i+1}: ${typeof v === 'object' ? JSON.stringify(v) : v}`));

        const result = await zingoPool.query(query, values);
        const productId = result.rows[0].id;
        console.log('Product inserted successfully with ID:', productId);

        // Return success with the S3 URLs
        return res.status(200).json({
          message: 'Product posted successfully',
          data: {
            productId,
            imageUrls,
            videoUrls
          }
        });
        
      } catch (error) {
        console.error('=== DETAILED ERROR INFO ===');
        console.error('Error type:', error.constructor.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.error('User ID:', req.user?.id);
        console.error('Request body keys:', Object.keys(req.body || {}));
        console.error('Files received:', {
          images: req.files?.['productImages']?.length || 0,
          videos: req.files?.['productVideos']?.length || 0
        });
        console.error('=== END ERROR INFO ===');
        
        return res.status(500).json({
          error: 'Failed to process product upload. Please try again.',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
      }
    });
  }
);

//==============To POST PRODUCT
router.post('/product/posting', 
  createRateLimiterMiddleware,
  authenticateFirebaseToken,
  (req, res) => {
    // Use stricter upload limits
    upload.fields([
      { name: 'productImages', maxCount: 4 }, // Reduced from 10
      { name: 'productVideos', maxCount: 2 }  // Reduced from 3
    ])(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        console.error('Multer Error:', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ 
            error: `File size too large. Maximum is 10MB per file.` 
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ 
            error: `Too many files. Maximum is 6 files total.` 
          });
        }
        return res.status(400).json({ error: err.message });
      } else if (err) {
        return res.status(400).json({ error: err.message });
      }

      try {
        console.log("===== Product Posting Started =====");
        
        // Log initial memory usage
        const initialMemory = process.memoryUsage();
        console.log("Initial memory:", {
          rss: `${(initialMemory.rss / 1024 / 1024).toFixed(2)} MB`,
          heapUsed: `${(initialMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`
        });
        
        const userId = req.user.id;
        console.log("User ID:", userId);
        
        // Extract form data
        const {
          productName, productPrice, productCondition, productStockStatus, 
          availableQuantity, productCategory, productSubCategory, productTags,
          sellerAddress, sellerCity, phoneNumber, bankAccountNumber, 
          bankAccountName, productBrand, moneyBackGuarantee, isPrivate, directToSeller 
        } = req.body;
        
        const productDescription = sanitizeProductDescription(req.body.productDescription);
        const _productTags = [productTags];
        
        // Generate slug
        const slug = `/${productCategory.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${productName.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${Date.now()}`;
        const finalProductBrand = productBrand?.trim() || "N/A";
        
        // Get files
        const imageFiles = req.files['productImages'] || [];
        const videoFiles = req.files['productVideos'] || [];
        
        console.log(`Received ${imageFiles.length} images, ${videoFiles.length} videos`);
        
        // Check total file size
        const totalSize = [...imageFiles, ...videoFiles].reduce((sum, file) => sum + file.size, 0);
        const totalSizeMB = totalSize / 1024 / 1024;
        console.log(`Total upload size: ${totalSizeMB.toFixed(2)} MB`);
        
        // Reject if total size is too large for 1GB server
        if (totalSizeMB > 30) { // Conservative limit
          return res.status(400).json({
            error: `Total file size (${totalSizeMB.toFixed(2)}MB) too large. Please reduce file sizes or upload fewer files.`
          });
        }
        
        console.log("Starting sequential uploads...");
        
        // Upload images sequentially
        const imageUrls = await uploadFilesSequentially(imageFiles, userId, 'image');
        console.log(`Uploaded ${imageUrls.length}/${imageFiles.length} images`);
        
        // Upload videos sequentially  
        const videoUrls = await uploadFilesSequentially(videoFiles, userId, 'video');
        console.log(`Uploaded ${videoUrls.length}/${videoFiles.length} videos`);
        
        // Clear file buffers from memory
        [...imageFiles, ...videoFiles].forEach(file => {
          if (file.buffer) file.buffer = null;
        });
        
        // Force garbage collection before database operation
        if (global.gc) global.gc();
        
        console.log("Starting database insertion...");
        
        // Database insertion
        const query = `
          INSERT INTO products (
             "productName", "productCategory", "productSubCategory", "productTags", "productPrice", 
              "availableQuantity", "productCondition", "productStockStatus", "productDescription", 
              "productImagePaths", "productMediaPaths", "phoneNumber", "sellerAddress", "sellerCity", 
              "bankAccountNumber", "bankAccountName", "saleState", "reviewState", "verifyState",
              "featureState", "slug", "postedBy", "productBrand", "moneyBackGuarantee", "directToSeller", "isPrivate"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
          RETURNING id
        `;

        const values = [
          productName, productCategory, productSubCategory, _productTags, productPrice,
          availableQuantity, productCondition, productStockStatus, productDescription,
          JSON.stringify(imageUrls), JSON.stringify(videoUrls), phoneNumber, 
          sellerAddress, sellerCity, bankAccountNumber, bankAccountName, 
          true, false, false, false, slug, userId, finalProductBrand, 
          moneyBackGuarantee, directToSeller, isPrivate
        ];

        const result = await zingoPool.query(query, values);
        const productId = result.rows[0].id;
        
        console.log('Product inserted successfully:', productId);
        
        // Final memory check
        const finalMemory = process.memoryUsage();
        console.log("Final memory:", {
          rss: `${(finalMemory.rss / 1024 / 1024).toFixed(2)} MB`,
          heapUsed: `${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`
        });
        
        return res.status(200).json({
          message: 'Product posted successfully',
          data: {
            productId,
            imageUrls,
            videoUrls,
            uploadStats: {
              imagesUploaded: imageUrls.length,
              videosUploaded: videoUrls.length,
              totalSizeMB: totalSizeMB.toFixed(2)
            }
          }
        });
        
      } catch (error) {
        console.error('=== Product Upload Error ===');
        console.error('Error:', error.message);
        console.error('Memory at error:', process.memoryUsage());
        
        return res.status(500).json({
          error: 'Failed to process product upload. Server may be overloaded.',
          suggestion: 'Try uploading fewer or smaller files.'
        });
      }
    });
  }
);


router.post("/products/update-available-quantity", authenticateFirebaseToken, async (req, res) => {
  console.log("===========Update Available Quantity Route Hit ==========")
  const {productId, quantity} = req.body
  console.log("ProductId", productId, typeof(productId))
  console.log("New quantity", quantity, typeof(quantity))
  
  try {
    await zingoPool.query('BEGIN');
    
    // Determine stock status based on quantity
    const stockStatus = quantity === 0 ? "Out of Stock" : "In Stock";
    console.log("New stock status", stockStatus);
    
    const updateAvailableQuantityQuery =
    `
      UPDATE products 
        SET "availableQuantity" = $1,
            "productStockStatus" = $2
        WHERE "id" = $3
    `;
  
    await zingoPool.query(updateAvailableQuantityQuery, [quantity, stockStatus, productId]);
    await zingoPool.query('COMMIT');
    
    res.status(200).json({
      success: true,
      message: "Product quantity updated successfully",
      updatedQuantity: quantity,
      stockStatus: stockStatus
    });
    
  } catch (e) {
    await zingoPool.query('ROLLBACK');
    console.error(`Error with updating available quantity: `, e)
    res.status(500).json({message: "Error with updating available quantity"})
  }
});

//=======================Route to edit product form ====================================
router.post(
    '/product/edit',
    createRateLimiterMiddleware,
    authenticateFirebaseToken,
    upload.array('newImages'), // 'newImages' should match the field name in your FormData
    async (req, res) => {
      const client = await zingoPool.connect();
      try {
        console.log('/product/edit route hit');
        console.log('req.body:', req.body);
        await client.query('BEGIN');
        
        // Access form fields
        const formData = req.body;
  
        // Access uploaded files
        const newFiles = req.files;
  
        // Parse JSON strings back to arrays
        const existingImagePaths = JSON.parse(formData.existingImagePaths || '[]');
        const deletedImagePaths = JSON.parse(formData.deletedImagePaths || '[]');
  
        // Handle deleted images
        for (const deletedPath of deletedImagePaths) {
          await deleteFileFromS3(deletedPath);
        }
  
        // Upload new images to S3 and add their paths to the existingImagePaths
        const newImagePaths = [];
        if (newFiles && newFiles.length > 0) {
            for (let file of newFiles) {
                const timestamp = Date.now();
                const sanitizedName = sanitizeFileName(file.originalname);
                const fileName = `product-images/sales/${timestamp}_${sanitizedName}`;
                
                // Use the URL returned from uploadFileToS3
                const imagePath = await uploadFileToS3(file, fileName);
                newImagePaths.push(imagePath);
            }
        }
  
        // Combine existing (non-deleted) and new image paths
        const finalImagePaths = [
          ...existingImagePaths.filter((path) => !deletedImagePaths.includes(path)),
          ...newImagePaths,
        ];
  
        const productId = formData.id;
        console.log('formData.productBrand:', formData.productBrand);

        // Attempt to generate product tags
        let newProductTags;
        try {
          newProductTags = await generateAndUpdateProductTags({
            productId,
            pool: zingoPool,
            fastapiUrl: process.env.NEXT_PUBLIC_FASTAPI,
          });
        } catch (tagError) {
          // Log the error and continue
          console.error('Warning: Tag generation failed:', tagError.message);
        }
  
        // Create an object with only the updated fields
        const updatedFields = {
          productName: formData.productName,
          productCategory: formData.productCategory,
          sellerCity: formData.sellerCity,
          productPrice: formData.productPrice,
          availableQuantity: formData.availableQuantity,
          productCondition: formData.productCondition,
          productStockStatus: formData.productStockStatus,
          productBrand: formData.productBrand,
          productDescription: formData.productDescription,
          productImagePaths: JSON.stringify(finalImagePaths),
          bankAccountNumber: formData.bankAccountNumber,
          bankAccountName: formData.bankAccountName,
          moneyBackGuarantee: formData.moneyBackGuarantee,
          updatedAt: 'NOW()', // This can be replaced with `new Date().toISOString()` if needed
        };
  
        // Include productTags only if newProductTags exists
        if (newProductTags) {
          updatedFields.productTags = newProductTags;
        }
  
        // Build the update query dynamically
        let updateQuery = 'UPDATE products SET ';
        const updateValues = [];
        let index = 1;
  
        for (const [key, value] of Object.entries(updatedFields)) {
          updateQuery += `"${key}" = $${index}, `;
          updateValues.push(value);
          index++;
        }
  
        // Remove the trailing ', ' and add the WHERE clause
        updateQuery = updateQuery.slice(0, -2);
        updateQuery += ' WHERE id = $' + index + ' RETURNING *';
        updateValues.push(formData.id);
  
        const result = await client.query(updateQuery, updateValues);
  
        await client.query('COMMIT');
  
        res.status(200).json({
          message: 'Successfully updated product details',
          data: result.rows[0],
        });
      } catch (error) {
        console.error('Error in /product/edit:', error);
        res.status(500).json({
          message: 'Error updating product',
          error: error.message,
        });
      } finally {
        client.release();
      }
    }
  );



module.exports = router