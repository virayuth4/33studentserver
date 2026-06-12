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
// use in the main website 33 student
router.post('/33student/product/posting', 
  createRateLimiterMiddleware,
  authenticateFirebaseToken,
  (req, res) => {
    upload.fields([
      { name: 'productImages', maxCount: 10 },
      { name: 'productVideos', maxCount: 3 }
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

      try {
        console.log("===== 1 Product Posting reached");
        const userId = req.user?.uid || req.user?.user_id;
        
        console.log("Text data:", req.body);
        console.log("req.user:", req.user);
        console.log("userId", userId);
        
        
        const {
          productName,
          productCondition, 
          variants,
          sizingGuide,
          productCategory, 
          productSubCategory,
          productTags,
          sellerAddress, 
          sellerCity, 
          phoneNumber, 
          bankAccountNumber, 
          bankAccountName, 
          productBrand,
          countryOfOrigin,
          moneyBackGuarantee, 
          isPrivate,
          directToSeller,
          paymentMethods, 
          gender,
          sizingMeasurements
        } = req.body;
        
        const productDescription = sanitizeProductDescription(req.body.productDescription);
        const _productTags = [productTags]
        let saleState = true;
        let reviewState = false;
        let verifyState = false;
        let featureState = false;
        let productStockStatus = "In Stock";
        let sellerName = "Admin"
     // 1. Fallback defaults
let productPrice = 1; 
let totalAvailableQuantity = 1; 

let discountedPrice = null;
let discountPercentage = null;

// 2. Parse variants and calculate prices
if (variants) {
  const parsedVariants = typeof variants === 'string' ? JSON.parse(variants) : variants;
  
  // Extract normal prices to find the baseline price
  const basePrices = parsedVariants
    .map(v => parseFloat(v.price))
    .filter(p => !isNaN(p) && p > 0);

  if (basePrices.length > 0) {
    productPrice = Math.min(...basePrices); // Lowest base price
  }

  // Extract discounted prices
  const discountedPrices = parsedVariants
    .map(v => parseFloat(v.discountedPrice))
    .filter(p => !isNaN(p) && p > 0);

  const discountPercentages = parsedVariants
    .map(v => parseFloat(v.discountPercentage))
    .filter(p => !isNaN(p) && p > 0);

  if (discountedPrices.length > 0) {
    discountedPrice = Math.min(...discountedPrices); 
    
    // CRITICAL FIX: If a discount exists, make the primary search price 
    // reflect the discounted price so sorting/filtering works accurately.
    productPrice = discountedPrice; 
  }
  
  if (discountPercentages.length > 0) {
    discountPercentage = Math.max(...discountPercentages); 
  }
}
                
      const slug = `/${productCategory.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${productBrand.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${productName.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${Date.now()}`;

       const finalProductBrand = productBrand?.trim() || "n/a";


        console.log("productName", productName);
        console.log("variants", variants);
        console.log("sizing guide", sizingGuide);
        
        // Access the files from multer
        const imageFiles = req.files['productImages'] || [];
        const videoFiles = req.files['productVideos'] || [];
        
        console.log(`Received ${imageFiles.length} images and ${videoFiles.length} videos`);
        
     
        const imageUrls = await uploadMediaFilesToS3(imageFiles, userId, 'image', {pathPrefix:'1464/products'});
        const videoUrls = await uploadMediaFilesToS3(videoFiles, userId, 'video', {pathPrefix:'1464/products '});
        // Combine images and videos into one media array
 
        
        console.log("Image URLs:", imageUrls);
        console.log("Video URLs:", videoUrls);


        // Insert data into PostgreSQL
        const query = `
          INSERT INTO "33products" (
             "productName",  "productCategory","productSubCategory", "productTags","productPrice", 
              "totalAvailableQuantity", "productCondition", "productStockStatus", "productDescription", 
              "productImagePaths", "productMediaPaths", "sellerPhoneNumber", "sellerAddress", "sellerCity", 
              "bankAccountNumber","bankAccountName", "saleState","isReviewed", "isVerified",
              "isFeatured", "slug","postedBy",  "productBrand", "moneyBackGuarantee", "directToSeller", "isPrivate", "sellerName", "productVariants",
              "paymentMethods", "countryOfOrigin", "productSizingGuide", "gender", "productSizingMeasurements"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,$15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
          RETURNING id
        `;

        const values = [
          productName, 
          productCategory,  
          productSubCategory,
          _productTags,
          productPrice,
          totalAvailableQuantity, 
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
          isPrivate,
          sellerName,
          variants,
          paymentMethods,
          countryOfOrigin,
          sizingGuide,
          gender,
          sizingMeasurements
        ];

        const result = await zingoPool.query(query, values);
        const productId = result.rows[0].id;
        console.log('Inserted product:', result.rows[0]);

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
        console.error('Error processing product upload:', error);
        return res.status(500).json({
          error: 'Failed to process product upload. Please try again.'
        });
      }
    });
  }
);

