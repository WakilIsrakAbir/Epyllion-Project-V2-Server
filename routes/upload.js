const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const File = require('../models/File');
const OrderDate = require('../models/OrderDate');
const Order = require('../models/Order');
const DeptValidOrders = require('../models/DeptValidOrders');
const User = require('../models/User');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// Protect all upload and file endpoints with token authentication
router.use(authenticateToken);

// ১. Multer Setup - Disk Storage (memory bachanot jonno)
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, os.tmpdir()); // Temporarily save to system temp directory
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// ২. GridFS Bucket - MongoDB-te file save korar jonno
let gfsBucket;
function getGridFSBucket() {
    if (!gfsBucket && mongoose.connection.readyState === 1) {
        gfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
            bucketName: 'uploads'
        });
    }
    return gfsBucket;
}

// Reset bucket on reconnection (jodi connection restart hoy)
mongoose.connection.on('connected', () => {
    gfsBucket = null; // Next call to getGridFSBucket() will create a fresh bucket
});

// ==========================================
// API 1: File Upload (GridFS - MongoDB-te save hobe!)
// ==========================================
router.post('/upload', upload.single('document'), async (req, res) => {
    try {
        const { uploadedBy, role, category } = req.body;
        const originalName = req.file.originalname;
        const savedName = req.file.filename;

        const bucket = getGridFSBucket();
        if (!bucket) {
            return res.status(503).json({ message: 'Database not ready. Please try again.' });
        }

        // File stream disk theke GridFS-e pipe kori
        const uploadStream = bucket.openUploadStream(savedName, {
            contentType: req.file.mimetype,
            metadata: {
                originalName: originalName,
                uploadedBy: uploadedBy,
                category: category || 'General'
            }
        });

        // Disk theke file pore GridFS-e write kori
        const readStream = fs.createReadStream(req.file.path);

        await new Promise((resolve, reject) => {
            readStream.pipe(uploadStream)
                .on('finish', resolve)
                .on('error', reject);
        });

        // Temporary disk file delete kore dei memory/disk space bachanot jonno
        fs.unlinkSync(req.file.path);

        // File metadata amader File model-e save kori (age jerakam chilo)
        const newFile = new File({
            originalName: originalName,
            savedName: savedName,
            uploadedBy: uploadedBy,
            role: role,
            category: category || 'General',
            size: req.file.size
        });

        await newFile.save();
        console.log(`✅ File saved to GridFS: ${savedName}`);

        // ===== APPROACH A: Parse Excel and store in Order collection =====
        try {
            await parseAndStoreExcel(req.file.path ? null : null, savedName, category, bucket);
            console.log(`✅ Excel parsed and stored in Order collection`);
        } catch (parseErr) {
            console.error('Excel parse warning (file still uploaded):', parseErr.message);
        }

        return res.status(200).json({ message: 'File Uploaded and History Saved!', file: newFile });

    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ message: 'Server Error during upload' });
    }
});

