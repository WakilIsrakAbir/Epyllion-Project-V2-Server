/**
 * One-time Database Migration Script
 * Sanitizes all User documents by permanently removing the legacy plainPassword field
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function sanitizePasswords() {
    try {
        if (!process.env.MONGO_URI) {
            console.error("❌ MONGO_URI is missing from environment variables (.env)!");
            process.exit(1);
        }

        console.log("Connecting to MongoDB...");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ Connected to MongoDB successfully.");

        // Count how many users have plainPassword field using native collection query
        const usersWithPlain = await User.collection.countDocuments({ plainPassword: { $exists: true } });
        console.log(`🔍 Found ${usersWithPlain} user account(s) containing legacy plainPassword.`);

        // Remove plainPassword field directly from all documents in MongoDB collection
        const result = await User.collection.updateMany(
            {},
            { $unset: { plainPassword: "" } }
        );

        console.log(`✅ Sanitization complete! Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

        // Verify using native collection that no accounts still hold plainPassword
        const remaining = await User.collection.countDocuments({ plainPassword: { $exists: true } });
        console.log(`🔒 Verification: ${remaining} account(s) with plainPassword remaining.`);

    } catch (err) {
        console.error("❌ Error during password sanitization:", err);
    } finally {
        await mongoose.disconnect();
        console.log("🔌 Disconnected from database cleanly.");
        process.exit(0);
    }
}

sanitizePasswords();
