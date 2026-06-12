// backend/routes/auth.js
const express = require("express");
const router = express.Router();
const { auth } = require("../../auth/firebase-admin"); // Firebase admin instance
const zingoPool = require("../../database/pgZingo");

// ============================================================
// POST /api/user/google-login
// Handles Google Tokens and maps them to your local Postgres DB
// ============================================================
const PARTNER_SCHOOLS = {
  "ciaschool.edu.kh": "CIA First",
  "ispp.edu.kh": "ISPP",
  "nisc.edu.kh": "Northbridge",
  "ligeracademy.org": "Liger Academy",
  "ciafirst.edu.kh": "CIA First (Alt)",
  "gmail.com": "Test Account (Gmail)" // For testing purposes only - remove in production!
};
router.post("/user/google-login", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: "Token is missing." });

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const { uid, email, name, picture } = decodedToken;

    // 2. Extract domain
    const emailDomain = email.split("@")[1]?.toLowerCase();

    // 3. Dynamic Check: Is this domain in our partner network dictionary?
    const assignedSchoolName = PARTNER_SCHOOLS[emailDomain];

  if (!assignedSchoolName) {
    console.warn(`🛑 Blocked login from unsupported domain: ${email}`);
    
    try {
      await auth.deleteUser(uid);
      console.log(`🗑️ Deleted unauthorized Firebase user: ${email}`);
    } catch (deleteErr) {
      console.error(`Failed to delete user ${uid}:`, deleteErr.message);
    }

    return res.status(403).json({ 
      success: false, 
      error: "Access Denied: Your school is not part of our campus retail partner network yet." 
    });
  }
    // 4. Upsert directly into PostgreSQL with the dynamically resolved school name!
    const upsertQuery = `
      INSERT INTO "33studentusers" (firebase_uid, name, email, picture, school)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (firebase_uid) 
      DO UPDATE SET name = EXCLUDED.name, picture = EXCLUDED.picture
      RETURNING firebase_uid, name, email, picture, phone, address, school;
    `;

    const values = [uid, name, email, picture, assignedSchoolName];
    const dbResult = await zingoPool.query(upsertQuery, values);
    const userProfile = dbResult.rows[0];

    const isProfileIncomplete = !userProfile.phone || !userProfile.address;

    return res.status(200).json({
      success: true,
      isProfileIncomplete, 
      user: userProfile
    });

  } catch (error) {
    console.error("Multi-school Auth Error:", error.message);
    return res.status(401).json({ success: false, error: "Authentication failed." });
  }
});


router.put("/user/update-profile", async (req, res) => {
  const { uid, phone, address, school } = req.body;

  if (!uid) {
    return res.status(400).json({ success: false, error: "Missing required user identity." });
  }

  try {
    const updateQuery = `
      UPDATE users 
      SET phone = $1, address = $2, school = $3
      WHERE firebase_uid = $4
      RETURNING *;
    `;
    
    const result = await zingoPool.query(updateQuery, [phone, address, school, uid]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "User profile record not found." });
    }

    return res.status(200).json({
      success: true,
      message: "Delivery specifications successfully saved.",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Failed profile save query:", error.message);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

module.exports = router;