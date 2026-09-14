const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// Calculate remaining seconds until 12:00 AM (midnight) in Bangladesh (UTC+6)
function getSecondsUntilDhakaMidnight() {
    const now = new Date();
    const dhakaOffsetMs = 6 * 60 * 60 * 1000;
    const dhakaNow = new Date(now.getTime() + dhakaOffsetMs);
    const nextDhakaMidnightUtc = new Date(Date.UTC(
        dhakaNow.getUTCFullYear(),
        dhakaNow.getUTCMonth(),
        dhakaNow.getUTCDate() + 1,
        0, 0, 0, 0
    ));
    const nextMidnightTimestamp = nextDhakaMidnightUtc.getTime() - dhakaOffsetMs;
    const diffSeconds = Math.floor((nextMidnightTimestamp - now.getTime()) / 1000);
    return {
        seconds: Math.max(diffSeconds, 60),
        expiresAt: nextMidnightTimestamp
    };
}

// 1. REGISTER API (Admin Only)
// Endpoint: POST /api/auth/register
router.post('/register', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { username, password, role, status, permissions } = req.body;

        if (!username || !password) {
            return res.status(400).json({ message: "ইউজারনেম এবং পাসওয়ার্ড উভয়ই আবশ্যক!" });
        }

        // Check if username already exists
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ message: "এই ইউজারনেমটি আগে থেকেই আছে! অন্য একটি চেষ্টা করুন।" });
        }

        // Password will be automatically hashed by User model pre-save hook
        const newUser = new User({
            username: username.trim(),
            password,
            role: role || 'Viewer',
            status: status || 'active',
            permissions: permissions || {},
            lastActive: Date.now()
        });

        await newUser.save();
        res.status(201).json({ message: "অ্যাকাউন্ট সফলভাবে তৈরি হয়েছে!" });

    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ message: "সার্ভারে কোনো সমস্যা হয়েছে!" });
    }
});

// 2. LOGIN API
// Endpoint: POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ message: "ইউজারনেম এবং পাসওয়ার্ড প্রদান করুন।" });
        }

        // User check kora (explicitly select password because select: false is on schema)
        const user = await User.findOne({ username }).select('+password');
        if (!user) {
            return res.status(400).json({ message: "এই নামে কোনো ইউজার পাওয়া যায়নি!" });
        }

        if (user.status === 'inactive') {
            return res.status(403).json({ message: "আপনার অ্যাকাউন্টটি নিষ্ক্রিয় করা আছে। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।" });
        }

        // Password check kora (compare using model method)
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(400).json({ message: "পাসওয়ার্ড ভুল হয়েছে!" });
        }

        // Token toiri kora - Dhaka time 12:00 AM midnight e expire hobe
        const payload = {
            userId: user._id,
            username: user.username,
            role: user.role
        };

        const { seconds: expiresInSeconds, expiresAt: sessionExpiresAt } = getSecondsUntilDhakaMidnight();
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: expiresInSeconds });

        // Update lastActive
        await User.findByIdAndUpdate(user._id, { lastActive: Date.now() });

        // Login success hole info pathano (never expose passwords)
        res.status(200).json({
            message: "সফলভাবে লগইন হয়েছে!",
            token,
            sessionExpiresAt,
            user: {
                id: user._id,
                username: user.username,
                role: user.role,
                status: user.status,
                permissions: user.permissions
            }
        });

    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "সার্ভারে কোনো সমস্যা হয়েছে!" });
    }
});

// 3. GET ALL USERS API (Admin Only)
// Endpoint: GET /api/auth/users
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        // Password is automatically excluded by select: false on schema
        const users = await User.find().lean();
        res.status(200).json(users);
    } catch (error) {
        console.error("Get users error:", error);
        res.status(500).json({ message: "Server error occurred!" });
    }
});

// 4. DELETE USER API (Admin Only)
// Endpoint: DELETE /api/auth/user/:id
router.delete('/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const userId = req.params.id;

        if (String(req.user._id) === String(userId)) {
            return res.status(400).json({ message: "You cannot delete your own account!" });
        }

        await User.findByIdAndDelete(userId);
        res.status(200).json({ message: "User deleted successfully!" });
    } catch (error) {
        console.error("Delete user error:", error);
        res.status(500).json({ message: "Failed to delete user!" });
    }
});

// 5. UPDATE USER API (Admin Only)
// Endpoint: PUT /api/auth/user/:id
router.put('/user/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { username, password, role, status, permissions } = req.body;

        const user = await User.findById(userId).select('+password');
        if (!user) {
            return res.status(404).json({ message: "User not found!" });
        }

        if (username) user.username = username.trim();
        if (role) user.role = role;
        if (status) user.status = status;
        if (permissions) user.permissions = permissions;

        // If new password is provided, assign it; pre-save hook will hash it automatically
        if (password && password.trim()) {
            user.password = password;
        }

        await user.save();
        res.status(200).json({ message: "User updated successfully!" });
    } catch (error) {
        console.error("Update user error:", error);
        res.status(500).json({ message: "Failed to update user!" });
    }
});

// 6. HEARTBEAT API (Authenticated Users)
// Endpoint: POST /api/auth/heartbeat
router.post('/heartbeat', authenticateToken, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user._id, { lastActive: Date.now() });
        res.status(200).json({ message: "Active status updated" });
    } catch (error) {
        console.error("Heartbeat error:", error.message);
        res.status(500).json({ message: "Failed to update heartbeat" });
    }
});

module.exports = router;