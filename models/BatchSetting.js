const mongoose = require('mongoose');

// Batch Plan module Setup tables: key = 'setup' (Dyeing MC), 'flatAllowance' or 'unitSetup'.
const batchSettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, enum: ['setup', 'flatAllowance', 'unitSetup'] },
    value: { type: mongoose.Schema.Types.Mixed, default: [] },
    version: { type: Number, default: 0 },
    updatedBy: { type: String, default: '' }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('BatchSetting', batchSettingSchema);
