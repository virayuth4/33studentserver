const express = require("express");
const router = express.Router();
const zingoPool = require("../../../database/pgZingo");
const multer = require('multer');
const authenticateFirebaseToken = require("../../../auth/authFirebaseToken")
const axios = require('axios');
const createRateLimiterMiddleware = require("../../rateLimiter");
const { addToSearchHistory } = require("../../../helper/productRoutesHelper/build_search_history");
const { getSimilarStyleTerms } = require("../../../utils/functions/getSimilarStyleTerms");

router.get('/all-products', createRateLimiterMiddleware, async(req, res) => {
    console.log('==========flutter all-products route hit==========')
    // console.log('Client IP:', req.ip);
    console.log('User Agent:', req.headers['user-agent']);
    console.log('Query Parameters:', req.query);
    console.log('Request Time:', new Date().toISOString());
    try {
        //cache header
        res.set('Cache-Control', 'public, max-age=300');

        const page = parseInt(req.query.page) || 1
        const limit = parseInt(req.query.limit) || 20
        const offset = (page - 1) * limit

        // First, get total count
        const countQuery = `
            SELECT COUNT(*) 
            FROM products 
            WHERE "isDeleted" = false 
            AND "isSold" = false
        `;
        const countResult = await zingoPool.query(countQuery)
        const totalItems = parseInt(countResult.rows[0].count)

        // Then get paginated data
        const query = `
            SELECT *
            FROM products
            WHERE "isDeleted" = false
            AND "isSold" = false
            ORDER BY id DESC
            LIMIT $1 OFFSET $2
        `;

        const result = await zingoPool.query(query, [limit, offset])

        if (result.rows.length === 0 && page === 1) {
            return res.status(200).json({
                message: "No featured products",
                products: [],
                pagination: {
                    currentPage: page,
                    totalPages: 0,
                    totalItems: 0,
                    hasMore: false
                }
            });
        }

        const totalPages = Math.ceil(totalItems / limit)
   

        res.status(200).json({
            products: result.rows,
            pagination: {
                currentPage: page,
                totalPages,
                totalItems,
                hasMore: page < totalPages
            }
        })

    } catch (error) {
        console.error("Error with fetching all products for review", error)
        res.status(500).json({
            error: "An error occurred while fetching products for review"
        })
    }
})

