require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');

function normalizeColor(c) {
  if (c === undefined || c === null) return '';
  let str = String(c).trim().toLowerCase();
  // Strip leading zeros if numeric: '0100' -> '100'
  if (/^0+[0-9]+$/.test(str)) {
    str = String(parseInt(str, 10));
  }
  return str;
}

function matchColor(targetColor, backupItems) {
  const normTarget = normalizeColor(targetColor);
  if (!normTarget) return null;

  // 1. Exact normalized match
  let found = backupItems.find(b => normalizeColor(b.Color) === normTarget);
  if (found) return found;

  // 2. Starts with / code match (e.g. '0200// 11- 4300 TCX' vs '200')
  found = backupItems.find(b => {
    const normB = normalizeColor(b.Color);
    if (normTarget.startsWith(normB) || normB.startsWith(normTarget)) return true;
    // Check pantone code split by '/' or '//'
    const parts = normTarget.split(/[/ ]+/);
    if (parts.some(p => normalizeColor(p) === normB)) return true;
    return false;
  });
  if (found) return found;

  return null;
}

async function runSync() {
  await mongoose.connect(process.env.MONGO_URI);
  const Order = mongoose.connection.collection('orders');
  const OrderDate = mongoose.connection.collection('orderdates');

  const wb = XLSX.readFile('./Exp/DYEING_Updated_Report_2026-10-22.xlsx');
  const backupRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  console.log(`Loaded ${backupRows.length} backup rows`);

  const backupByOrder = new Map();
  backupRows.forEach(r => {
    const oNo = String(r.OrderNo || '').trim();
    if (!backupByOrder.has(oNo)) backupByOrder.set(oNo, []);
    backupByOrder.get(oNo).push(r);
  });

  const orderNos = Array.from(backupByOrder.keys());
  console.log(`Unique orders in backup: ${orderNos.length}`);

  // 1. Sync orders.dyeingItems
  const orders = await Order.find(
    { orderNo: { $in: orderNos } },
    { projection: { orderNo: 1, dyeingItems: 1 } }
  ).toArray();

  console.log(`Found ${orders.length} orders in 'orders' collection`);

  const orderBulkOps = [];
  let updatedOrdersCount = 0;
  let updatedItemsCount = 0;

  for (const o of orders) {
    const bItems = backupByOrder.get(o.orderNo) || [];
    let orderModified = false;
    const items = o.dyeingItems || [];

    for (const item of items) {
      const match = matchColor(item.Color, bItems);
      if (match) {
        const targetUnit = String(match.Unit || '').trim();
        const targetProc = String(match.ProcessName || '').trim();

        if (String(item.Unit || '').trim() !== targetUnit ||
            String(item.ProcessName || '').trim() !== targetProc ||
            String(item['Process Name'] || '').trim() !== targetProc) {
          
          item.Unit = targetUnit;
          item.ProcessName = targetProc;
          item['Process Name'] = targetProc;
          orderModified = true;
          updatedItemsCount++;
        }
      }
    }

    if (orderModified) {
      orderBulkOps.push({
        updateOne: {
          filter: { _id: o._id },
          update: { $set: { dyeingItems: items } }
        }
      });
      updatedOrdersCount++;
    }
  }

  console.log(`Prepared ${orderBulkOps.length} updates for 'orders' collection (${updatedItemsCount} items changed)`);

  if (orderBulkOps.length > 0) {
    const res = await Order.bulkWrite(orderBulkOps);
    console.log(`Executed Order.bulkWrite: modifiedCount = ${res.modifiedCount}`);
  }

  // 2. Also ensure orderdates.dyeing has Unit & ProcessName on both item.itemData and top-level item
  const planDocs = await OrderDate.find(
    { orderNo: { $in: orderNos } },
    { projection: { orderNo: 1, dyeing: 1 } }
  ).toArray();

  console.log(`Found ${planDocs.length} docs in 'orderdates' collection`);

  const planBulkOps = [];
  let updatedPlanCount = 0;
  let updatedPlanItemsCount = 0;

  for (const p of planDocs) {
    const bItems = backupByOrder.get(p.orderNo) || [];
    let planModified = false;
    const items = p.dyeing || [];

    for (const item of items) {
      const color = (item.itemData && item.itemData.Color) || item.Color;
      const match = matchColor(color, bItems);
      if (match) {
        const targetUnit = String(match.Unit || '').trim();
        const targetProc = String(match.ProcessName || '').trim();

        if (!item.itemData) item.itemData = {};

        if (String(item.itemData.Unit || '').trim() !== targetUnit ||
            String(item.itemData.ProcessName || '').trim() !== targetProc ||
            String(item.itemData['Process Name'] || '').trim() !== targetProc ||
            String(item.Unit || '').trim() !== targetUnit ||
            String(item.ProcessName || '').trim() !== targetProc) {
          
          item.itemData.Unit = targetUnit;
          item.itemData.ProcessName = targetProc;
          item.itemData['Process Name'] = targetProc;
          item.Unit = targetUnit;
          item.ProcessName = targetProc;
          item['Process Name'] = targetProc;
          planModified = true;
          updatedPlanItemsCount++;
        }
      }
    }

    if (planModified) {
      planBulkOps.push({
        updateOne: {
          filter: { _id: p._id },
          update: { $set: { dyeing: items } }
        }
      });
      updatedPlanCount++;
    }
  }

  console.log(`Prepared ${planBulkOps.length} updates for 'orderdates' collection (${updatedPlanItemsCount} items changed)`);

  if (planBulkOps.length > 0) {
    const res = await OrderDate.bulkWrite(planBulkOps);
    console.log(`Executed OrderDate.bulkWrite: modifiedCount = ${res.modifiedCount}`);
  }

  await mongoose.disconnect();
}

runSync().catch(console.error);
