const express = require("express");
const router = express.Router();
const zingoPool = require("../database/pgZingo");
const multer = require('multer');
const {uploadFileToS3, deleteFileFromS3, moveFileInS3} = require("../database/s3")
const authenticateFirebaseToken = require("../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("./rateLimiter");
const { GetRandomProducts } = require("../algorithms/randomProduct");
const { UserPreferences } = require("../algorithms/userPreferences");
const { getUserInteractions, calculatePreferenceScores, calculateProductMatchScore } = require("../algorithms/processUserPreferences");

require('dotenv').config();

const ADMIN_USER_ID = process.env.ADMIN_ID


//products_sale database "zingoPool"

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

const sanitizeFileName = (fileName) => {
    return fileName
        .toLowerCase() // Convert to lowercase
        .replace(/\s+/g, '_') // Replace spaces with underscore
        .replace(/[^a-z0-9._-]/g, '') // Remove all special characters except dots, underscores, and hyphens
};

async function sendRequestRestockToSupportTelegramNotification(productName, requestedUserId, moreInfo) {
    const message = 
  `📦 *Restock Request Notification*
  
  *Product:* ${productName}
  *Requested By (User ID):* ${requestedUserId}
  *Additional Info:* ${moreInfo || 'N/A'}`;
  
    console.log('Sending restock request to Telegram with message:', message);
  
    try {
      const botToken = String(process.env.TELEGRAM_SUPPORT_BOT_TOKEN.trim());
      const chatId = Number(process.env.TELEGRAM_CHAT_ID.trim());
  
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      console.log('Telegram API URL:', url);
      
      await axios.post(url, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      });
  
      console.log('Telegram notification sent successfully');
      return { success: true };
    } catch (error) {
      console.error('Error sending Telegram notification:', error.message);
      return { success: false, error: error.message };
    }
  }
  





