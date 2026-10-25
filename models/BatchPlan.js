const mongoose = require('mongoose');

// Batch Plan module: saved plan state of one order (all floors), as produced by the Batch Plan page.
// `version` gives optimistic locking so two users cannot overwrite each other's save.
const batchPlanSchema = new mongoose.Schema({
    orderKey: { type: String, required: true, unique: true, index: true },
    orderNo: { type: String, required: true },
    stateJson: { type: String, default: "{}" },               // plan state as JSON text (keys may contain dots)
    version: { type: Number, default: 0 },
    updatedBy: { type: String, default: '' },
    // Units this plan keeps in the sidebar (lib/batch/source.js planRetainedUnits), as of retainedVersion.
    retainedUnits: { type: [String], default: undefined },
    retainedVersion: { type: Number }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('BatchPlan', batchPlanSchema);
