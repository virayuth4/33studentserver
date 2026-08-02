const express = require("express");
const zingoPool = require("../../database/pgZingo");
const { admin, auth } = require('../../auth/firebase-admin');
const axios = require("axios");
const router = express.Router();
const authenticateFirebaseToken = require('../../auth/authFirebaseToken');
const { normalizePhoneNumber } = require("../../lib/normalizePhoneNumber");

router.get('/dashboard', authenticateFirebaseToken, async (req, res) => {
  try {
    const userId = req.user.id; // set by authenticateFirebaseToken

    // 1. Find the merchant owned by this user, pulling everything for the client
    const merchantResult = await zingoPool.query(
      'SELECT * FROM rielpoint_merchants WHERE owner_id = $1',
      [userId]
    );

    if (merchantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Merchant not found for this user' });
    }

    const merchant = merchantResult.rows[0];

    // 2. Pull all staff for that merchant
    const staffResult = await zingoPool.query(
      `SELECT
         s.staff_id,
         s.user_id,
         s.is_active,
         s.created_at,
         u.fullname,
         u.phone_number
       FROM rielpoint_staffs s
       JOIN rielpoint_users u ON u.id = s.user_id
       WHERE s.merchant_id = $1`,
      [merchant.id]
    );

    const couponsResult = await zingoPool.query(
      'SELECT * FROM rielpoint_coupons WHERE merchant_id = $1',
      [merchant.id]
    );
    // console.log('Coupons result:', couponsResult.rows);

    const pointTransactionResult = await zingoPool.query(
      'SELECT * FROM rielpoint_point_transactions WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 10',
      [merchant.id]
    );

    console.log("Point Transaction Result:", pointTransactionResult.rows);
    res.json({
      merchant,
      staffs: staffResult.rows,
      coupons: couponsResult.rows,
      recentPointTransactions: pointTransactionResult.rows
    });
  } catch (err) {
    console.error('Error fetching merchant dashboard:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});
module.exports = router;