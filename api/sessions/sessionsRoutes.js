const zingoPool = require("../../database/pgZingo");
const express = require('express');
const router = express.Router();

// Get current user session info
router.get('/current', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const query = `
            SELECT 
                us.*,
                u.email,
                u.name
            FROM user_sessions us
            LEFT JOIN users u ON us.user_id = u.id
            WHERE us.user_id = $1 AND us.is_active = true
            ORDER BY us.updated_at DESC
            LIMIT 1
        `;
        
        const result = await zingoPool.query(query, [userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No active session found"
            });
        }
        
        res.json({
            success: true,
            session: result.rows[0]
        });
        
    } catch (error) {
        console.error('Error fetching session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch session'
        });
    }
});

// Get user session history
router.get('/history', async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const query = `
            SELECT 
                route_accessed,
                ip_address,
                created_at,
                updated_at
            FROM user_sessions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        `;
        
        const result = await zingoPool.query(query, [userId, limit, offset]);
        
        res.json({
            success: true,
            sessions: result.rows,
            pagination: {
                limit,
                offset,
                total: result.rows.length
            }
        });
        
    } catch (error) {
        console.error('Error fetching session history:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch session history'
        });
    }
});

// End current session (logout)
router.post('/end', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const query = `
            UPDATE user_sessions 
            SET is_active = false, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1 AND is_active = true
        `;
        
        await zingoPool.query(query, [userId]);
        
        res.json({
            success: true,
            message: 'Session ended successfully'
        });
        
    } catch (error) {
        console.error('Error ending session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end session'
        });
    }
});

module.exports = router;