router.get('/all-products/search/params', createRateLimiterMiddleware, async(req, res) => {
    console.log('==========flutter search route hit==========')
    try {
        console.log('req query', req.query)
        console.log('req body', req.body)
        
        const q = req.query.q; // Get product name or description from query parameters
        const category = req.query.c; // Get product category from query parameters
        console.log('query:', q);
        console.log('category:', category);
        
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const userId = parseInt(req.body.userId) || 0;

        // Create a single SQL query template with conditional parts
        const queryParams = [];
        let conditions = ['"availableQuantity" > 0', '"isDeleted" = false'];
        
        // Handle search query parameter
        if (q && q.trim() !== '') {
            const cleanQuery = decodeURIComponent(q).replace(/-/g, ' ').trim();
            
            // Add the main search query
            queryParams.push(`%${cleanQuery}%`);
            const paramIndex = queryParams.length;
            
            // Search condition using the full phrase
            const searchCondition = `("productName" ILIKE $${paramIndex} OR "productDescription" ILIKE $${paramIndex} OR "productCategory" ILIKE $${paramIndex} OR "productSubCategory" ILIKE $${paramIndex} OR EXISTS (SELECT 1 FROM unnest("productTags") tag WHERE tag ILIKE $${paramIndex}))`;
            
            // This will become part of an OR condition if similar terms are found
            let allConditions = [searchCondition];
            
            // Check if the term is a specific style or category in the lookup table
            const similarTerms = getSimilarStyleTerms(cleanQuery);
            if (similarTerms.length > 0) {
                // For each similar term, create a condition
                similarTerms.forEach(term => {
                    queryParams.push(`%${term}%`);
                    const styleParamIndex = queryParams.length;
                    allConditions.push(`("productName" ILIKE $${styleParamIndex} OR "productDescription" ILIKE $${styleParamIndex} OR "productCategory" ILIKE $${styleParamIndex} OR "productSubCategory" ILIKE $${styleParamIndex} OR EXISTS (SELECT 1 FROM unnest("productTags") tag WHERE tag ILIKE $${styleParamIndex}))`);
                });
            }
            
            // Add the combined condition (main search + similar terms)
            conditions.push(`(${allConditions.join(' OR ')})`);
            
            addToSearchHistory(cleanQuery, userId);
        }
        
        // Handle category parameter
        if (category && category.trim() !== '') {
            queryParams.push(category);
            conditions.push(`"productCategory" = $${queryParams.length}`);
            addToSearchHistory(category, userId);
        }
        
        // Build the final WHERE clause
        const whereClause = conditions.join(' AND ');
        
        // Count query
        const countQuery = `
            SELECT COUNT(*) 
            FROM products 
            WHERE ${whereClause}
        `;
        
        // Main query
        const query = `
            SELECT 
                p.id, p."productName", p."productCategory", p."productSubCategory", p."phoneNumber", 
                p."productPrice", p."availableQuantity", p."productDescription", 
                p."productImagePaths", p."saleState", p."reviewState", p."verifyState", 
                p."featureState", p."slug", p."isSold", p."soldAt", p."postedBy",
                p."isDeleted", p."createdAt", p."inStock", p."discountedPrice", p."quantitySold",
                p."directToSeller",
                u."bio", u."fullName", u."instagram"
            FROM products p
            LEFT JOIN users u ON p."postedBy" = u.id
            WHERE ${whereClause}
            ORDER BY id DESC
            LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
        `;
        
        // Add pagination parameters
        queryParams.push(limit, offset);

        // Execute count query
        const countResult = await zingoPool.query(countQuery, queryParams.slice(0, queryParams.length - 2));
        const totalItems = parseInt(countResult.rows[0].count);
        
        console.log("query", query);
        console.log("queryParams", queryParams);
        
        // Execute main query
        const result = await zingoPool.query(query, queryParams);

        if (result.rows.length === 0 && page === 1) {
            return res.status(200).json({
                message: "No products found",
                products: [],
                pagination: {
                    currentPage: page,
                    totalPages: 0,
                    totalItems: 0,
                    hasMore: false
                }
            });
        }
        
        const totalPages = Math.ceil(totalItems / limit);

        res.status(200).json({
            products: result.rows,
            pagination: {
                currentPage: page,
                totalPages,
                totalItems,
                hasMore: page < totalPages
            }
        });

    } catch (error) {
        console.error("Error with fetching products for search", error);
        res.status(500).json({
            error: "An error occurred while fetching products for search"
        });
    }
});

router.get('/all-products/:query', createRateLimiterMiddleware, async(req, res) => {
    console.log('==========flutter all-products route hit with query==========')
    try {
        const state = req.params.query; // Get the state from the URL parameter
        console.log('query', state);
        const page = parseInt(req.query.page) || 1
        const limit = parseInt(req.query.limit) || 20
        const offset = (page - 1) * limit

        // First, get total count
        const countQuery = `
            SELECT COUNT(*) 
            FROM products 
            WHERE "availableQuantity" > 0 
            AND "isSold" = false
            AND "verifyState" = $1
        `;
        const countResult = await zingoPool.query(countQuery, [state]) // Pass the state to the query
        const totalItems = parseInt(countResult.rows[0].count)

        // Then get paginated data
        const query = `
            SELECT *
            FROM products
            WHERE "isDeleted" = false
            AND "isSold" = false
            AND "availableQuantity" > 0
            AND "verifyState" = $1
            ORDER BY id DESC
            LIMIT $2 OFFSET $3
        `;

        const result = await zingoPool.query(query, [state, limit, offset]) // Pass the state to the query

        if (result.rows.length === 0 && page === 1) {
            return res.status(200).json({
                message: "No featured products",
                products: [],
                pagination: {
                    currentPage: page,
                    totalPages: 0,
                    totalItems: 0,
                    hasMore: false
                }
            });
        }

        const totalPages = Math.ceil(totalItems / limit)

        res.status(200).json({
            products: result.rows,
            pagination: {
                currentPage: page,
                totalPages,
                totalItems,
                hasMore: page < totalPages
            }
        })

    } catch (error) {
        console.error("Error with fetching all products for review", error)
        res.status(500).json({
            error: "An error occurred while fetching products for review"
        })
    }
})

module.exports = router;