//-----------------------------------Route to SOFT Delete Post ----------------------------------
router.post('/soft-delete-product/:productId', authenticateFirebaseToken, async (req, res) => {
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
            } catch (error) {
              console.error(`Failed to move image ${imagePath}:`, error);
              console.error('Error details:', error.message);
            }
          }
        }

        // Log the array before update for debugging
        console.log('Archived image paths:', JSON.stringify(archivedImagePaths));

        // Update the product with new image paths and mark as deleted
        const deleteQuery = `
            UPDATE products
            SET
                "isDeleted" = TRUE,
                "deletedAt" = CURRENT_TIMESTAMP,
                "productImagePaths" = $3
            WHERE
                "postedBy" = $1
                AND "id" = $2
                AND "isDeleted" = false
            RETURNING *
        `;
        
        const deleteResult = await zingoPool.query(deleteQuery, [
            userId, 
            intProductId,
            JSON.stringify(archivedImagePaths)
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

//--------------------------------Route for admin to get all the products for the review--------------------------------------------------
router.get('/all-products-for-review', authenticateFirebaseToken, async (req,res) => {
    console.log('/all-products-for-review route hit')
    try {
        const query = `
        SELECT id, "productName", "productCategory", "phoneNumber", "productPrice", "availableQuantity, "productDescription", 
        "productImagePaths", "saleState", "reviewState", "verifyState", "featureState", "slug", "postedBy", "isDeleted", "createdAt"
        FROM products
        WHERE "reviewState" = false
        AND "isDeleted" = false
        ORDER BY id DESC
        `;

        const result = await zingoPool.query(query);

        if (result.rows.length === 0) {
            return res.status(200).json({
                message: "No products pending review",
                products: []
            });
            
        }

        res.status(200).json({
            products: result.rows
        });

    } catch(error) {
        console.error("Error with fetching all products for review")
        res.status(500).json({
            error: "An error occurred while fetching products for review"
        })
    }
})

//-------------------------------Route to display all the products in the homepage ----------------------------------------------------
router.get('/all-featured-products', async(req,res) => {
    console.log('all-reviewed-products route hit')
    try {

        const query = `
       SELECT id, "productName", "productCategory", "phoneNumber", "productPrice", "availableQuantity", "productDescription", 
        "productImagePaths", "saleState", "reviewState", "verifyState", "featureState", "slug", "postedBy", "isDeleted", "createdAt"
        FROM products
        WHERE "isDeleted" = false
        AND "featureState" = true
        ORDER BY id DESC
        `;

        const result = await zingoPool.query(query)

        if (result.rows.length === 0) {
            return res.status(200).json({
                message: "No featured products",
                products: []
            });
        }

        res.status(200).json({
            products: result.rows
        })

    } catch (error) {
        console.error("Error with fetching all products for review")
        res.status(500).json({
            error: "An error occurred while fetching products for review"
        })
    }
})

router.post('/products/single', authenticateFirebaseToken, async (req, res) => {
    console.log('/products single route hit');
    const userId = req.user.id;
    console.log('req body', req.body)
    console.log('user id', userId)

    const items = req.body.items || [];
    const productIds = items.map(item => item.productIds);
    const purchasedQuantity = items.map(item => parseInt(item.purchasedQuantity, 10));

    console.log('productIds', productIds, 'type', typeof(productIds))
    console.log("purchasedQuantities",purchasedQuantity, typeof(purchasedQuantity))
    console.log('user id', userId)
    console.log('productId', productIds, 'purchasedQuantity', purchasedQuantity, 'user id', userId);

    if (!productIds || !purchasedQuantity) {
        console.error("Missing productId or purchasedQuantity");
        return res.status(400).json({ error: 'Missing productId or purchasedQuantity' });
    }

    try {
        // Step 2: Get the product details based on productId
        const query = `
            SELECT p.id, p."productName", p."productCategory", p."phoneNumber", p."productPrice", p."discountedPrice",
                   p."availableQuantity", p."productDescription", p."productImagePaths", 
                   p."saleState", p."reviewState", p."verifyState", p."featureState", 
                   p."slug", p."postedBy", p."isDeleted", p."createdAt"
            FROM products p
           WHERE p.id = ANY($1::int[]) AND p."isDeleted" = false
        `;

        const productResult = await zingoPool.query(query, [productIds]);

        if (productResult.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found or already deleted' });
        }

        console.log('productResult', productResult.rows);

        // Create a list with product details and purchasedQuantity
        const productList = productResult.rows.map((product, index) => ({
            ...product,
            purchasedQuantity: purchasedQuantity[index]
        }));
        res.status(200).json({ products: productList });
    } catch (error) {
        console.error('Error fetching product details:', error);
        res.status(500).json({ error: 'An error occurred while fetching product details' });
    }
});

router.post('/products/batch', authenticateFirebaseToken, async(req, res) => {
    console.log('/products batch route hit');
    const userId = req.user.id;
    console.log('req body', req.body)
    console.log('user id', userId)

    const items = req.body.items || [];
    const productIds = items.map(item => item.productIds);
    const purchasedQuantity= items.map(item => item.purchasedQuantity)

    console.log('productIds', productIds, 'type', typeof(productIds))
    console.log("purchasedQuantities",purchasedQuantity, typeof(purchasedQuantity))
    console.log('user id', userId)

        
    if (productIds.length === 0) {
        console.error("No product IDs provided")
        return res.status(400).json({ error: 'No product IDs provided' });
    }
    
    if (!productIds) {
        console.error("No product IDs provided")
        return res.status(400).json({ error: 'No product IDs provided' });
    }

    if (!productIds || typeof productIds !== 'object') {
        console.error("No product IDs provided or invalid format");
        return res.status(400).json({ error: 'No product IDs provided or invalid format' });
    }
    
    try {
        // Step 1: Get the cartId based on userId
        const cartQuery = `
            SELECT id AS cartId
            FROM carts
            WHERE "userId" = $1
        `;
        const cartResult = await zingoPool.query(cartQuery, [userId]);
        console.log('cartResult:', cartResult)
        
        if (cartResult.rows.length === 0) {
            return res.status(404).json({ error: 'No cart found for the user' });
        }

        const cartId = cartResult.rows[0].cartid; //cartid must be small case
     

        // Step 2: Get the products along with purchasedQuantity based on cartId and productIds
        const query = `
            SELECT p.id, p."productName", p."productCategory", p."phoneNumber", p."productPrice", p."discountedPrice", 
                   p."availableQuantity", p."productDescription", p."productImagePaths", 
                   p."saleState", p."reviewState", p."verifyState", p."featureState", 
                   p."slug", p."postedBy", p."isDeleted", p."createdAt",
                   c."purchasedQuantity"
            FROM products p
            LEFT JOIN cart_items c ON p.id = c."productId" AND c."cartId" = $1
            WHERE p.id = ANY($2::int[]) AND p."isDeleted" = false
        `;
        
        const result = await zingoPool.query(query, [cartId, productIds]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No products found for the provided IDs' });
        }

        console.log('result', result.rows)

        res.status(200).json({ products: result.rows });
    } catch (error) {
        console.error('Error fetching product details:', error);
        res.status(500).json({ error: 'An error occurred while fetching product details' });
    }
});
//-------------------------------Route to display all the products in the Buy Page ----------------------------------------------------
router.get('/all-products', createRateLimiterMiddleware, async(req, res) => {
    console.log('===all-products route hit.===');
    console.log('Req Query', req.query);
    
    try {
        // Parse and validate parameters
        let page = parseInt(req.query.page);
        if (isNaN(page) || page < 1) {
            page = 1;
        }
        
        let limit = parseInt(req.query.limit);
        if (isNaN(limit) || limit < 1 || limit > 100) {
            limit = 20;
        }

        let sex = req.query.sex;
        let userId = req.query.userId || req.user?.id; // Get from query or auth
        let sortBy = req.query.sortBy || 'default'; // 'recommended', 'price', 'newest', 'default'
        
        console.log('sex:', sex);
        console.log('userId:', userId);
        console.log('sortBy:', sortBy);
        console.log(`Current Page: ${page}, Limit: ${limit}`);

        // Calculate offset for pagination
        const offset = (page - 1) * limit;

        // Build the base query with JOIN and isPrivate + isDeleted filters
        let query = `
            SELECT p.*, u."fullName" 
            FROM products p
            JOIN users u ON p."postedBy" = u.id
            WHERE p."isPrivate" = false AND p."isDeleted" = false
        `;
        
        let countQuery = `
            SELECT COUNT(*)
            FROM products p
            JOIN users u ON p."postedBy" = u.id
            WHERE p."isPrivate" = false AND p."isDeleted" = false
        `;
        
        let queryParams = [];
        let countParams = [];

        // Add sex filter if provided
        if (sex) {
            if (sex === 'unisex') {
                // For unisex, include 'men', 'women', and 'unisex'
                query += ' AND p.sex IN ($1, $2, $3)';
                countQuery += ' AND p.sex IN ($1, $2, $3)';
                queryParams.push('men', 'women', 'unisex');
                countParams.push('men', 'women', 'unisex');
            } else {
                // For specific sex, filter normally
                query += ' AND p.sex = $1';
                countQuery += ' AND p.sex = $1';
                queryParams.push(sex);
                countParams.push(sex);
            }
        }

        // Add sorting (except for recommended - we'll handle that separately)
        if (sortBy === 'price') {
            query += ' ORDER BY p.price ASC';
        } else if (sortBy === 'newest') {
            query += ' ORDER BY p.created_at DESC';
        } else if (sortBy === 'default') {
            query += ' ORDER BY p.id DESC';
        }
        // For 'recommended', we'll sort after getting user preferences

        // Get ALL products first if we're doing recommendation sorting
        // Otherwise, apply pagination to the query
        if (sortBy === 'recommended' && userId) {
            // Don't add LIMIT/OFFSET yet - we need to score all products first
        } else {
            const paramOffset = queryParams.length + 1;
            query += ` LIMIT $${paramOffset} OFFSET $${paramOffset + 1}`;
            queryParams.push(limit, offset);
        }

        // Execute queries
        const [productsResult, countResult] = await Promise.all([
            zingoPool.query(query, queryParams),
            zingoPool.query(countQuery, countParams)
        ]);

        let products = productsResult.rows;
        const totalItems = parseInt(countResult.rows[0].count);

        // RECOMMENDATION LOGIC
        if (sortBy === 'recommended' && userId && products.length > 0) {
            try {
                // Get user's preference history
                const userInteractions = await getUserInteractions(userId, zingoPool);
                
                if (userInteractions.length > 0) {
                    // Calculate user preference scores
                    const userScores = calculatePreferenceScores(null, userInteractions);
                    
                    console.log('User preference scores:', userScores);
                    
                    // Score each product against user preferences
                    const scoredProducts = products.map(product => {
                        const matchResult = calculateProductMatchScore(userScores, {
                            category: product.category || product.productCategory,
                            price: parseFloat(product.price || product.productPrice || 0),
                            tags: product.tags || product.productTags || []
                        });
                        
                        return {
                            ...product,
                            recommendationScore: matchResult.matchScore,
                            matchBreakdown: matchResult.breakdown,
                            confidence: matchResult.confidence
                        };
                    });
                    
                    // Sort by recommendation score (highest first)
                    products = scoredProducts.sort((a, b) => 
                        (b.recommendationScore || 0) - (a.recommendationScore || 0)
                    );
                    
                    console.log('Top 3 recommended products:', 
                        products.slice(0, 3).map(p => ({
                            id: p.id,
                            name: p.name || p.productName,
                            score: p.recommendationScore
                        }))
                    );
                    
                    // Apply pagination AFTER sorting
                    products = products.slice(offset, offset + limit);
                } else {
                    console.log('No user interactions found, falling back to default sorting');
                    // No interactions yet, fallback to default sorting with pagination
                    let fallbackQuery = `
                        SELECT p.*, u."fullName" 
                        FROM products p
                        JOIN users u ON p."postedBy" = u.id
                        WHERE p."isPrivate" = false AND p."isDeleted" = false
                    `;
                    
                    let fallbackParams = [];
                    if (sex) {
                        if (sex === 'unisex') {
                            fallbackQuery += ' AND p.sex IN ($1, $2, $3)';
                            fallbackParams = ['men', 'women', 'unisex'];
                        } else {
                            fallbackQuery += ' AND p.sex = $1';
                            fallbackParams = [sex];
                        }
                    }
                    
                    fallbackQuery += ` ORDER BY p.id DESC LIMIT ${limit} OFFSET ${offset}`;
                    
                    const fallbackResult = await zingoPool.query(fallbackQuery, fallbackParams);
                    products = fallbackResult.rows;
                }
            } catch (recommendationError) {
                console.error('Error with recommendations, falling back to default:', recommendationError);
                // Fallback to default sorting if recommendation fails
                let fallbackQuery = `
                    SELECT p.*, u."fullName" 
                    FROM products p
                    JOIN users u ON p."postedBy" = u.id
                    WHERE p."isPrivate" = false AND p."isDeleted" = false
                `;
                
                let fallbackParams = [];
                if (sex) {
                    if (sex === 'unisex') {
                        fallbackQuery += ' AND p.sex IN ($1, $2, $3)';
                        fallbackParams = ['men', 'women', 'unisex'];
                    } else {
                        fallbackQuery += ' AND p.sex = $1';
                        fallbackParams = [sex];
                    }
                }
                
                fallbackQuery += ` ORDER BY p.id DESC LIMIT ${limit} OFFSET ${offset}`;
                
                const fallbackResult = await zingoPool.query(fallbackQuery, fallbackParams);
                products = fallbackResult.rows;
            }
        }

        const totalPages = Math.ceil(totalItems / limit);
        const hasMore = page < totalPages;

        console.log(`Returning page ${page}/${totalPages}, has more: ${hasMore}`);

        // Handle empty results case
        if (products.length === 0 && page === 1) {
            return res.status(200).json({
                message: "No products available",
                products: [],
                pagination: {
                    currentPage: page,
                    totalPages: 0,
                    totalItems: 0,
                    hasMore: false
                },
                sortBy,
                isPersonalized: false
            });
        }

        // Return success with products and pagination info
        res.status(200).json({
            products,
            pagination: {
                currentPage: page,
                totalPages,
                totalItems,
                hasMore
            },
            sortBy,
            isPersonalized: sortBy === 'recommended' && userId
        });

    } catch (error) {
        console.error("Error with fetching products", error);
        res.status(500).json({
            error: "An error occurred while fetching products",
            details: error.message
        });
    }
});
//-------------------Route to Review, Verify, and Feature the Product --------------------------------
router.post('/update-product-state', authenticateFirebaseToken, async (req, res) => {
    const { productId, stateType, newValue } = req.body;
  
    // Validate input
    if (!productId || !stateType || typeof newValue !== 'boolean') {
      return res.status(400).json({ error: 'Invalid input' });
    }
  
    // Ensure stateType is one of the allowed types
    const allowedStateTypes = ['verifyState', 'reviewState', 'featureState'];
    if (!allowedStateTypes.includes(stateType)) {
      return res.status(400).json({ error: 'Invalid state type' });
    }
  
    try {
      const updateQuery = `
        UPDATE products
        SET "${stateType}" = $1
        WHERE id = $2
        RETURNING *
      `;
  
      const result = await zingoPool.query(updateQuery, [newValue, productId]);
  
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Product not found' });
      }
  
      res.status(200).json(result.rows[0]);
    } catch (error) {
      console.error('Error updating product state:', error);
      res.status(500).json({ error: 'An unexpected error occurred', details: error.message });
    }
  });


  //--------------------Route to restore Soft Deleted Items ----------------------
  router.post('/products/restore/:productId', authenticateFirebaseToken, async(req,res) => {
    console.log('/product restore route hit')
    const userId = req.user.id
    const {id, postedBy, isDeleted} = req.body
    console.log('req body', req.body)
    console.log(`userId:${userId}, postedBy:${postedBy}, productId:${id}, isDelete:${isDeleted} `)    


    try {

        const isAdmin = userId === ADMIN_USER_ID
        const isOriginalPoster = postedBy === userId

        if (!isAdmin && !isOriginalPoster) {
            console.error(`User ${userId} doesn't have permission to restore this post`)
            return res.status(403).json({ error: "You don't have permission to restore this product" });
        }

        if (!isDeleted) {
            return res.status(400).json({message: "Item is not soft deleted"})
        }

        const restoreQuery = `
            UPDATE products
            SET
                "isDeleted" = false,
                "restoredAt" = CURRENT_TIMESTAMP
            WHERE
                "postedBy" = $1
                AND "id" = $2
                AND "isDeleted" = true
            RETURNING *
        `
        const restoreResult = await zingoPool.query(restoreQuery, [postedBy, id])

        if (restoreResult.rows.length === 0) {
            return res.status(500).json({
                error: `Error with restoring product: ${id}`
            });
        }

        res.status(200).json({message: `Succesfully restore product: ${id}`});



    } catch (error) {
        console.error('Error with restoring product', error)
    }
  }) 

  //---------------------Route to fetch SOFT deleted items ----------------------------
  router.get('/products/soft-deleted', authenticateFirebaseToken, async (req, res) => {
    // console.log(console.log('/products/soft-deleted route hit');)
    try {
        const query = `
            SELECT id, "productName", "productCategory",  "phoneNumber", "productPrice", "availableQuantity", "productDescription", 
                    "productImagePaths", "saleState", "reviewState", "verifyState", "featureState", "slug", "postedBy", "isDeleted", "createdAt"
            FROM products
            WHERE "isDeleted" = true
        `;

        const result = await zingoPool.query(query);
        
        if (result.rows.length === 0) {
            return res.status(500).json({
                message: "No soft deleted products",
                products: []
            });
        }

        res.status(200).json({
            products: result.rows
        });
    } catch (error) {   
        console.error('Error fetching soft deleted products:', error);
        // Always send a response, even in case of error
        return res.status(500).json({
            message: "Error fetching soft deleted products",
            error: error.message,
            products: [] // Include empty products array for consistency
        });
    }
});

  //------------------------Route to Make Offer to Product
  router.post('/create-offer', authenticateFirebaseToken, async (req,res) => {

    console.log('offer route hit')

    const userId = req.user.id
    try {
        const {productId, offerAmount} = req.body
        if (!productId || !offerAmount) {
            return res.status(400).json({error: 'Missing required fields'})
        }

        const addOfferQuery = { 
            text: `
                INSERT INTO offers ("productId", "userId", "offerAmount", "expiresAt")
                VALUES ($1, $2,$3, NOW() + '24 hours')
                RETURNING *
                ` ,
            values: [productId, userId, offerAmount]
        }

        const insertOffer = await zingoPool.query(addOfferQuery)
        return insertOffer.rows[0]

    } catch (error) {
        console.error(`Error creating offer:`, error)
        throw new Error("Failed to create offer")
    }
  })

  router.get("/product/guest/:productId",async (req, res) => {
    console.log("Route to get a single product id")
    const { productId } = req.params;
    console.log("productId", productId)
    try {
        const query = `
            SELECT p.id, 
                p."productName", p."productCategory", p."phoneNumber", p."productCondition", p."sellerCity",
                p."productPrice", p."availableQuantity", p."productDescription", p."productImagePaths", p."productBrand",
                p."saleState", p."reviewState", p."verifyState", p."featureState", p.slug, p."isSold", p."soldAt",
                p."postedBy", p."isDeleted", p."createdAt", p."discountedPrice", p."moneyBackGuarantee", p."quantitySold",
                u.id as "userId", u."firstName", u."lastName", u."ratingCount", u."totalRating", u."userProfilePath", u."verified" as "userVerifiedState",
                u."username"
         FROM products p
         LEFT JOIN users u ON p."postedBy" = u.id
         WHERE p.id = $1
        `
        const result = await zingoPool.query(query, [productId])
        console.log('result', result.rows)
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Product not found"
            })
        }
        res.status(200).json({
            product: result.rows[0]
        })
    } catch (e) {
        console.error("Error with fetching product", e)
        res.status(500).json({
            error: "Error with fetching product"
        })
    }

})


