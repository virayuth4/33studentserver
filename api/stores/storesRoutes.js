const express = require("express");
const zingoPool = require("../../database/pgZingo");
const router = express.Router();



router.get("/stores/all-stores", async (req,res) => {
    console.log("========= All stores router hit =========")
    try {
        const query = `
            SELECT * FROM users
            WHERE "role" = 'seller'
        `
        const result = await zingoPool.query(query);
        res.status(200).json({ 
            message: 'Success',
            stores: result.rows
        });
    } catch (e) {
        console.error("Error",e)
        res.status(500).json({message: "Error"})
    }
})

module.exports = router;