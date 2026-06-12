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


router.post('/1464/products/views/batch', async (req, res) => {
  console.log("======Product Views Batch ======");
  console.log(req.body);
  const { productIds } = req.body;
  if (!productIds || !Array.isArray(productIds)) {
    return res.status(400).json({
      message: "Invalid request format. Expected 'productIds' array.",
    });
  }
  const updateQuery = `
    UPDATE "1464_products"
    SET views = views + 1
    WHERE id = ANY($1::int[])
  `;
  try {
    const updateResult = await zingoPool.query(updateQuery, [productIds]);
    console.log(`Views updated for ${updateResult.rowCount} products.`);
    res.status(200).json({
      message: "Product views updated successfully",
      updatedCount: updateResult.rowCount,
    });
  } catch (error) {
    console.error("Error updating product views:", error);
    res.status(500).json({ message: "An error occurred while updating product views." });
  }
});

router.post('/1464/event/tracker/batch', async (req, res) => {
  console.log("======Event Tracker Batch ======");
  console.log(req.body);
  
  const { events } = req.body;
  
  if (!events || !Array.isArray(events)) {
    return res.status(400).json({
      message: "Invalid request format. Expected 'events' array.",
    });
  }
  
  // Process each event in the batch
  for (const event of events) {
    const { type, data, timestamp, origin } = event;
    console.log(`Processing event: ${type} at ${timestamp}`);
    console.log("Event data:", data);
    console.log("Event Type", type)
    console.log("Origin", origin)

    // Make sure data and productId exist
    if (!data || !data.productId) {
      console.log("Missing data or productId in event:", event);
      continue;
    }

    // Extract userId from data object
    const userId = data.userId;

    // Update product views
    const updateQuery = 
    `
    UPDATE "1464_products"
    SET views = views + 1
    WHERE id = $1 
    `
    const updateResult = await zingoPool.query(updateQuery, [data.productId]);
    
    if (updateResult.rowCount === 0) {
      console.log(`No product found with ID: ${data.productId}`);
      continue;
    }
    console.log(`Views of Product ID ${data.productId} updated successfully.`);
    
    // Insert event into event_tracker_history
    const insertQuery = `
      INSERT INTO event_tracker_history ("userId", "eventType", "productId", "timestamp", "eventData")
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    // Extract additional data (excluding the main fields we're storing separately)
    const additionalData = { ...data };
    delete additionalData.productId; // Remove since we're storing it in its own column
    const dataToSubmit = Object.keys(additionalData).length > 0 ? JSON.stringify(additionalData) : null
    
    try {
      await zingoPool.query(insertQuery, [
        userId || null, // Handle case where userId might not exist
        type,
        data.productId,
        timestamp || new Date().toISOString(),
        dataToSubmit
      ]);
      
      console.log(`Event tracked in history for user: ${userId}, product: ${data.productId}. Event Type ${type}`);
      
      // Process user preferences with scoring (only for productClick events and when userId exists)
      // if (type === 'productClick' && userId) {
      //   try {
      //     // Pass zingoPool to the function
      //     await processUserPreferencesWithScoring(userId, dataToSubmit, zingoPool);
      //   } catch (prefError) {
      //     console.error(`Error processing preferences for user ${userId}:`, prefError);
      //     // Don't fail the entire batch if preference processing fails
      //   }
      // }
  
    } catch (error) {
      console.error(`Error inserting event into history:`, error);
      // Continue processing other events even if one fails
    }
  }
 
  res.status(200).json({
    message: "Event batch processed successfully",
    count: events.length,
  });
});


module.exports = router