const express = require('express');
const router = express.Router();
const DropdownMaster = require('../models/DropdownMaster');
const OrderDate = require('../models/OrderDate');
const { authenticateToken } = require('../middleware/auth');

// Allow Admin OR users granted Setup permission in User Management
const requireSetupPermission = (req, res, next) => {
    if (req.user && (req.user.role === 'Admin' || req.user.permissions?.menus?.dataManagement?.setup)) {
        return next();
    }
    return res.status(403).json({ message: 'Access forbidden: Setup privileges required.' });
};

// Default initial master options
const DEFAULT_UNITS = ['EFL', 'EKL', 'Ext', 'Outside'];
const DEFAULT_PROCESSES = ['Solid', 'Dyeing Wash', 'HTR', 'Pluvia', 'SB', 'WH', 'DF'];

/**
 * Seed initial dropdowns if collection is empty
 */
async function ensureSeedData() {
    const count = await DropdownMaster.countDocuments();
    if (count === 0) {
        const seedItems = [];
        DEFAULT_UNITS.forEach(name => {
            seedItems.push({ type: 'UNIT', name, status: 'ACTIVE' });
        });
        DEFAULT_PROCESSES.forEach(name => {
            seedItems.push({ type: 'PROCESS', name, status: 'ACTIVE' });
        });
        await DropdownMaster.insertMany(seedItems);
        console.log('✅ DropdownMaster initial seed data inserted.');
    }
}

// All dropdown routes require authentication
router.use(authenticateToken);

// ==========================================
// 1. GET ALL DROPDOWN ITEMS
// Endpoint: GET /api/dropdowns
// ==========================================
router.get('/', async (req, res) => {
    try {
        await ensureSeedData();

        const items = await DropdownMaster.find().sort({ createdAt: 1 }).lean();
        const units = items.filter(it => it.type === 'UNIT');
        const processes = items.filter(it => it.type === 'PROCESS');

        res.status(200).json({
            units,
            processes,
            totalUnits: units.length,
            totalProcesses: processes.length
        });
    } catch (error) {
        console.error('Error fetching dropdowns:', error);
        res.status(500).json({ message: 'Failed to fetch dropdown options.' });
    }
});

// ==========================================
// 2. ADD NEW DROPDOWN ITEM (Admin Only)
// Endpoint: POST /api/dropdowns
// ==========================================
router.post('/', requireSetupPermission, async (req, res) => {
    try {
        const { type, name } = req.body;

        if (!type || !['UNIT', 'PROCESS'].includes(type.toUpperCase())) {
            return res.status(400).json({ message: 'Invalid type. Must be UNIT or PROCESS.' });
        }

        const trimmedName = (name || '').trim();
        if (!trimmedName) {
            return res.status(400).json({ message: 'Item name cannot be empty.' });
        }

        // Case-insensitive duplicate check for the same type
        const existing = await DropdownMaster.findOne({
            type: type.toUpperCase(),
            name: { $regex: `^${trimmedName}$`, $options: 'i' }
        });

        if (existing) {
            // If it exists but was marked as HIDDEN, allow un-hiding it
            if (existing.status === 'HIDDEN') {
                existing.status = 'ACTIVE';
                await existing.save();
                return res.status(200).json({
                    message: `"${trimmedName}" already existed as Hidden and is now reactivated!`,
                    item: existing
                });
            }
            return res.status(400).json({ message: `"${trimmedName}" already exists in ${type.toLowerCase()} list!` });
        }

        const newItem = new DropdownMaster({
            type: type.toUpperCase(),
            name: trimmedName,
            status: 'ACTIVE'
        });

        await newItem.save();
        res.status(201).json({ message: `"${trimmedName}" added successfully!`, item: newItem });

    } catch (error) {
        console.error('Error adding dropdown item:', error);
        res.status(500).json({ message: 'Failed to add dropdown item.' });
    }
});

// ==========================================
// 3. EDIT DROPDOWN ITEM (Admin Only)
// Endpoint: PUT /api/dropdowns/:id
// ==========================================
router.put('/:id', requireSetupPermission, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, status } = req.body;

        const item = await DropdownMaster.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Dropdown item not found.' });
        }

        // Handle rename if provided
        if (name && name.trim()) {
            const newName = name.trim();
            // Check duplicate
            const duplicate = await DropdownMaster.findOne({
                _id: { $ne: id },
                type: item.type,
                name: { $regex: `^${newName}$`, $options: 'i' }
            });
            if (duplicate) {
                return res.status(400).json({ message: `"${newName}" already exists in ${item.type.toLowerCase()} list!` });
            }
            item.name = newName;
        }

        // Handle status toggle if provided
        if (status && ['ACTIVE', 'HIDDEN'].includes(status.toUpperCase())) {
            item.status = status.toUpperCase();
        }

        await item.save();
        res.status(200).json({ message: `"${item.name}" updated successfully!`, item });

    } catch (error) {
        console.error('Error updating dropdown item:', error);
        res.status(500).json({ message: 'Failed to update dropdown item.' });
    }
});

// ==========================================
// 4. DELETE DROPDOWN ITEM WITH SAFETY CHECK (Admin Only)
// Endpoint: DELETE /api/dropdowns/:id
// Safety rule: If used in existing OrderDate records, mark HIDDEN instead of deleting.
// ==========================================
router.delete('/:id', requireSetupPermission, async (req, res) => {
    try {
        const { id } = req.params;

        const item = await DropdownMaster.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Dropdown item not found.' });
        }

        // Delete Safety Logic: Check if value is used in existing OrderDate records
        let isUsed = false;
        if (item.type === 'UNIT') {
            const usedRecord = await OrderDate.findOne({
                'dyeing.itemData.Unit': item.name
            }).lean();
            if (usedRecord) isUsed = true;
        } else if (item.type === 'PROCESS') {
            const usedRecord = await OrderDate.findOne({
                $or: [
                    { 'dyeing.itemData.ProcessName': item.name },
                    { 'dyeing.itemData.Process Name': item.name }
                ]
            }).lean();
            if (usedRecord) isUsed = true;
        }

        if (isUsed) {
            // Do not permanently delete. Mark as HIDDEN instead to preserve historical records.
            item.status = 'HIDDEN';
            item.deletedAt = new Date();
            await item.save();

            return res.status(200).json({
                action: 'hidden',
                message: `⚠️ "${item.name}" is used in existing order records! To protect historical data, it was marked as Hidden instead of permanently deleted.`,
                item
            });
        }

        // Unused item can be safely deleted permanently
        await DropdownMaster.findByIdAndDelete(id);
        res.status(200).json({
            action: 'deleted',
            message: `"${item.name}" has been permanently deleted.`
        });

    } catch (error) {
        console.error('Error deleting dropdown item:', error);
        res.status(500).json({ message: 'Failed to delete dropdown item.' });
    }
});

module.exports = router;
