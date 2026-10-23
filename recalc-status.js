require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./models/Order');
const OrderDate = require('./models/OrderDate');

function normKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getVal(row, keys) {
    if (!row) return '';
    const rowKeys = Object.keys(row);
    for (const k of keys) {
        const norm = normKey(k);
        const found = rowKeys.find(rk => normKey(rk) === norm);
        if (found !== undefined && row[found] !== undefined && row[found] !== null) {
            return row[found];
        }
    }
    return '';
}

function generateBackendItemId(row, dept, orderNo) {
    if (!row) return '';
    if (row.itemId) return String(row.itemId).toLowerCase().replace(/\s+/g, '');

    const bNo = String(getVal(row, ['BookingNo', 'OrderNo', 'EWO', 'Booking', 'Order No', 'Booking No']) || orderNo || 'N/A').trim();
    const color = String(getVal(row, ['Color', 'Colour', 'Fab Color']) || 'N/A').trim();

    if (dept === 'knitting' || dept === 'delivery') {
        const fabConst = String(getVal(row, ['FabricConstruction', 'Fabric Construction', 'Construction', 'Fab Const', 'Fabric']) || 'N/A').trim();
        const gsm = String(getVal(row, ['GSM', 'G.S.M', 'Body GSM']) || 'N/A').trim();
        return `${bNo}_${color}_${fabConst}_${gsm}`.toLowerCase().replace(/\s+/g, '');
    } else if (dept === 'yd') {
        const type = String(getVal(row, ['Booking Type', 'Type', 'YD Type', 'BookingType']) || 'N/A').trim();
        const ydb = String(getVal(row, ['YDB', 'YD B']) || 'N/A').trim();
        return `${bNo}_${type}_${ydb}`.toLowerCase().replace(/\s+/g, '');
    } else {
        let procName = String(getVal(row, ['Process Name', 'ProcessName', 'Process']) || '').trim();
        if (procName.toLowerCase() === 'n/a' || procName === '-') procName = '';
        return `${bNo}_${color}_${procName}`.toLowerCase().replace(/\s+/g, '');
    }
}

function findMatchingPlan(planMap, item, dept, orderNo) {
    if (!planMap || planMap.size === 0) return null;
    const rawId = generateBackendItemId(item, dept, orderNo);
    if (planMap.has(rawId)) return planMap.get(rawId);

    if (rawId.endsWith('_n/a')) {
        const altId = rawId.slice(0, -3);
        if (planMap.has(altId)) return planMap.get(altId);
    } else if (rawId.endsWith('_')) {
        const altId = rawId + 'n/a';
        if (planMap.has(altId)) return planMap.get(altId);
    }

    const cleanId = rawId.replace(/(_n\/a|_)$/i, '');
    for (const [key, plan] of planMap.entries()) {
        const keyClean = key.replace(/(_n\/a|_)$/i, '');
        if (keyClean === cleanId) return plan;
    }

    if (dept === 'dyeing' || dept === 'finishing') {
        const color = String(getVal(item, ['Color', 'Colour', 'Fab Color']) || '').trim().toLowerCase();
        if (color) {
            for (const [key, plan] of planMap.entries()) {
                const pColor = String(getVal(plan.itemData || plan, ['Color', 'Colour', 'Fab Color']) || '').trim().toLowerCase();
                if (pColor && pColor === color) return plan;
            }
        }
    }

    if (dept === 'yd') {
        const ydb = String(getVal(item, ['YDB', 'YD B']) || '').trim().toLowerCase();
        if (ydb && ydb !== 'n/a') {
            for (const [key, plan] of planMap.entries()) {
                const pYdb = String(getVal(plan.itemData || plan, ['YDB', 'YD B']) || '').trim().toLowerCase();
                if (pYdb && pYdb === ydb) return plan;
            }
        }
    }

    return null;
}

mongoose.connect(process.env.MONGO_URI).then(async () => {
    console.log('Recalculating plan statuses with item synchronization...');
    
    const plans = await OrderDate.find({}, {
        orderNo: 1, knitting: 1, knittingStatus: 1, dyeing: 1, dyeingStatus: 1,
        finishing: 1, finishingStatus: 1, delivery: 1, deliveryStatus: 1, yd: 1, ydStatus: 1
    }).lean();

    if (plans.length === 0) {
        console.log('No plans found.');
        process.exit(0);
    }

    const planOrderNos = plans.map(p => p.orderNo);
    const orders = await Order.find(
        { orderNo: { $in: planOrderNos } },
        { orderNo: 1, knittingItems: 1, dyeingItems: 1, finishingItems: 1, deliveryItems: 1, ydItems: 1 }
    ).lean();

    const orderMap = new Map();
    orders.forEach(o => orderMap.set(o.orderNo, o));

    let batch = [];
    let total = 0;
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
            } else if (activeItems.length === 0 || savedItems.length === 0) {
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
                    const saved = findMatchingPlan(planMap, actItem, dept, plan.orderNo);

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

                if (confirmCount === activeItems.length && activeItems.length > 0) {
                    update[`${dept}PlanStatus`] = 'Confirm';
                } else if (hasTentative || confirmCount > 0) {
                    update[`${dept}PlanStatus`] = 'Tentative';
                } else {
                    update[`${dept}PlanStatus`] = 'Pending';
                }
            }
        }

        if (Object.keys(update).length > 0) {
            batch.push({ updateOne: { filter: { orderNo: plan.orderNo }, update: { $set: update } } });
        }

        if (batch.length >= 100) {
            await Order.bulkWrite(batch, { ordered: false });
            total += batch.length;
            process.stdout.write(`\r  Updated ${total} orders...`);
            batch = [];
        }
    }

    if (batch.length > 0) {
        await Order.bulkWrite(batch, { ordered: false });
        total += batch.length;
    }

    console.log(`\nDone! ${total} orders updated with accurate plan statuses.`);
    process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
