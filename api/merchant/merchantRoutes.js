const express = require("express");
const zingoPool = require("../../database/pgZingo");
const { admin, auth } = require('../../auth/firebase-admin');
const axios = require("axios");
const router = express.Router();
const authenticateFirebaseToken = require('../../auth/authFirebaseToken');
const { normalizePhoneNumber } = require("../../lib/normalizePhoneNumber");

const { randomUUID } = require('crypto');

router.post('/merchant/create', authenticateFirebaseToken, async (req, res) => {
  console.log("merchant creation request body:", req.body);
  const { name, contact_phone } = req.body;


  if (!name || !contact_phone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const ownerId = req.user?.id;
  if (!ownerId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  try {
   const result = await zingoPool.query(
      `INSERT INTO rielpoint_merchants
        (name, slug, contact_phone, timezone, status, settings, owner_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
      RETURNING id, name, slug, contact_email, contact_phone, timezone, status, settings, created_at, updated_at, owner_id`,
      [
        name.trim(),
        slug,
        contact_phone.trim(),
        'Asia/Phnom_Penh',
        'pending',
        {},
        ownerId,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique_violation, likely on slug
      return res.status(409).json({ error: 'A merchant with this name already exists' });
    }
    console.error('Error creating merchant:', err);
    return res.status(500).json({ error: 'Failed to create merchant' });
  }
});

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