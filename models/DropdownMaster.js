const mongoose = require('mongoose');

const dropdownMasterSchema = new mongoose.Schema({
    type: {
        type: String,
        required: true,
        enum: ['UNIT', 'PROCESS'],
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    status: {
        type: String,
        enum: ['ACTIVE', 'HIDDEN'],
        default: 'ACTIVE',
        index: true
    },
    deletedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

// Compound index to ensure uniqueness per type
dropdownMasterSchema.index({ type: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('DropdownMaster', dropdownMasterSchema);
