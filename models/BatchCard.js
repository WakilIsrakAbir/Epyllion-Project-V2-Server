const mongoose = require('mongoose');

// Batch Plan module: one generated Batch Process Card (snapshot, versions and history inside `card`).
const batchCardSchema = new mongoose.Schema({
    cardId: { type: String, required: true, unique: true, index: true },
    orderKey: { type: String, default: '', index: true },
    cardJson: { type: String, default: "{}" },               // card record as JSON text
    updatedBy: { type: String, default: '' }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('BatchCard', batchCardSchema);