router.post('/33products/product/editing/:productId', 
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

        console.log("===== 33 Editing Route Hit =====");
        console.log("User Id:", req.user.id);
        console.log("Text data:", req.body);
        console.log("Product Id", req.params)
        const userId = req.user?.uid || req.user?.user_id;
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
          productCondition, 
          productStockStatus, 
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
          countryOfOrigin,
          moneyBackGuarantee, 
          directToSeller,
          isPrivate,
          existingImagePaths,
          existingMediaPaths,
          deletedImagePaths,
          deletedMediaPaths,
          sizingGuide,
          variants,
          gender,
          sizingMeasurements
        } = req.body;
      //   console.log("DeletedImagePaths", deletedImagePaths)
      //   console.log("DeteledVideoPaths", deletedMediaPaths)
      //   console.log("Complete request body:", JSON.stringify(req.body));
      // console.log("Raw productTags from request:", req.body.productTags);
      // console.log("productTags type:", typeof req.body.productTags);
      // console.log("All form field names:", Object.keys(req.body));
      console.log("req body:", req.body)
      const _productTags = [productTags]
      console.log("_productTags", _productTags)

    let productPrice = 1; // Default fallback
    let availableQuantity = 1; // Default fallback
    let processedVariants = null;
    let productGender = gender || 'men';

let discountedPrice = null;
let discountPercentage = null;

if (variants && variants.length > 0) {
  // Parse variants if they come as string
  const parsedVariants = typeof variants === 'string' ? JSON.parse(variants) : variants;

  // Convert string values to numbers and validate
  processedVariants = parsedVariants.map(variant => ({
    ...variant,
    productPrice: parseFloat(variant.productPrice) || 0,
    availableQuantity: parseInt(variant.availableQuantity) || 0,
    discountedPrice: variant.discountedPrice !== undefined && variant.discountedPrice !== ''
      ? parseFloat(variant.discountedPrice)
      : null,
    discountPercentage: variant.discountPercentage !== undefined && variant.discountPercentage !== ''
      ? parseFloat(variant.discountPercentage)
      : null,
  }));

  // Extract all base prices and find the lowest (base price)
  const prices = processedVariants
    .map(variant => variant.productPrice)
    .filter(price => !isNaN(price) && price > 0);

  if (prices.length > 0) {
    productPrice = Math.min(...prices);
  }

  // Sum all available quantities
  const quantities = processedVariants
    .map(variant => variant.availableQuantity)
    .filter(qty => !isNaN(qty) && qty >= 0);

  if (quantities.length > 0) {
    availableQuantity = quantities.reduce((sum, qty) => sum + qty, 0);
  }

  // Extract discounted prices / percentages
  const discountedPrices = processedVariants
    .map(v => v.discountedPrice)
    .filter(p => p !== null && !isNaN(p) && p > 0);

  const discountPercentages = processedVariants
    .map(v => v.discountPercentage)
    .filter(p => p !== null && !isNaN(p) && p > 0);

  if (discountedPrices.length > 0) {
    discountedPrice = Math.min(...discountedPrices);
    // Reflect discounted price in the primary search/sort price
    productPrice = discountedPrice;
  }

  if (discountPercentages.length > 0) {
    discountPercentage = Math.max(...discountPercentages);
  }

  console.log("Processed variants - Base price:", productPrice, "Total quantity:", availableQuantity, "Discounted price:", discountedPrice, "Discount %:", discountPercentage);
} else {
  console.log("No variants provided, using default values");
}

        const _deletedImagePaths = JSON.parse(deletedImagePaths || '[]')
        const _deletedMediaPaths = JSON.parse(deletedMediaPaths || '[]')
        const newImageFiles = req.files['newProductImages'] || [];
        const newMediaFiles = req.files['newProductMedias'] || [];
        // console.log("new image files", newImageFiles)
        // console.log("new media files", newMediaFiles)

  
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

        // console.log("updatedImagePaths", updatedImagePaths);
        
        const updatedMediaPaths = [
          ..._existingMediaPaths.filter(path => !_deletedMediaPaths.includes(path)), 
          ...newMediaPaths
        ];
        const slug = `/${productCategory.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${productBrand.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${productName.replace(/\s+/g, '-').replace(/,/g, '').toLowerCase()}/${Date.now()}`;

        // console.log("slug", slug)
        // console.log("updatedMediaPaths", updatedMediaPaths);
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
  totalAvailableQuantity: availableQuantity,
  productCondition: productCondition,
  productStockStatus: productStockStatus,
  productBrand: productBrand,
  countryOfOrigin: countryOfOrigin,
  productDescription: productDescription,
  isPrivate: _isPrivate,
  productImagePaths: JSON.stringify(updatedImagePaths),
  productMediaPaths: JSON.stringify(updatedMediaPaths),
  bankAccountNumber: bankAccountNumber,
  bankAccountName: bankAccountName,
  moneyBackGuarantee: _moneyBackGuarantee,
  directToSeller: _directToSeller,
  productVariants: JSON.stringify(processedVariants ?? variants),
  productSizingGuide: sizingGuide,
  gender: productGender,
  productSizingMeasurements: sizingMeasurements,
  discountedPrice: discountedPrice,
  discountPercentage: discountPercentage,
  updatedAt: 'NOW()',
};

         // Build the update query dynamically
         let updateQuery = 'UPDATE "33products" SET ';
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

