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
const { GetRandomProducts } = require("../../algorithms/randomProduct");


const KNOWN_COUNTRIES = ['cambodia', 'thailand', 'vietnam', 'japan', 'korea']


router.get('/1464/brand/:brandName', createRateLimiterMiddleware, async (req, res) => {
  console.log("1464 brand route hit")
  try {
    const rawParam = req.params.brandName;
    // Convert "gian-saigon" → "gian saigon" for DB matching
    const searchPatternSpaced = rawParam.replace(/-/g, ' ');
    console.log("search pattern spaced", searchPatternSpaced)
    const brandQuery = `SELECT * FROM "1464_brands" WHERE "brandName" ILIKE $1 LIMIT 1`;
    console.log("brand query", brandQuery)
    const brandResult = await zingoPool.query(brandQuery, [searchPatternSpaced]);

    const productsQuery = `SELECT * FROM "1464_products" WHERE "productBrand" ILIKE $1`;
    const productsResult = await zingoPool.query(productsQuery, [searchPatternSpaced]);

    if (brandResult.rows.length === 0 && productsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not Found', message: 'Brand not found' });
    }

    const brandInfo = brandResult.rows.length > 0
      ? brandResult.rows[0]
      : {
          brandName: searchPatternSpaced,
          brandDescription: null,
          countryOfOrigin: null,
          establishedDate: null,
          bannerVideo: null,
          bannerThumbnail: null,
        };

    res.status(200).json({
      success: true,
      message: 'Brand and products fetched successfully',
      brandInfo,
      products: productsResult.rows
    });

  } catch (e) {
    console.error('Error fetching brand and products:', e);
    res.status(500).json({ error: 'An error occurred', details: e.message });
  }
});
router.get('/1464/all-brands', createRateLimiterMiddleware, async (req, res) => {
  console.log('=== 1464 all-brands route hit ===');
  try {
    const brandsQuery = `
      SELECT DISTINCT "productBrand" 
      FROM "1464_products" 
      WHERE "productBrand" IS NOT NULL
      ORDER BY "productBrand" ASC
    `;
    const result = await zingoPool.query(brandsQuery);
    res.status(200).json(result.rows);
    
  } catch (error) {
    console.error('Error fetching brands', error);
    res.status(500).json({ error: 'An error occurred', details: error.message });
  }
})



