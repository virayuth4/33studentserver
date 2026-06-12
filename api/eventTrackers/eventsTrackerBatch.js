const express = require("express");
const zingoPool = require("../../database/pgZingo");
const { processUserPreferencesWithScoring } = require("../../algorithms/processUserPreferences");
const router = express.Router();


// Updated route handler - replace your existing one
// Import the preference system at the top of your file


router.post('/event/tracker/batch', async (req, res) => {
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
    const { type, data, timestamp } = event;
    console.log(`Processing event: ${type} at ${timestamp}`);
    console.log("Event data:", data);
    console.log("Event Type", type)

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
    UPDATE products
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
      if (type === 'productClick' && userId) {
        try {
          // Pass zingoPool to the function
          await processUserPreferencesWithScoring(userId, dataToSubmit, zingoPool);
        } catch (prefError) {
          console.error(`Error processing preferences for user ${userId}:`, prefError);
          // Don't fail the entire batch if preference processing fails
        }
      }
  
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