router.post('/1464/product/isSold/status/update/:productId', authenticateFirebaseToken, async (req, res) => {
  console.log('===== 1464 isSold Status Update Reached =====');
  
  try {
    const userId = req.user.id;
    console.log("User ID:", userId);
    
    const { productId } = req.params;
    console.log("Product ID:", productId);
    
    const { isSold } = req.body;
    console.log("New isSold status:", isSold);
    
    // Validate
    if (typeof isSold !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        message: 'isSold must be a boolean value' 
      });
    }
    
  const query = `UPDATE "1464_products" SET "isSold" = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING *`;
  const result = await zingoPool.query(query, [isSold, productId]);
    
    res.status(200).json({ 
      success: true, 
      message: 'Product sold status updated',
      productId: productId,
      isSold: isSold
    });
    
  } catch (error) {
    console.error("Error updating product status:", error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update product status',
      error: error.message 
    });
  }
});

router.post(
  '/1464/products/:productId/variants',
  authenticateFirebaseToken,
  async (req, res) => {
    console.log('===== PATCH variant quantity reached =====');
 
    const { productId } = req.params;
    const userId = req.user?.id || req.user?.userId;
    const { color, size, availableQuantity } = req.body;
 
    // ── Validate input ───────────────────────────────────────────────────
    if (availableQuantity === undefined || availableQuantity === null) {
      return res.status(400).json({ message: 'availableQuantity is required' });
    }
 
    const newQty = parseInt(availableQuantity);
    if (isNaN(newQty) || newQty < 0) {
      return res.status(400).json({ message: 'availableQuantity must be a non-negative integer' });
    }
 
    if (!color && !size) {
      return res.status(400).json({ message: 'At least one of color or size is required to identify the variant' });
    }
 
    const client = await zingoPool.connect();
    try {
      await client.query('BEGIN');
 
      // ── Fetch current product (verify ownership) ─────────────────────
      const fetchResult = await client.query(
        `SELECT "productVariants", "postedBy" FROM "1464_products" WHERE id = $1`,
        [productId]
      );
 
      if (fetchResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Product not found' });
      }
 
      const product = fetchResult.rows[0];
 
      // Only the owner (or admin) can update stock
      if (String(product.postedBy) !== String(userId) && String(userId) !== String(ADMIN_USER_ID)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: 'Not authorised to update this product' });
      }
 
      // ── Parse variants ───────────────────────────────────────────────
      let variants = product.productVariants;
      if (typeof variants === 'string') {
        try { variants = JSON.parse(variants); } catch {
          await client.query('ROLLBACK');
          return res.status(500).json({ message: 'Failed to parse productVariants' });
        }
      }
 
      if (!Array.isArray(variants) || variants.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'This product has no variants' });
      }
 
      // ── Find the target variant (match color AND/OR size) ────────────
      let matched = false;
      const updatedVariants = variants.map(v => {
        const colorMatch = color ? String(v.color).toLowerCase() === String(color).toLowerCase() : true;
        const sizeMatch  = size  ? String(v.size).toLowerCase()  === String(size).toLowerCase()  : true;
 
        if (colorMatch && sizeMatch) {
          matched = true;
          return { ...v, availableQuantity: String(newQty) };
        }
        return v;
      });
 
      if (!matched) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: `Variant not found (color: ${color}, size: ${size})` });
      }
 
      // ── Recalculate totalAvailableQuantity ───────────────────────────
      const newTotal = updatedVariants.reduce(
        (sum, v) => sum + (parseInt(v.availableQuantity) || 0),
        0
      );
 
      // ── Persist ──────────────────────────────────────────────────────
      const updateResult = await client.query(
        `UPDATE "1464_products"
         SET "productVariants" = $1,
             "totalAvailableQuantity" = $2,
             "updatedAt" = NOW()
         WHERE id = $3
         RETURNING id, "productVariants", "totalAvailableQuantity"`,
        [JSON.stringify(updatedVariants), newTotal, productId]
      );
 
      await client.query('COMMIT');
 
      console.log(`Variant (color:${color} size:${size}) qty → ${newQty}, total → ${newTotal}`);
 
      return res.status(200).json({
        message: 'Variant quantity updated successfully',
        data: {
          productId,
          color,
          size,
          availableQuantity: newQty,
          totalAvailableQuantity: newTotal,
          productVariants: updateResult.rows[0].productVariants,
        },
      });
 
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating variant quantity:', error);
      return res.status(500).json({
        message: 'Failed to update variant quantity',
        error: error.message,
      });
    } finally {
      client.release();
    }
  }
);

module.exports = router;