const express = require("express");
const zingoPool = require("../../database/pgZingo");
const { admin, auth } = require('../../auth/firebase-admin');
const axios = require("axios");
const router = express.Router();
const authenticateFirebaseToken = require('../../auth/authFirebaseToken')


async function sendOTPWithServiceAPI(phoneNumber, otp, fullName, requestNumber=1) {
    console.log("Sending OTP with external service API");
    console.log("Phone Number:", phoneNumber);
    console.log("OTP:", otp);
    console.log("Full Name:", fullName);
    console.log("Number of times this has been request", requestNumber);
    
    // Use localhost when calling your own server
    const otpBackendUrl = `${process.env.NEXT_PUBLIC_OTP_BACKEND}/api/send-otp`;
    // Or if the service is truly external, keep using https://fuzingo.com/api/send-otp
    
    console.log("OTP Backend URL:", otpBackendUrl);

    const requestData = {
        phoneNumber,
        otp
    };
    
    try {
        const otpResponse = await axios.post(otpBackendUrl, requestData);
    
        console.log('OTP API response:', otpResponse.data);

        if (!otpResponse.data.success) {
            throw new Error('Failed to send OTP');
        }

        return { success: true, message: 'OTP sent successfully' };
    } catch (error) {
        console.error('Error sending OTP:', error);
        // Return the error instead of throwing it to avoid unhandled rejections
        return { success: false, error: 'Failed to send OTP', details: error.message };
    }
}

router.get('/user/profile', authenticateFirebaseToken, async (req, res) => {
    console.log('riel point user route hit')
    // console.log('Firebase UID from user-profile route', req.user.uid)
    // console.log("User Id", req.user.id)
    // console.log("userId", req.user)
    
    
    try {
     

     const query = `SELECT * FROM rielpoint_users WHERE id = $1`;
    const result = await zingoPool.query(query, [req.user.id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Not Found",
                message: "User not found"
            });
        }

        const userData = result.rows[0];

        const sessionInfo = {
            uid: req.user.uid,
            email: req.user.email,
            emailVerified: req.user.email_verified,
            ...(req.user.name && { name: req.user.name }),
            ...(req.user.picture && { picture: req.user.picture }),
            iat: req.user.iat, 
            exp: req.user.exp, 
            aud: req.user.aud, 
            iss: req.user.iss  
        };

        res.status(200).json({ 
            user: userData,
            session: sessionInfo
        });

    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred'
        });
    }
});

