const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
    originalName: {
        type: String,
        required: true
    },
    savedName: {
        type: String,
        required: true
    },
    uploadedBy: {
        type: String, // We will save the username here
        required: true
    },
    role: {
        type: String, // Admin or Planner
        required: true
    },
    category: {
        type: String, // 'General', 'Knitting', 'Dyeing', 'Finishing', 'Delivery'
        default: 'General'
    },
    size: {
        type: Number
    },
    // Result of reading the file at upload time: 'ok', or 'failed' with parseError.
    parseStatus: { type: String, enum: ['ok', 'failed'] },
    parseError: { type: String },
    orderCount: { type: Number },
    // The stored copy (GridFS) was removed; this record is the upload history and is never deleted.
    // Shared with Next Planning V3, which writes the same fields.
    blobDeleted: { type: Boolean },
    blobDeletedAt: { type: Date },
    blobBackupPath: { type: String },
    blobNote: { type: String }
}, { timestamps: true }); // timestamps will automatically save the exact upload Date & Time

module.exports = mongoose.model('File', fileSchema);