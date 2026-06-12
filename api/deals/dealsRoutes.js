const express = require("express");
const router = express.Router();
const zingoPool = require("../../database/pgZingo");
const multer = require('multer');


router.get('/33/deals', async (req, res) => {
    const logPrefix = '[Deals]';
    console.log(`${logPrefix} Fetching deals...`);
    try {
        const deals = await zingoPool.query('SELECT * FROM "33studentdeals" ORDER BY "createdAt" DESC');
        console.log(`${logPrefix} Deals fetched successfully.`);
        res.json(deals.rows);
    } catch (error) {
        console.error(`${logPrefix} Error fetching deals:`, error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;