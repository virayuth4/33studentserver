const express = require("express");
const router = express.Router();
const zingoPool = require("../database/pgZingo");



router.get('/edit/*', async (req, res) => {
  console.log('product/edit/slug route hit');
  // console.log('req.params', req.params);
  try {
    // Capture the full path after '/api/'
    let fullSlug = '/' + req.params[0]; // Add leading '/'
    console.log('Full slug:', fullSlug);

    const result = await zingoPool.query(
      `SELECT 
        "createdAt", "deletedAt", "featureState", "id", "isDeleted", "isSold",
        "phoneNumber", "postedBy", "productCategory", "productSubCategory", "productCondition", "productStockStatus","productDescription",
        "productImagePaths", "productMediaPaths", "productName", "productPrice", "availableQuantity", "productTags",
        "restoredAt", "reviewState", "saleState", "sellerAddress", "sellerCity",
        "slug", "soldAt","updatedAt", "verifyState", "productBrand", "moneyBackGuarantee", "bankAccountName",
        "bankAccountNumber", "productTags"
      FROM products WHERE slug = $1`,
      [fullSlug]
    );

    if (result.rows.length > 0) {
      res.status(200).json(result.rows[0]);
    } else {
      res.status(404).json({ message: 'Product not found' });
    }
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});





//-----------------Route to Fetch individual product for slug page ----------------------------------------
router.get('/:slug(*)', async (req, res) => {
    console.log('==================slug route hit==================');
    console.log('req.params', req.params);
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
                p."productName", p."productCategory", p."phoneNumber", p."productCondition", p."productStockStatus", p."sellerCity",
                p."productPrice", p."availableQuantity", p."productDescription", p."productImagePaths", p."productMediaPaths", p."productBrand",
                p."productTags", p."productStockStatus",
                p."saleState", p."reviewState", p."verifyState", p."featureState", p.slug, p."isSold", p."soldAt", 
                p."postedBy", p."isDeleted", p."createdAt", p."discountedPrice", p."moneyBackGuarantee", p."quantitySold", p."directToSeller",
                u.id as "userId", u."firstName", u."lastName", u."ratingCount", u."totalRating", u."userProfilePath", u."verified" as "userVerifiedState",
                u."username", u."instagram", u."tiktok"
         FROM products p
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
  });




module.exports = router