// ==========================================
// API 2: Get All Files (eita age jemon chilo temon-i)
// ==========================================
router.get('/all', async (req, res) => {
    try {
        const files = await File.find().sort({ createdAt: -1 }).lean();
        res.status(200).json(files);
    } catch (error) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// ==========================================
// API 2.5: Download/Serve File from GridFS
// ==========================================
router.get('/download/:filename', async (req, res) => {
    try {
        const bucket = getGridFSBucket();
        if (!bucket) {
            return res.status(503).json({ message: 'Database not ready' });
        }

        const filename = req.params.filename;

        // Check if file exists in GridFS
        const files = await mongoose.connection.db
            .collection('uploads.files')
            .find({ filename: filename })
            .toArray();

        if (!files || files.length === 0) {
            return res.status(404).json({ message: 'File not found in storage' });
        }

        // Set proper content type
        const file = files[0];
        res.set('Content-Type', file.contentType || 'application/octet-stream');
        res.set('Content-Disposition', `inline; filename="${file.metadata?.originalName || filename}"`);

        // Stream file from GridFS to response
        const downloadStream = bucket.openDownloadStreamByName(filename);

        downloadStream.on('error', (err) => {
            console.error('GridFS download error:', err);
            if (!res.headersSent) {
                res.status(404).json({ message: 'File not found' });
            }
        });

        downloadStream.pipe(res);

    } catch (error) {
        console.error("Download Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Server Error during download' });
        }
    }
});

// ==========================================
// SUPER API: Clear Entire Database & All GridFS Files (Total Wipe - Admin Only)
// ==========================================
router.delete('/clear-all-planning', requireAdmin, async (req, res) => {
    try {
        const { adminPassword } = req.body;
        if (!adminPassword) {
            return res.status(400).json({ message: 'Admin password is required to clear planning data.' });
        }

        const adminUser = await User.findById(req.user._id).select('+password');
        if (!adminUser) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }

        const isMatch = await adminUser.comparePassword(adminPassword);
        if (!isMatch) {
            return res.status(403).json({ message: 'Invalid admin password. Action aborted.' });
        }

        // 1. OrderDate collection clear
        await OrderDate.deleteMany({});

        // 2. File metadata collection clear
        await File.deleteMany({});

        // 3. GridFS collections clear (uploads.files + uploads.chunks)
        const db = mongoose.connection.db;
        try {
            await db.collection('uploads.files').deleteMany({});
            await db.collection('uploads.chunks').deleteMany({});
            console.log('✅ GridFS files cleared');
        } catch (gridErr) {
            console.log('GridFS collections may not exist yet:', gridErr.message);
        }

        res.status(200).json({ message: 'Entire database and all files cleared successfully' });
    } catch (error) {
        console.error("Clear DB Error:", error);
        res.status(500).json({ message: 'Error: ' + error.message });
    }
});

// ==========================================
// API 3: Delete Single File (GridFS + metadata)
// ==========================================
router.delete('/:id', async (req, res) => {
    try {
        const fileId = req.params.id;
        const fileRecord = await File.findById(fileId);

        if (!fileRecord) {
            return res.status(404).json({ message: 'File not found in database' });
        }

        // GridFS theke file delete kori
        const bucket = getGridFSBucket();
        if (bucket) {
            try {
                const gridFSFiles = await mongoose.connection.db
                    .collection('uploads.files')
                    .find({ filename: fileRecord.savedName })
                    .toArray();

                for (const f of gridFSFiles) {
                    await bucket.delete(f._id);
                }
                console.log(`✅ Deleted from GridFS: ${fileRecord.savedName}`);
            } catch (gridErr) {
                console.log('GridFS delete warning:', gridErr.message);
            }
        }

        // File metadata delete
        await File.findByIdAndDelete(fileId);
        res.status(200).json({ message: 'File deleted successfully' });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ message: 'Server Error during deletion' });
    }
});

// ==========================================
// API 4: Save Process Dates & Fabric Planning (Department Wise)
// ==========================================
router.post('/save-dates', async (req, res) => {
    try {
        const { orderNo, department, fabricItems, orderStatus, completedDate, actualData } = req.body;
        
        let updateObj = {};
        
        // Support for Plan Vs Actual Tracking
        if (actualData) {
            updateObj[department] = actualData;
        } else {
            updateObj[department] = fabricItems; 
        }
        
        if (orderStatus) updateObj[`${department}Status`] = orderStatus;
        if (completedDate !== undefined) updateObj[`${department}CompletedDate`] = completedDate;
        
        const updatedRecord = await OrderDate.findOneAndUpdate(
            { orderNo: orderNo }, 
            { $set: updateObj },
            { returnDocument: 'after', upsert: true } 
        );
        
        res.status(200).json({ message: 'Planning Data saved successfully!', data: updatedRecord });

        // Update plan status for just this order (fast — single doc update)
        try {
            const dept = department.replace('Actual', ''); // handle 'knittingActual' → 'knitting'
            if (['knitting', 'dyeing', 'finishing', 'delivery', 'yd'].includes(dept)) {
                const update = {};
                if (orderStatus === 'Completed') {
                    update[`${dept}PlanStatus`] = 'Completed';
                } else if (fabricItems && Array.isArray(fabricItems) && fabricItems.length > 0) {
                    let hasSelect = false, hasTentative = false, confirmCount = 0;
                    fabricItems.forEach(item => {
                        if (!item.planType || item.planType === '' || item.planType === 'Select') hasSelect = true;
                        else if (item.planType === 'Tentative') hasTentative = true;
                        else if (item.planType === 'Confirm') confirmCount++;
                    });
                    if (hasSelect) update[`${dept}PlanStatus`] = 'Pending';
                    else if (hasTentative) update[`${dept}PlanStatus`] = 'Tentative';
                    else if (confirmCount === fabricItems.length) update[`${dept}PlanStatus`] = 'Confirm';
                    else update[`${dept}PlanStatus`] = 'Pending';
                }
                if (Object.keys(update).length > 0) {
                    await Order.updateOne({ orderNo }, { $set: update });
                }
            }

            // If actual data saved, store actualEnd in Order for fast tracking queries
            if (actualData && department.includes('Actual')) {
                const baseDept = department.replace('Actual', '');
                const actualEndField = `${baseDept}ActualEnd`;
                await Order.updateOne({ orderNo }, { $set: { [actualEndField]: actualData.actualEnd || '' } });
            }
        } catch (e) { console.error('Status update error:', e.message); }
    } catch (error) {
        console.error("Save Dates Error:", error);
        res.status(500).json({ message: 'Server Error while saving data' });
    }
});

