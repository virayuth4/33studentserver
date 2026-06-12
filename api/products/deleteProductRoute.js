const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');
const {uploadFileToS3, deleteFileFromS3, moveFileInS3} = require("../../database/s3")
const authenticateFirebaseToken = require("../../auth/authFirebaseToken")
const axios = require('axios');
const { generateAndUpdateProductTags } = require("../../helper/productRoutesHelper/addTagHelper");
const createRateLimiterMiddleware = require("../rateLimiter");


router.post('/product/delete/soft/:productId', authenticateFirebaseToken, async(req,res) => {
    console.log('/soft delete product route hit')
    const userId = req.user.id
    try {
        const {productId} = req.params
        const intProductId = parseInt(productId)
        
        // First, get the product details including image paths
        const productQuery = `
            SELECT "postedBy", "productImagePaths"
            FROM products
            WHERE "id" = $1 AND "isDeleted" = false
        `;
        const productResult = await zingoPool.query(productQuery, [intProductId]);
        
        if (productResult.rowCount === 0) {
            return res.status(404).json({ message: "Product not found" });
        }
        
        const product = productResult.rows[0];
        console.log('product', product)

        if (product.postedBy !== userId) {
            console.error(`User doesn't have the permission to delete this post`)
            return res.status(403).json({ message: "You don't have permission to delete this product" });
        }

        // Move each image to the archived folder
        const archivedImagePaths = [];
        if (product.productImagePaths && Array.isArray(product.productImagePaths)) {
          for (const imagePath of product.productImagePaths) {
            try {
              // Extract the source key (everything after .amazonaws.com/)
              const sourceKey = imagePath.split('.amazonaws.com/')[1];
              console.log('Original URL:', imagePath);
              console.log('Extracted source key:', sourceKey);
      
              if (!sourceKey) {
                console.error(`Invalid image path: ${imagePath}`);
                continue;
              }
      
              // Get just the filename
              const fileName = sourceKey.split('/').pop();
              console.log('Extracted filename:', fileName);
              
              // Create new path in archived folder
              const destinationKey = `archived-images/${fileName}`;
              
              const newPath = await moveFileInS3(
                sourceKey,
                destinationKey,
              );
              
              console.log('File moved successfully');
              console.log('New URL:', newPath);
              archivedImagePaths.push(newPath);
              console.log('Updated archivedImagePaths:', archivedImagePaths);
            } catch (error) {
              console.error(`Failed to move image ${imagePath}:`, error);
              console.error('Error details:', error.message);
            }
          }
        }
    
        // Log the array before update for debugging
        // console.log('Archived image paths:', archivedImagePaths);
        console.log('Final Archived image paths:', archivedImagePaths);

        console.log('Type of archivedImagePaths:', typeof archivedImagePaths);
        // console.log('archivedImagePaths:', archivedImagePaths);
        const jsonbImagePaths = JSON.stringify(archivedImagePaths);
        // Update the product with new image paths and mark as deleted
        const deleteQuery = `
            UPDATE products
            SET
                "isDeleted" = TRUE,
                "deletedAt" = CURRENT_TIMESTAMP,
                "productImagePaths" = COALESCE($3::jsonb, '[]'::jsonb)
            WHERE
                "postedBy" = $1
                AND "id" = $2
                AND "isDeleted" = false
            RETURNING *
        `;
        
        const deleteResult = await zingoPool.query(deleteQuery, [
            userId, 
            intProductId,
            jsonbImagePaths
        ]);


        

        if (deleteResult.rowCount === 0) {
            console.error('No product found with the given productId')
            return res.status(404).json({ 
                error: "Product not found or already deleted" 
            });
        }

        res.status(200).json({
            message: "Product deleted successfully",
            deletedProduct: deleteResult.rows[0]
        });
    } catch (error) {
        console.error('Error with deleting product:', error);
        res.status(500).json({
            error: "An error occurred while deleting product"
        });
    }
});

module.exports = router