router.post("/user/registration/initiate", async (req, res) => {
    console.log("=========Registration Initiation===========");
    console.log("req body", req.body);
    let { phoneNumber, fullName, password } = req.body;
    const client = await zingoPool.connect();

    try {
        console.log("Full Name in register initiation", fullName);
        console.log("Original Phone Number in register initiation", phoneNumber);

        if (phoneNumber.startsWith('0')) {
            phoneNumber = phoneNumber.substring(1);
        } else if (phoneNumber.startsWith('855')) {
            phoneNumber = phoneNumber.substring(3);
        }

        const phoneEmail = phoneNumber + "@phone.com";

        try {
            const userRecord = await auth.getUserByEmail(phoneEmail);
            if (userRecord) {
                return res.status(400).json({
                    success: false,
                    error: 'Phone number already registered'
                });
            }
        } catch (error) {
            if (error.code !== 'auth/user-not-found') {
                throw error;
            }
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        console.log("Generated OTP:", otp);

        const query = `
            INSERT INTO rielpoint_otp (
                "phone_number", "otp_code", "user_info"
            )
            VALUES ($1, $2, $3)
            ON CONFLICT ("phone_number")
            DO UPDATE SET
                "otp_code" = EXCLUDED."otp_code",
                "attempts" = 0,
                "user_info" = EXCLUDED."user_info",
                "created_at" = CURRENT_TIMESTAMP,
                "expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 minute'
            RETURNING *;
        `;

        // storing plaintext password here only for the ~1 min OTP window — see note below
        const values = [
            phoneNumber,
            otp,
            JSON.stringify({ fullName, password })
        ];

        const result = await client.query(query, values);
        console.log("Query Result:", result.rows[0]);

        // await sendOTPWithServiceAPI(phoneNumber, otp, fullName);

        return res.json({ success: true, message: 'OTP sent successfully' });

    } catch (error) {
        console.error("Error in registration initiation:", error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        client.release(); // ← runs no matter what happens above
    }
});

router.post("/user/registration/otp/confirmation/:phoneNumber", async (req, res) => {
    console.log("==========OTP Confirmation ==========");
    const { otp } = req.body;

    let phoneNumber = req.params.phoneNumber.replace(/^:/, '').trim();
    console.log(`Raw phone number from params: "${req.params.phoneNumber}"`);

    if (phoneNumber.startsWith('0')) {
        phoneNumber = phoneNumber.substring(1);
    } else if (phoneNumber.startsWith('855')) {
        phoneNumber = phoneNumber.substring(3);
    }

    console.log(`Standardized phone number: "${phoneNumber}"`);
    console.log(`Phone number length: ${phoneNumber.length}`);
    console.log(`OTP: ${otp}`);

    try {
        const getOtpQuery = `
        SELECT "otp_code", attempts, "created_at", "expires_at",
            EXTRACT(EPOCH FROM ("expires_at" - NOW())) as seconds_remaining
        FROM rielpoint_otp
        WHERE "phone_number" = $1
        `;

        const otpResult = await zingoPool.query(getOtpQuery, [phoneNumber]);

        if (otpResult.rows.length > 0) {
            const record = otpResult.rows[0];
            const storedOtp = record.otp_code; // fixed: was record.otpCode (undefined)
            const attempts = record.attempts || 0;
            const secondsRemaining = record.seconds_remaining;

            console.log(`Current record:`, record);
            console.log(`Seconds remaining until expiry: ${secondsRemaining}`);

            // Use the actual expires_at column set on insert, instead of a separate hardcoded window
            if (secondsRemaining <= 0) {
                console.log("OTP expired, deleting record");
                await zingoPool.query('DELETE FROM rielpoint_otp WHERE "phone_number" = $1', [phoneNumber]);
                return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
            }

            const newAttempts = attempts + 1;
            await zingoPool.query(`
                UPDATE rielpoint_otp
                SET attempts = $1
                WHERE "phone_number" = $2
            `, [newAttempts, phoneNumber]);

            console.log(`Updated attempts: ${newAttempts}`);

            if (newAttempts > 3) {
                console.log("Max attempts exceeded, deleting OTP");
                await zingoPool.query('DELETE FROM rielpoint_otp WHERE "phone_number" = $1', [phoneNumber]);
                return res.status(401).json({ success: false, message: "Too many attempts. Please request a new OTP." });
            }

            if (otp === storedOtp) {
                console.log("OTP confirmed successfully.");
                await zingoPool.query('DELETE FROM rielpoint_otp WHERE "phone_number" = $1', [phoneNumber]);
                // await sendSignUpNotificationToTelegram(phoneNumber, otp);
                return res.status(200).json({ success: true, message: "OTP confirmed successfully." });
            } else {
                console.log("Invalid OTP.");
                return res.status(400).json({
                    success: false,
                    message: `Invalid OTP. You have ${3 - newAttempts} attempts remaining.`
                });
            }
        } else {
            console.log("No OTP found for this phone number.");
            return res.status(404).json({ success: false, message: "No OTP found for this phone number." });
        }
    } catch (error) {
        console.error("Error executing query:", error);
        return res.status(500).json({ success: false, message: "Internal server error." });
    }
});


router.post('/create-user-profile', async (req, res) => {
  console.log('=====create user route hit=====');
  const { email, fullName } = req.body;
  console.log("User Email", email);
  console.log("FullName", fullName);

  const phoneNumber = email.split('@')[0];
  const points = 0; // promo points for new users
  const username = fullName.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '_');

  try {
    const checkUserQuery = 'SELECT * FROM rielpoint_users WHERE email = $1';
    const checkUserResult = await zingoPool.query(checkUserQuery, [email]);

    if (checkUserResult.rows.length > 0) {
      return res.status(200).json({
        message: 'User profile already exists',
        user: { ...checkUserResult.rows[0], isNew: false }
      });
    }

    const insertUserQuery = `
      INSERT INTO rielpoint_users (email, role, fullname, phone_number, rielpoints, username)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`;
    const insertUserValues = [email, 'customer', fullName, phoneNumber, points, username];

    const insertResult = await zingoPool.query(insertUserQuery, insertUserValues);

    res.status(200).json({
      message: 'User profile created successfully',
      user: { ...insertResult.rows[0], isNew: true }
    });
  } catch (error) {
    console.error('Error in create-user-profile route:', error);
    res.status(500).json({ error: 'Failed to process user profile' });
  }
});

module.exports = router;