router.get("/product/:productId", authenticateFirebaseToken,async (req, res) => {
    console.log("Route to get a single product id")
    const { productId } = req.params;
    console.log("productId", productId)
    try {
        const query = `
            SELECT p.id, 
                p."productName", p."productCategory", p."phoneNumber", p."productCondition", p."sellerCity", p."productStockStatus",
                p."productPrice", p."availableQuantity", p."productDescription", p."productImagePaths", p."productBrand",
                p."saleState", p."reviewState", p."verifyState", p."featureState", p.slug, p."isSold", p."soldAt",
                p."postedBy", p."isDeleted", p."createdAt", p."discountedPrice", p."moneyBackGuarantee", p."quantitySold",
                u.id as "userId", u."firstName", u."lastName", u."ratingCount", u."totalRating", u."userProfilePath", u."verified" as "userVerifiedState",
                u."username"
         FROM products p
         LEFT JOIN users u ON p."postedBy" = u.id
         WHERE p.id = $1
        `
        const result = await zingoPool.query(query, [productId])
        console.log('result', result.rows)
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Product not found"
            })
        }
        res.status(200).json({
            product: result.rows[0]
        })
    } catch (e) {
        console.error("Error with fetching product", e)
        res.status(500).json({
            error: "Error with fetching product"
        })
    }

})
  

router.post("/product/restock-request/:productId", async (req,res) => {
    console.log("========== product request restock route hit ===========")
    const productId = req.params
    const {userId} = req.body || "guest"
    const {moreInfo} = req.body || "No info"
    sendRequestRestockToSupportTelegramNotification()
})
  

router.get("/product/:postedBy", async(req,res) => {
    console.log("=========From the same seller route==========")
   
})


module.exports = router