// ==========================================
// API 5: Get All Process Dates (streamed to avoid memory overflow)
// ==========================================
router.get('/all-dates', async (req, res) => {
    try {
        res.setHeader('Content-Type', 'application/json');
        res.write('[');
        
        const cursor = OrderDate.find().lean().cursor();
        let first = true;
        
        for await (const doc of cursor) {
            if (!first) res.write(',');
            res.write(JSON.stringify(doc));
            first = false;
        }
        
        res.write(']');
        res.end();
    } catch (error) {
        console.error('Error fetching all-dates:', error);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Server Error' });
        } else {
            res.end();
        }
    }
});
// Fetch specific dates based on an array of order numbers
router.post('/specific-dates', async (req, res) => {
    try {
        const { orderNos, dept } = req.body;
        if (!orderNos || !Array.isArray(orderNos) || orderNos.length === 0) {
            return res.status(200).json([]);
        }

        let projection = { orderNo: 1, orderData: 1 };
        
        if (dept) {
            projection[dept] = 1;
            projection[`${dept}Status`] = 1;
            projection[`${dept}CompletedDate`] = 1;
        } else {
            ['knitting', 'dyeing', 'finishing', 'delivery', 'yd'].forEach(d => {
                projection[d] = 1;
                projection[`${d}Status`] = 1;
                projection[`${d}CompletedDate`] = 1;
            });
        }

        const docs = await OrderDate.find({ orderNo: { $in: orderNos } }, projection).lean();
        res.status(200).json(docs);
    } catch (error) {
        console.error('Error fetching specific-dates:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Fetch dates for a specific department only (used by Actual Tracking)
router.get('/dept-dates/:dept', async (req, res) => {
    try {
        const dept = req.params.dept;
        const validDepts = ['knitting', 'dyeing', 'finishing', 'delivery', 'yd'];
        if (!validDepts.includes(dept)) {
            return res.status(400).json({ message: 'Invalid department' });
        }

        // Only fetch documents that have data for this department (skip empty ones)
        const filter = {};
        filter[dept] = { $exists: true, $ne: [], $type: 'array' };

        const projection = { orderNo: 1 };
        projection[dept] = 1;
        projection[`${dept}Status`] = 1;
        projection[`${dept}CompletedDate`] = 1;
        projection[`${dept}Actual`] = 1;

        const docs = await OrderDate.find(filter, projection).lean();
        res.status(200).json(docs);
    } catch (error) {
        console.error('Error fetching dept-dates:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ==========================================================
// EXCEL PARSING: Parse uploaded Excel and store in Order collection
// ==========================================================

// ==========================================
// MIGRATION: One-time endpoint to parse all existing files into Order collection
// Call POST /api/files/migrate-to-orders once after deploying
// ==========================================
router.post('/migrate-to-orders', async (req, res) => {
    try {
        const bucket = getGridFSBucket();
        if (!bucket) return res.status(503).json({ message: 'Database not ready' });

        const allFiles = await File.find().sort({ createdAt: 1 }).lean();
        
        // Get latest file per originalName+category
        const latestMap = new Map();
        allFiles.forEach(f => {
            const key = `${f.originalName}__${f.category || 'General'}`;
            latestMap.set(key, f);
        });
        const latestFiles = Array.from(latestMap.values());

        let processed = 0;
        for (const file of latestFiles) {
            try {
                await parseAndStoreExcel(null, file.savedName, file.category || 'General', bucket);
                processed++;
                console.log(`Migrated: ${file.originalName} (${file.category})`);
            } catch (e) {
                console.error(`Failed to migrate ${file.originalName}:`, e.message);
            }
        }

        res.status(200).json({ message: `Migration complete. ${processed} files processed.` });
    } catch (error) {
        console.error('Migration error:', error);
        res.status(500).json({ message: 'Migration failed: ' + error.message });
    }
});

// Helper: normalize column key for flexible matching
function normKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Helper: get value from row by trying multiple possible column names
function getVal(row, keys, rowKeyMap) {
    for (const k of keys) {
        const norm = normKey(k);
        if (rowKeyMap[norm] !== undefined) {
            const val = row[rowKeyMap[norm]];
            return (val === undefined || val === null) ? '' : val;
        }
    }
    return '';
}

// Helper: build normalized key map for a row
function buildKeyMap(row) {
    const map = {};
    for (const rk in row) {
        map[normKey(rk)] = rk;
    }
    return map;
}

// Helper: generate consistent itemId for department item
function generateBackendItemId(row, dept, orderNo) {
    if (!row) return '';
    if (row.itemId) return String(row.itemId).toLowerCase().replace(/\s+/g, '');

    const km = buildKeyMap(row);
    const bNo = String(getVal(row, ['BookingNo', 'OrderNo', 'EWO', 'Booking', 'Order No', 'Booking No'], km) || orderNo || 'N/A').trim();
    const color = String(getVal(row, ['Color', 'Colour', 'Fab Color'], km) || 'N/A').trim();

    if (dept === 'knitting' || dept === 'delivery') {
        const fabConst = String(getVal(row, ['FabricConstruction', 'Fabric Construction', 'Construction', 'Fab Const', 'Fabric'], km) || 'N/A').trim();
        const gsm = String(getVal(row, ['GSM', 'G.S.M', 'Body GSM'], km) || 'N/A').trim();
        return `${bNo}_${color}_${fabConst}_${gsm}`.toLowerCase().replace(/\s+/g, '');
    } else if (dept === 'yd') {
        const type = String(getVal(row, ['Booking Type', 'Type', 'YD Type', 'BookingType'], km) || 'N/A').trim();
        const ydb = String(getVal(row, ['YDB', 'YD B'], km) || 'N/A').trim();
        return `${bNo}_${type}_${ydb}`.toLowerCase().replace(/\s+/g, '');
    } else {
        // dyeing, finishing
        const procName = String(getVal(row, ['Process Name', 'ProcessName', 'Process'], km) || 'N/A').trim();
        return `${bNo}_${color}_${procName}`.toLowerCase().replace(/\s+/g, '');
    }
}

// Helper: format Excel serial date to ISO string
function formatExcelDateServer(val) {
    if (!val || val === 'N/A' || val === '-') return '';
    if (typeof val === 'number' && val > 25000 && val < 70000) {
        const d = new Date(Math.round((val - 25569) * 86400 * 1000));
        return d.toISOString().split('T')[0];
    }
    if (typeof val === 'string') {
        const parsed = new Date(val);
        if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
    }
    return String(val);
}

// Main function: Parse an uploaded Excel file and update Order collection
async function parseAndStoreExcel(filePath, savedName, category, bucket) {
    // Read file from GridFS
    const chunks = [];
    const stream = bucket.openDownloadStreamByName(savedName);
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (sheetData.length === 0) return;

    const cat = (category || 'General').toLowerCase();

    if (cat === 'general') {
        await processGeneralFile(sheetData, sheet);
    } else {
        const deptMap = { yd: 'yd', knitting: 'knitting', dyeing: 'dyeing', finishing: 'finishing', delivery: 'delivery' };
        const dept = deptMap[cat] || cat;
        await processDeptFile(sheetData, dept);
    }

    // After storing, recalculate plan statuses
    await recalcPlanStatuses();
}

// Process General Information file — creates/updates Order docs with general info
async function processGeneralFile(sheetData, sheet) {
    const bulkOps = [];
    const validOrderNos = [];

    // Map rows directly by column letters (A, D, E, U, V, W, Y, Z)
    const colMapByOrderNo = new Map();
    if (sheet) {
        try {
            const colRows = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '' });
            for (let i = 1; i < colRows.length; i++) {
                const oNo = String(colRows[i]['A'] ?? '').trim();
                if (oNo && oNo !== 'undefined' && !colMapByOrderNo.has(oNo)) {
                    colMapByOrderNo.set(oNo, colRows[i]);
                }
            }
        } catch (e) {
            console.error('Error parsing colRows:', e);
        }
    }

    for (const row of sheetData) {
        const km = buildKeyMap(row);
        const orderNo = String(getVal(row, ['OrderNo', 'BookingNo', 'EWO', 'Booking', 'Order No', 'Booking No'], km)).trim();
        if (!orderNo || orderNo === 'undefined') continue;

        validOrderNos.push(orderNo);

        const colRow = colMapByOrderNo.get(orderNo) || {};

        const buyer = String(getVal(row, ['Buyer', 'BuyerName', 'Customer'], km)).trim().toUpperCase().replace(/\s+/g, ' ');
        const bookingDate = formatExcelDateServer(getVal(row, ['BookingReceiveDate', 'BookingDate', 'Date'], km));

        // Column-letter tracked fields: U, V, W, D, Y, Z, E, AA-AH
        const gmtUnit = String(colRow['U'] !== undefined && colRow['U'] !== '' ? colRow['U'] : getVal(row, ['BookingUnit', 'Booking Unit', 'GmtUnit', 'Gmt Unit'], km)).trim();
        const floor = String(colRow['V'] !== undefined && colRow['V'] !== '' ? colRow['V'] : getVal(row, ['Unit', 'Floor'], km)).trim();
        const buyerTeam = String(colRow['W'] !== undefined && colRow['W'] !== '' ? colRow['W'] : getVal(row, ['BuyerTeam', 'Buyer Team'], km)).trim();
        const bookedBy = String(colRow['D'] !== undefined && colRow['D'] !== '' ? colRow['D'] : getVal(row, ['BookingBy', 'BookedBy', 'Booked By', 'Booking By'], km)).trim();
        const style = String(colRow['Y'] !== undefined && colRow['Y'] !== '' ? colRow['Y'] : getVal(row, ['Style'], km)).trim();
        const bpStatusRaw = colRow['Z'] !== undefined && colRow['Z'] !== '' ? colRow['Z'] : getVal(row, ['BPStatus', 'BP Status'], km);
        const bpStatus = formatExcelDateServer(bpStatusRaw);
        const pmc = String(colRow['E'] !== undefined && colRow['E'] !== '' ? colRow['E'] : getVal(row, ['PMC'], km)).trim();

        const brush = String(colRow['AA'] !== undefined && colRow['AA'] !== '' ? colRow['AA'] : getVal(row, ['Brush'], km)).trim();
        const peach = String(colRow['AB'] !== undefined && colRow['AB'] !== '' ? colRow['AB'] : getVal(row, ['Peach'], km)).trim();
        const bodyFabric = String(colRow['AC'] !== undefined && colRow['AC'] !== '' ? colRow['AC'] : getVal(row, ['Body Fabric', 'BodyFabric', 'Fabric'], km)).trim();
        const programType = String(colRow['AD'] !== undefined && colRow['AD'] !== '' ? colRow['AD'] : getVal(row, ['Program type', 'Program Type', 'ProgramType'], km)).trim();
        const ald = String(colRow['AE'] !== undefined && colRow['AE'] !== '' ? colRow['AE'] : getVal(row, ['ALD'], km)).trim();
        const bodyGsm = colRow['AF'] !== undefined && colRow['AF'] !== '' ? colRow['AF'] : getVal(row, ['Body GSM', 'BodyGSM', 'GSM'], km);
        const heatset = String(colRow['AG'] !== undefined && colRow['AG'] !== '' ? colRow['AG'] : getVal(row, ['Heatset'], km)).trim();
        const pmcNotes = String(colRow['AH'] !== undefined && colRow['AH'] !== '' ? colRow['AH'] : getVal(row, ['PMC Notes', 'PMCNotes'], km)).trim();

        const updateData = {
            buyer: (buyer && buyer !== 'UNDEFINED' && buyer !== 'N/A') ? buyer : '',
            bookingDate: bookingDate,
            requiredQtyKgs: getVal(row, ['RequiredQtyKgs', 'Qty', 'Order Qty'], km),
            bookingBy: bookedBy,
            bookedBy: bookedBy,
            pmc: pmc,
            finalConfirmation: String(getVal(row, ['FinalConfirmation', 'Final Confirmation', 'Status'], km)),
            eventDay: getVal(row, ['EventDay', 'Event day'], km),
            ship1: formatExcelDateServer(getVal(row, ['1stShipmentDate', '1st Shipment Date', 'Ship1'], km)),
            shipLast: formatExcelDateServer(getVal(row, ['LastShipmentDate', 'Last Shipment Date', 'ShipLast'], km)),
            yarnDate: formatExcelDateServer(getVal(row, ['TAYarnDate', 'T&A Yarn date', 'YarnDate'], km)),
            knitStart: formatExcelDateServer(getVal(row, ['TAKnittingStart', 'T&A Knitting Start', 'KnitStart'], km)),
            knitEnd: formatExcelDateServer(getVal(row, ['TAKnittingEnd', 'T&A Knitting End', 'KnitEnd'], km)),
            dyeStart: formatExcelDateServer(getVal(row, ['TADyeingStart', 'T&A Dyeing Start', 'DyeStart'], km)),
            dyeEnd: formatExcelDateServer(getVal(row, ['TADyeingEnd', 'T&A Dyeing End', 'DyeEnd'], km)),
            deliStart: formatExcelDateServer(getVal(row, ['TADeliStart', 'T&A Deli. Start', 'DeliStart'], km)),
            deliEnd: formatExcelDateServer(getVal(row, ['TADeliEnd', 'T&A Deli. End', 'DeliEnd'], km)),
            fabricNotes: String(getVal(row, ['FabricNotes', 'Fabric Notes', 'Notes'], km)),
            status: String(getVal(row, ['Status'], km)),

            gmtUnit: gmtUnit,
            floor: floor,
            buyerTeam: buyerTeam,
            style: style,
            bpStatus: bpStatus,
            ald: ald,
            brush: brush,
            peach: peach,
            heatset: heatset,
            bodyFabric: bodyFabric,
            programType: programType,
            bodyGsm: bodyGsm,
            pmcNotes: pmcNotes
        };

        bulkOps.push({
            updateOne: {
                filter: { orderNo },
                update: { $set: updateData },
                upsert: true
            }
        });
    }

    if (bulkOps.length > 0) {
        // Process in batches of 500 to avoid memory issues
        for (let i = 0; i < bulkOps.length; i += 500) {
            await Order.bulkWrite(bulkOps.slice(i, i + 500), { ordered: false });
        }
        console.log(`  General: ${bulkOps.length} orders upserted`);
    }

    // Save valid orderNos for filtering — latest General file-এর orderNo গুলো track করো
    if (validOrderNos.length > 0) {
        await DeptValidOrders.findOneAndUpdate(
            { dept: 'general' },
            { $set: { validOrderNos, updatedAt: new Date() } },
            { upsert: true }
        );
        console.log(`  General: ${validOrderNos.length} valid orderNos saved for filtering`);
    }
}

// Process Department file — stores items array for the department and synchronizes OrderDate plans
async function processDeptFile(sheetData, dept) {
    // Group rows by orderNo
    const orderItems = {};

    for (const row of sheetData) {
        const km = buildKeyMap(row);
        const orderNo = String(getVal(row, ['OrderNo', 'BookingNo', 'EWO', 'Booking', 'Order No', 'Booking No'], km)).trim();
        if (!orderNo || orderNo === 'undefined') continue;

        // Store clean row data (remove __EMPTY columns)
        const cleanRow = {};
        for (const key in row) {
            if (!key.startsWith('__EMPTY') && key !== '_fileIndex') {
                cleanRow[key] = row[key];
            }
        }

        if (!orderItems[orderNo]) orderItems[orderNo] = [];
        orderItems[orderNo].push(cleanRow);
    }

    const orderNos = Object.keys(orderItems);
    if (orderNos.length === 0) return;

    // Fetch existing OrderDate docs for all orderNos in this batch to synchronize plans
    const orderDateDocs = await OrderDate.find({ orderNo: { $in: orderNos } }).lean();
    const odMap = new Map();
    orderDateDocs.forEach(doc => odMap.set(doc.orderNo, doc));

    const orderDateBulkOps = [];
    const itemsField = `${dept}Items`;
    const bulkOps = [];

    for (const [orderNo, items] of Object.entries(orderItems)) {
        const existingOd = odMap.get(orderNo);
        const existingPlans = (existingOd && Array.isArray(existingOd[dept])) ? existingOd[dept] : [];
        let deptPlanStatus = 'Pending';

        if (existingPlans.length > 0) {
            // Build map of existing plans by itemId
            const planMap = new Map();
            existingPlans.forEach(p => {
                const id = p.itemId ? String(p.itemId).toLowerCase().replace(/\s+/g, '') : generateBackendItemId(p.itemData || p, dept, orderNo);
                if (id) planMap.set(id, p);
            });

            const syncedPlans = [];
            let hasPending = false;
            let hasTentative = false;
            let confirmCount = 0;
            let matchCount = 0;

            items.forEach((item, idx) => {
                const itemId = generateBackendItemId(item, dept, orderNo) || `item_${idx}`;
                const saved = planMap.get(itemId);

                if (saved) {
                    matchCount++;
                    const cleanType = String(dept === 'delivery' ? (saved.floorPlanType || saved.planType || '') : (saved.planType || '')).trim();
                    if (!cleanType || cleanType === 'Select' || cleanType === 'Pending') {
                        hasPending = true;
                    } else if (cleanType === 'Tentative') {
                        hasTentative = true;
                    } else if (cleanType === 'Confirm') {
                        confirmCount++;
                    } else {
                        hasPending = true;
                    }
                    syncedPlans.push({
                        ...saved,
                        itemId: itemId,
                        itemData: item // Update itemData with latest Excel values
                    });
                } else {
                    // New item added: treated as Pending
                    hasPending = true;
                    syncedPlans.push({
                        itemId: itemId,
                        itemData: item,
                        startDate: '',
                        endDate: '',
                        planType: '',
                        limitation: '',
                        remarks: '',
                        floorStartDate: '',
                        floorEndDate: '',
                        floorPlanType: '',
                        yarnDate: ''
                    });
                }
            });

            if (matchCount === 0 || hasPending) {
                deptPlanStatus = 'Pending';
            } else if (hasTentative) {
                deptPlanStatus = 'Tentative';
            } else if (confirmCount === items.length && items.length > 0) {
                deptPlanStatus = 'Confirm';
            } else {
                deptPlanStatus = 'Pending';
            }

            orderDateBulkOps.push({
                updateOne: {
                    filter: { orderNo },
                    update: { $set: { [dept]: syncedPlans } },
                    upsert: true
                }
            });
        }

        const update = { 
            [itemsField]: items,
            [`${dept}PlanStatus`]: deptPlanStatus
        };

        // Extract buyer from first item if available
        if (items.length > 0) {
            const km = buildKeyMap(items[0]);
            const buyer = String(getVal(items[0], ['Buyer', 'BuyerName', 'Customer'], km)).trim().toUpperCase().replace(/\s+/g, ' ');
            if (buyer && buyer !== 'UNDEFINED' && buyer !== 'N/A' && buyer !== '') {
                update.buyer = buyer;
            }
        }

        bulkOps.push({
            updateOne: {
                filter: { orderNo },
                update: { $set: update },
                upsert: true
            }
        });
    }

    if (orderDateBulkOps.length > 0) {
        for (let i = 0; i < orderDateBulkOps.length; i += 500) {
            await OrderDate.bulkWrite(orderDateBulkOps.slice(i, i + 500), { ordered: false });
        }
        console.log(`  ${dept}: ${orderDateBulkOps.length} OrderDate docs synchronized with current items`);
    }

    if (bulkOps.length > 0) {
        for (let i = 0; i < bulkOps.length; i += 500) {
            await Order.bulkWrite(bulkOps.slice(i, i + 500), { ordered: false });
        }
        console.log(`  ${dept}: ${bulkOps.length} orders updated with items`);
    }

    // Save valid orderNos for filtering — latest dept file-এর orderNo গুলো track করো
    const validOrderNos = Object.keys(orderItems);
    if (validOrderNos.length > 0) {
        await DeptValidOrders.findOneAndUpdate(
            { dept },
            { $set: { validOrderNos, updatedAt: new Date() } },
            { upsert: true }
        );
        console.log(`  ${dept}: ${validOrderNos.length} valid orderNos saved for filtering`);
    }
}

// Recalculate plan statuses based on OrderDate saved plans cross-referenced with active Order items
async function recalcPlanStatuses() {
    try {
        const plans = await OrderDate.find({}, {
            orderNo: 1,
            knitting: 1, knittingStatus: 1,
            dyeing: 1, dyeingStatus: 1,
            finishing: 1, finishingStatus: 1,
            delivery: 1, deliveryStatus: 1,
            yd: 1, ydStatus: 1
        }).lean();

        if (plans.length === 0) return;

        const planOrderNos = plans.map(p => p.orderNo);
        const orders = await Order.find(
            { orderNo: { $in: planOrderNos } },
            { orderNo: 1, knittingItems: 1, dyeingItems: 1, finishingItems: 1, deliveryItems: 1, ydItems: 1 }
        ).lean();

        const orderMap = new Map();
        orders.forEach(o => orderMap.set(o.orderNo, o));

        const bulkOps = [];
        const depts = ['knitting', 'dyeing', 'finishing', 'delivery', 'yd'];

        for (const plan of plans) {
            const update = {};
            const orderDoc = orderMap.get(plan.orderNo);

            for (const dept of depts) {
                const savedItems = plan[dept] || [];
                const savedStatus = plan[`${dept}Status`];
                const activeItems = orderDoc ? (orderDoc[`${dept}Items`] || []) : [];

                if (savedStatus === 'Completed') {
                    update[`${dept}PlanStatus`] = 'Completed';
                } else if (activeItems.length === 0) {
                    update[`${dept}PlanStatus`] = 'Pending';
                } else if (savedItems.length === 0) {
                    update[`${dept}PlanStatus`] = 'Pending';
                } else {
                    const planMap = new Map();
                    savedItems.forEach(p => {
                        const id = p.itemId ? String(p.itemId).toLowerCase().replace(/\s+/g, '') : generateBackendItemId(p.itemData || p, dept, plan.orderNo);
                        if (id) planMap.set(id, p);
                    });

                    let hasPending = false;
                    let hasTentative = false;
                    let confirmCount = 0;
                    let matchCount = 0;

                    activeItems.forEach((actItem, idx) => {
                        const itemId = generateBackendItemId(actItem, dept, plan.orderNo) || `item_${idx}`;
                        const saved = planMap.get(itemId);

                        if (saved) {
                            matchCount++;
                            const isDelivery = (dept === 'delivery');
                            const cleanType = String(isDelivery ? (saved.floorPlanType || saved.planType || '') : (saved.planType || '')).trim();

                            if (!cleanType || cleanType === 'Select' || cleanType === 'Pending') {
                                hasPending = true;
                            } else if (cleanType === 'Tentative') {
                                hasTentative = true;
                            } else if (cleanType === 'Confirm') {
                                confirmCount++;
                            } else {
                                hasPending = true;
                            }
                        } else {
                            hasPending = true;
                        }
                    });

                    if (matchCount === 0 || hasPending) {
                        update[`${dept}PlanStatus`] = 'Pending';
                    } else if (hasTentative) {
                        update[`${dept}PlanStatus`] = 'Tentative';
                    } else if (confirmCount === activeItems.length && activeItems.length > 0) {
                        update[`${dept}PlanStatus`] = 'Confirm';
                    } else {
                        update[`${dept}PlanStatus`] = 'Pending';
                    }
                }
            }

            if (Object.keys(update).length > 0) {
                bulkOps.push({
                    updateOne: {
                        filter: { orderNo: plan.orderNo },
                        update: { $set: update }
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            for (let i = 0; i < bulkOps.length; i += 500) {
                await Order.bulkWrite(bulkOps.slice(i, i + 500), { ordered: false });
            }
            console.log(`  Plan statuses recalculated for ${bulkOps.length} orders`);
        }
    } catch (e) {
        console.error('recalcPlanStatuses error:', e.message);
    }
}

// Export recalcPlanStatuses so save-dates can call it
router._recalcPlanStatuses = recalcPlanStatuses;

module.exports = router;