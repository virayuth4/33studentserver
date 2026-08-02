const express = require("express");
const zingoPool = require("../../database/pgZingo");
const { admin, auth } = require('../../auth/firebase-admin');
const axios = require("axios");
const router = express.Router();
const authenticateFirebaseToken = require('../../auth/authFirebaseToken');
const { normalizePhoneNumber } = require("../../lib/normalizePhoneNumber");

router.get('/coupons', async (req, res) => {
  const { userPhoneNumber } = req.query;

  try {
    const couponsResult = await zingoPool.query(
      `SELECT 
         c.*, 
         m.name AS merchant_name,
         COALESCE(pt.balance, 0) AS user_points
       FROM rielpoint_coupons c
       LEFT JOIN rielpoint_merchants m ON c.merchant_id = m.id
       LEFT JOIN (
         SELECT merchant_id, SUM(points) AS balance
         FROM rielpoint_point_transactions
         WHERE customer_phone = $1
         GROUP BY merchant_id
       ) pt ON pt.merchant_id = c.merchant_id
       ORDER BY m.name NULLS LAST, c.created_at DESC`,
      [userPhoneNumber || null]
    );
    console.log("couponsResult:", couponsResult.rows);

    res.status(200).json({ coupons: couponsResult.rows });
  } catch (err) {
    console.error('Error fetching coupons:', err);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

router.post('/coupons/:id/claim', async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id; // adjust to however you access the authenticated user

  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Make sure the coupon exists and is active before claiming
    const couponResult = await zingoPool.query(
      'SELECT * FROM rielpoint_coupons WHERE coupon_id = $1 AND is_active = true',
      [id]
    );

    if (couponResult.rows.length === 0) {
      return res.status(404).json({ error: 'Coupon not found or inactive' });
    }

    const claimResult = await zingoPool.query(
      `INSERT INTO rielpoint_coupon_claims (coupon_id, user_id, claimed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (coupon_id, user_id) DO NOTHING
       RETURNING *`,
      [id, userId]
    );

    if (claimResult.rows.length === 0) {
      return res.status(409).json({ error: 'Coupon already claimed' });
    }

    res.status(200).json({ claim: claimResult.rows[0] });
  } catch (err) {
    console.error('Error claiming coupon:', err);
    res.status(500).json({ error: 'Failed to claim coupon' });
  }
});

router.post('/coupon/create', authenticateFirebaseToken, async (req, res) => {
    console.log('Received request to create coupon:', req.body);
  
  try {
    const userId= req.user.id;
    const getMerchantIdResult = await zingoPool.query(
      'SELECT id FROM rielpoint_merchants WHERE owner_id = $1',
      [userId]
    ); 
    const merchantId = getMerchantIdResult.rows[0]?.id;
    console.log("merchantId:", merchantId);
    if (!merchantId) {
      return res.status(403).json({ error: 'No merchant associated with this account' });
    }

    const { points_cost, discount_type, discount_value, expires_at } = req.body;

    if (!points_cost || !discount_type || !discount_value) {
      return res.status(400).json({ error: 'points_cost, discount_type, and discount_value are required' });
    }
    if (!['percent', 'amount'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type must be "percent" or "amount"' });
    }

    const result = await zingoPool.query(
      `INSERT INTO rielpoint_coupons
         (merchant_id, points_cost, discount_type, discount_value, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING coupon_id, points_cost, discount_type, discount_value, expires_at, is_active, created_at`,
      [merchantId, points_cost, discount_type, discount_value, expires_at || null]
    );

    const row = result.rows[0];
    const discount =
      row.discount_type === 'percent'
        ? `${row.discount_value}% off`
        : `-$${row.discount_value} on everything`;

    res.status(201).json({ coupon: { ...row, discount } });
  } catch (err) {
    console.error('Error creating coupon:', err);
    res.status(500).json({ error: 'Failed to create coupon' });
  }
});
 
module.exports = router;