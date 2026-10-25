const mongoose = require('mongoose');

// Batch Plan module: one document per BP Data row (collar / cuff / hem / placket).
// `owner` is the lower-case upload file name; re-uploading the same file replaces its rows.
const batchBpDataSchema = new mongoose.Schema({
    orderKey: { type: String, required: true, index: true }, // normalized order number
    orderNo: { type: String, required: true },
    owner: { type: String, default: '', index: true },
    row: { type: mongoose.Schema.Types.Mixed, default: {} }    // original Excel row, all columns
}, { timestamps: true });

module.exports = mongoose.model('BatchBpData', batchBpDataSchema);