router.get('/1464/featured-products', async (req, res) => {
  try {
    const result = await zingoPool.query(`
      SELECT * FROM "1464_products"
      WHERE "isPrivate" = false
        AND "productBrand" IS NOT NULL
        AND "productBrand" != ''
        AND "isFeatured" = true
      ORDER BY "createdAt" DESC
      LIMIT 20
    `);
    res.status(200).json({ products: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred', details: error.message });
  }
});


router.get('/33student/home-data', createRateLimiterMiddleware, async (req, res) => {
  console.log('=== 33 student home-data route hit ===');
   const { sort } = req.query
   console.log("sort", sort)
  const sortConfig = {
  newest:     { order: '"createdAt" DESC',                                         saleOnly: false },
  price_asc:  { order: 'COALESCE("discountedPrice", "productPrice") ASC',          saleOnly: false },
  price_desc: { order: 'COALESCE("discountedPrice", "productPrice") DESC',         saleOnly: false },
  name_asc:   { order: '"productName" ASC',                                        saleOnly: false },
  name_desc:  { order: '"productName" DESC',                                       saleOnly: false },
  sale:       { order: '"discountedPrice" DESC NULLS LAST',                        saleOnly: true  },
}

  const GIFT_FOR_HER_BRANDS = ['Poshculture']

  const { order, saleOnly } = sortConfig[sort] ?? sortConfig.newest
  const saleFilter = saleOnly ? `AND "discountedPrice" IS NOT NULL` : ''
  try {
      const [featuredResult, newArrivalsResult, localBrandsResult, giftForHerResult] = await Promise.all([
      // Featured products (from your existing featured query)
      zingoPool.query(`
        SELECT id, "productName", "productCategory",  "productPrice", 
           "productDescription", "productImagePaths", "saleState", 
         "isFeatured", "slug", "postedBy", "isDeleted", "createdAt", "isStorePickUpOnly"
        FROM "33products"
        WHERE "isDeleted" = false AND "isFeatured" = true
        ORDER BY id DESC
      `),

      // New arrivals — 20 latest from 33 student products
      zingoPool.query(`
        SELECT *
        FROM "33products"
        WHERE "isPrivate" = false
          AND "productBrand" IS NOT NULL
          AND "productBrand" != ''
          AND "productCategory" != 'lifestyle'
          ${saleFilter}
        ORDER BY ${order}
        LIMIT 12
      `),

      // Local brands — Cambodia only
      zingoPool.query(`
        SELECT *
        FROM "1464_products"
        WHERE "isPrivate" = false
          AND "productBrand" IS NOT NULL
          AND "productBrand" != ''
          AND "countryOfOrigin" = 'cambodia'
        ORDER BY "createdAt" DESC
        LIMIT 20
      `),

      // Gift For her
      zingoPool.query(`
          SELECT *
          FROM "1464_products"
          WHERE "productBrand" = ANY($1::text[])
          ORDER BY "createdAt" DESC
          LIMIT 20
        `, [GIFT_FOR_HER_BRANDS])
    ]);

    res.status(200).json({
      featured: featuredResult.rows,
      newArrivals: newArrivalsResult.rows,
      localBrands: localBrandsResult.rows,
      giftForHer: giftForHerResult.rows,
    });

  } catch (error) {
    console.error('Error fetching home data', error);
    res.status(500).json({ error: 'An error occurred', details: error.message });
  }
});

router.get('/1464/all-products', createRateLimiterMiddleware, async (req, res) => {
  console.log('=== 1464 all-products route hit ===');
  try {
    let page = parseInt(req.query.page);
    if (isNaN(page) || page < 1) page = 1;

    let itemsPerPage = parseInt(req.query.itemsPerPage);
    if (isNaN(itemsPerPage) || itemsPerPage < 1 || itemsPerPage > 50) itemsPerPage = 12;

    const offset = (page - 1) * itemsPerPage;
    const includeLifestyle = req.query.includeLifestyle !== 'false';
    const onlyLifestyle = req.query.onlyLifestyle === 'true';

    const filterType = req.query.filterType || null;
    const filterValue = req.query.filterValue || null;
    const subFilter = req.query.subFilter === 'all' ? null : (req.query.subFilter || null);

    console.log('filterType', filterType);
    console.log('filterValue', filterValue);
    console.log('subFilter', subFilter);

    const conditions = [
      `"isPrivate" = false`,
      `"productBrand" IS NOT NULL`,
      `"productBrand" != ''`,
    ];

    if (onlyLifestyle) {
      conditions.push(`"productCategory" = 'lifestyle'`);
    } else if (!includeLifestyle) {
      conditions.push(`"productCategory" != 'lifestyle'`);
    }

    const queryParams = [itemsPerPage, offset];

    const pushCondition = (column, value) => {
      queryParams.push(value);
      conditions.push(`"${column}" = $${queryParams.length}`);
    };

    if (filterType && filterValue && filterValue !== 'all') {
      switch (filterType) {
        case 'gender':
          pushCondition('gender', filterValue);
          if (subFilter) pushCondition('productSubCategory', subFilter);
          break;
        case 'country':
          pushCondition('countryOfOrigin', filterValue);
          break;
        case 'category':
          pushCondition('productCategory', filterValue);
          if (subFilter) pushCondition('productSubCategory', subFilter);
          break;
        case 'subcategory':
          pushCondition('productSubCategory', filterValue);
          break;
        default:
          break;
      }
    }

    const whereClause = conditions.join(' AND ');

    const productsQuery = `
      SELECT *, COUNT(*) OVER() AS total_count
      FROM "1464_products"
      WHERE ${whereClause}
      ORDER BY "createdAt" DESC
      LIMIT $1 OFFSET $2
    `;
    console.log('Products query:', productsQuery);

    const result = await zingoPool.query(productsQuery, queryParams);
    const rows = result.rows;

    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
    const totalPages = Math.ceil(totalCount / itemsPerPage);
    const hasMore = page < totalPages;

    const cleanProducts = rows.map(({ total_count, ...product }) => product);

    res.status(200).json({
      products: cleanProducts,
      pagination: {
        currentPage: page,
        totalPages,
        totalProducts: totalCount,
        itemsPerPage,
        hasMore,
      },
    });
  } catch (error) {
    console.error('Error fetching products', error);
    res.status(500).json({ error: 'An error occurred', details: error.message });
  } 
});

router.get('/33/products/pickup-info', async (req, res) => {
  console.log("=== 33 pickup info route hit ===")
  try {
    const productIds = (req.query.productIds || '').split(',').map(Number).filter(Boolean);
    if (!productIds.length) {
      return res.status(400).json({ error: 'productIds array is required' });
    }

    const result = await zingoPool.query(
      `SELECT id, "isStorePickUpOnly" FROM "33products" WHERE id = ANY($1::int[])`,
      [productIds]
    );

    res.status(200).json({ products: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred', details: error.message });
  }
});

router.get('/33/my-products', createRateLimiterMiddleware, authenticateFirebaseToken,async (req, res) => {
  console.log('=== 33 my-products route hit ===');
  try {
    const userId = req.user?.uid || req.user?.user_id;
    console.log('userId', userId)

    let page = parseInt(req.query.page);
    if (isNaN(page) || page < 1) page = 1;

    let itemsPerPage = parseInt(req.query.itemsPerPage);
    if (isNaN(itemsPerPage) || itemsPerPage < 1 || itemsPerPage > 50) itemsPerPage = 12;

    const offset = (page - 1) * itemsPerPage;

    const result = await zingoPool.query(
      `SELECT *, COUNT(*) OVER() AS total_count
       FROM "33products"
       WHERE "postedBy" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2 OFFSET $3`,
      [userId, itemsPerPage, offset]
    );

    const rows = result.rows;
    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
    const totalPages = Math.ceil(totalCount / itemsPerPage);

    res.status(200).json({
      products: rows.map(({ total_count, ...p }) => p),
      pagination: {
        currentPage: page,
        totalPages,
        totalProducts: totalCount,
        itemsPerPage,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    console.error('Error fetching user products', error);
    res.status(500).json({ error: 'An error occurred', details: error.message });
  }
});

  router.get("/1464/individual-product/:productId", async (req, res) => {
    console.log("=====1464 Individual Product Id Route Hit====")
    const { productId } = req.params
    if (!productId) {
    return res.status(400).json({ error: 'Bad Request', message: "Product ID is required" })
  }
     try {
  
      const result = await zingoPool.query(
        `SELECT p.id, 
                p."productName", p."productCategory", p."sellerPhoneNumber", p."productCondition", p."productStockStatus", p."sellerCity",
                p."productPrice", p."totalAvailableQuantity", p."productDescription", p."productImagePaths", p."productMediaPaths", p."productBrand",
                p."productTags", p."productStockStatus", p."countryOfOrigin", 
                p."saleState", p."isReviewed", p."isVerified", p."isFeatured", p.slug, p."isSold", p."soldAt", 
                p."postedBy",  p."createdAt", p."discountedPrice", p."moneyBackGuarantee", p."productVariants", p."productSizingGuide",
                u.id as "userId", u."firstName", u."lastName", u."ratingCount", u."totalRating", u."userProfilePath", u."verified" as "userVerifiedState",
                u."username", u."instagram", u."tiktok"
         FROM "1464_products" p
         LEFT JOIN users u ON p."postedBy" = u.id
         WHERE p.id = $1`,
        [productId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Product not found'
        });
      }
     
      res.status(200).json(result.rows[0]);
     
    } catch (error) {
      console.error('Error fetching product:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
      });
    }
  })



  router.get("/33student/individual-product/:slug(*)", async (req, res) => {
    console.log("=====33 Slug Route Hit====")
    console.log("slug", req.params)
     try {
      // Validate if slug parameter exists
      if (!req.params[0]) {
        return res.status(400).json({
          error: 'Bad Request',
          message: "Product slug is required" 
        })
      }

      let fullSlug = '/' + req.params[0];
      // console.log('Full slug:', fullSlug);
  
  const result = await zingoPool.query(
  `SELECT p.id, 
          p."productName", p."productCategory", p."productSubCategory", p."sellerPhoneNumber", p."productCondition", p."productStockStatus", p."sellerCity",
          p."productPrice", p."totalAvailableQuantity", p."productDescription", p."productImagePaths", p."productMediaPaths", p."productBrand",
          p."productTags", p."productStockStatus", p."countryOfOrigin",
          p."saleState", p."isReviewed", p."isVerified", p."isFeatured", p.slug, p."isSold", 
          p."postedBy", p."createdAt", p."discountedPrice", p."moneyBackGuarantee", p."productVariants", p."productSizingGuide", p.gender,
          p."productSizingMeasurements", p."isStorePickUpOnly",
          u."userId" as "userId",
          COALESCE(JSON_AGG(sl_full.*) FILTER (WHERE sl_full."storeId" IS NOT NULL), '[]') as "storeLocations"
   FROM "33products" p
   LEFT JOIN "33studentUsers" u ON p."postedBy" = u."userId"
   LEFT JOIN "33productStoreLocations" psl ON p.id = psl."productId"
   LEFT JOIN "33storeLocations" sl_full ON psl."storeLocationId" = sl_full."storeId"
   WHERE p.slug = $1
   GROUP BY p.id, u."userId"`,
  [fullSlug]
);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Product not found'
        });
      }
     
      res.status(200).json(result.rows[0]);
     
    } catch (error) {
      console.error('Error fetching product:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
      });
    }
  })


    router.get("/1464/product/:productId", async (req, res) => {
    console.log("=====1464 Product/ProductId Route Hit====")
    console.log("productId:", req.params)
     try {
      // Validate if slug parameter exists
      if (!req.params[0]) {
        return res.status(400).json({
          error: 'Bad Request',
          message: "Product slug is required" 
        })
      }

      let fullSlug = '/' + req.params[0];
      // console.log('Full slug:', fullSlug);
  
      const result = await zingoPool.query(
        `SELECT p.id, 
                p."productName", p."productCategory", p."productSubCategory", p."sellerPhoneNumber", p."productCondition", p."productStockStatus", p."sellerCity",
                p."productPrice", p."totalAvailableQuantity", p."productDescription", p."productImagePaths", p."productMediaPaths", p."productBrand",
                p."productTags", p."productStockStatus", p."countryOfOrigin",
                p."saleState", p."isReviewed", p."isVerified", p."isFeatured", p.slug, p."isSold", p."soldAt", 
                p."postedBy",  p."createdAt", p."discountedPrice", p."moneyBackGuarantee", p."productVariants", p."productSizingGuide", p.gender,
                p."productSizingMeasurements",
                u.id as "userId", u."firstName", u."lastName", u."ratingCount", u."totalRating", u."userProfilePath", u."verified" as "userVerifiedState",
                u."username", u."instagram", u."tiktok"
         FROM "1464_products" p
         LEFT JOIN users u ON p."postedBy" = u.id
         WHERE p.slug = $1`,
        [fullSlug]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Product not found'
        });
      }
     
      res.status(200).json(result.rows[0]);
     
    } catch (error) {
      console.error('Error fetching product:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
      });
    }
  })






module.exports = router;