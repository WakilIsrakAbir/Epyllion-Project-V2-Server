/* Batch Plan module API (/api/batch).
   Additive: reads Order / DeptValidOrders, writes only the new Batch* collections. */
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const DeptValidOrders = require('../models/DeptValidOrders');
const BatchPlan = require('../models/BatchPlan');
const BatchSetting = require('../models/BatchSetting');
const BatchCard = require('../models/BatchCard');
const BatchBpData = require('../models/BatchBpData');
const { authenticateToken } = require('../middleware/auth');
const S = require('../lib/batch/source');

// Plan snapshots can be large; this router parses its own JSON (mounted before the global parser).
// The token is checked first, so only signed-in users can send a large body.
router.use(authenticateToken);
const parseJson = express.json({ limit: '25mb' });
const MAX_PLANS_PER_SAVE = 1000, MAX_CARDS_PER_SAVE = 5000;

const MENU_KEYS = ['menus.batchPlan.all', ...S.FLOOR_KEYS.map(f => 'menus.batchPlan.' + f.toLowerCase()),
  'menus.batchCard.all', ...S.FLOOR_KEYS.map(f => 'menus.batchCard.' + f.toLowerCase()),
  'menus.batchReport.dyeableBatch', 'menus.batchReport.dyeableSummary', 'menus.batchReport.dailyConfirm',
  'menus.dataManagement.dyeingMc', 'menus.dataManagement.flatAllowance', 'menus.dataManagement.unitSetup'];
const SETTING_PERMISSIONS = { setup: 'menus.dataManagement.dyeingMc', flatAllowance: 'menus.dataManagement.flatAllowance', unitSetup: 'menus.dataManagement.unitSetup' };
const ACTION_LABELS = {
  'actions.batchEdit': 'edit batch plans', 'actions.batchTentative': 'make a batch plan Tentative',
  'actions.batchConfirm': 'confirm or re-confirm batch plans', 'actions.batchInternalChange': 'approve Internal change',
  'actions.batchMovePending': 'move a batch plan to Pending', 'actions.batchCardGenerate': 'generate batch cards'
};

function requireModuleAccess(req, res, next) {
  if (MENU_KEYS.some(key => S.can(req.user, key))) return next();
  return res.status(403).json({ message: 'Access forbidden: Batch Plan permission required.' });
}

// Same buyer restriction rule as routes/orders.js (non-admin users with selected buyers).
async function allowedBuyerSet(user) {
  if (S.isAdmin(user)) return null;
  const perms = user?.permissions?.buyers;
  if (!perms || perms.accessType === 'all') return null;
  if (perms.accessType === 'none' || !Array.isArray(perms.buyerIds) || !perms.buyerIds.length) return new Set();
  const raw = await Order.distinct('buyer');
  return new Set(raw.filter(b => perms.buyerIds.includes(String(b).toLowerCase().replace(/[^a-z0-9]/g, ''))));
}

// Setup tables (Dyeing MC, Flat Allowance, Unit Setup) start empty and are filled on the Setup pages.
// The empty record gives each table a version, so the first save works like every later one.
async function ensureSettings() {
  const existing = await BatchSetting.find({}).lean();
  const have = new Set(existing.map(s => s.key));
  for (const key of ['setup', 'flatAllowance', 'unitSetup']) {
    if (have.has(key)) continue;
    try { await BatchSetting.create({ key, value: [], version: 1, updatedBy: 'system' }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
  return BatchSetting.find({}).lean();
}

async function generalOrders(user) {
  const valid = await DeptValidOrders.findOne({ dept: 'general' }).lean();
  const filter = valid?.validOrderNos?.length ? { orderNo: { $in: valid.validOrderNos } } : {};
  const buyers = await allowedBuyerSet(user);
  if (buyers) filter.buyer = { $in: Array.from(buyers) };
  return Order.find(filter, {
    orderNo: 1, buyer: 1, buyerTeam: 1, bookingDate: 1, eventDay: 1, style: 1, pmc: 1, bookedBy: 1, bookingBy: 1,
    floor: 1, gmtUnit: 1, brush: 1, peach: 1, heatset: 1, knitStart: 1, knitEnd: 1, dyeStart: 1, dyeEnd: 1,
    deliStart: 1, deliEnd: 1, ship1: 1, shipLast: 1, fabricNotes: 1, pmcNotes: 1,
    knittingPlanStatus: 1, dyeingPlanStatus: 1, deliveryPlanStatus: 1, knittingItems: 1
  }).lean();
}

// ==========================================
// GET /api/batch/state — everything the Batch Plan page needs (demo appState shape)
// ==========================================
router.get('/state', requireModuleAccess, async (req, res) => {
  try {
    const [orders, settings] = await Promise.all([generalOrders(req.user), ensureSettings()]);
    orders.sort((a, b) => String(b.orderNo).localeCompare(String(a.orderNo), undefined, { numeric: true }));
    const keys = orders.map(o => S.normalizeBookingKey(o.orderNo));
    const [plans, bpRows, cardDocs] = await Promise.all([
      BatchPlan.find({ orderKey: { $in: keys } }).lean(),
      BatchBpData.find({ orderKey: { $in: keys } }).lean(),
      BatchCard.find({ orderKey: { $in: keys } }).lean()
    ]);
    const planByKey = new Map(plans.map(p => [p.orderKey, p]));
    const master = [], planVersions = {}, genInfo = {}, knitPlan = {}, bpData = {};
    for (const order of orders) {
      const key = S.normalizeBookingKey(order.orderNo), plan = planByKey.get(key);
      let state = {};
      if (plan) { try { state = JSON.parse(plan.stateJson || '{}'); } catch (_) { state = {}; } }
      master.push({ ...S.bookingFromOrder(order), ...state });
      planVersions[order.orderNo] = plan ? plan.version : 0;
      genInfo[order.orderNo] = { OrderNo: order.orderNo, Buyer: order.buyer || '' };
      if (Array.isArray(order.knittingItems) && order.knittingItems.length) knitPlan[order.orderNo] = S.knittingRowsForDemo(order.knittingItems);
    }
    const orderNoByKey = new Map(orders.map(o => [S.normalizeBookingKey(o.orderNo), o.orderNo]));
    for (const doc of bpRows) {
      const orderNo = orderNoByKey.get(doc.orderKey) || doc.orderNo;
      (bpData[orderNo] = bpData[orderNo] || []).push(doc.row || {});
    }
    const settingMap = Object.fromEntries(settings.map(s => [s.key, s]));
    const cards = [];
    for (const doc of cardDocs) { try { cards.push(JSON.parse(doc.cardJson)); } catch (_) { /* skip damaged record */ } }
    res.json({
      user: { username: req.user.username, role: req.user.role, permissions: req.user.permissions || {} },
      master, planVersions,
      datasets: { genInfo, knitPlan, bpData },
      setup: settingMap.setup?.value || [], flatAllowance: settingMap.flatAllowance?.value || [], unitSetup: settingMap.unitSetup?.value || [],
      settingVersions: { setup: settingMap.setup?.version || 0, flatAllowance: settingMap.flatAllowance?.version || 0, unitSetup: settingMap.unitSetup?.version || 0 },
      cards
    });
  } catch (error) {
    console.error('Batch state error:', error);
    res.status(500).json({ message: 'Could not load Batch Plan data.' });
  }
});

// ==========================================
// POST /api/batch/commit — save changed plans, Setup tables and batch cards
// Body: { plans:[{orderNo, version, state}], settings:{key:{value, version}}, cards:[card] }
// ==========================================
router.post('/commit', requireModuleAccess, parseJson, async (req, res) => {
  try {
    const plans = Array.isArray(req.body?.plans) ? req.body.plans : [];
    const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
    const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
    const username = req.user.username || '';
    if (plans.length > MAX_PLANS_PER_SAVE || cards.length > MAX_CARDS_PER_SAVE) return res.status(400).json({ message: 'Too many changes in one save.' });
    const deny = path => res.status(403).json({ code: 'PERMISSION', message: 'You do not have permission to ' + (ACTION_LABELS[path] || 'change this Setup table') + '.' });

    // ---- validate everything before writing anything ----
    const buyers = await allowedBuyerSet(req.user);
    const orderCache = new Map();
    const findOrder = async orderNo => {
      if (!orderCache.has(orderNo)) orderCache.set(orderNo, await Order.findOne({ orderNo }, { knittingItems: 0 }).lean());
      return orderCache.get(orderNo);
    };
    const noOrderAccess = orderNo => res.status(403).json({ code: 'PERMISSION', message: 'You do not have access to order ' + orderNo + '.' });
    const noFloorAccess = (group, floor) => res.status(403).json({ code: 'PERMISSION', message: floor
      ? 'You do not have access to the ' + floor + ' ' + (group === 'batchCard' ? 'batch cards' : 'batch plan') + '.'
      : 'Only users with the all-orders ' + (group === 'batchCard' ? 'Batch Card' : 'Batch Plan') + ' permission can change this.' });
    const planWrites = [];
    for (const plan of plans) {
      const orderNo = String(plan?.orderNo ?? '').trim(), orderKey = S.normalizeBookingKey(orderNo);
      if (!orderNo || !plan.state || typeof plan.state !== 'object' || Array.isArray(plan.state)) return res.status(400).json({ message: 'Invalid plan data.' });
      const floorError = S.floorPlansError(plan.state);
      if (floorError) return res.status(400).json({ message: floorError });
      const order = await findOrder(orderNo);
      if (buyers && (!order || !buyers.has(order.buyer))) return noOrderAccess(orderNo);
      const existing = await BatchPlan.findOne({ orderKey }).lean();
      const currentVersion = existing ? existing.version : 0;
      if (Number(plan.version) !== currentVersion) {
        return res.status(409).json({ code: 'CONFLICT', message: 'Order ' + orderNo + ' was changed by another user. Reload the page to see the latest plan.' });
      }
      // Before the first save, compare with what GET /state sent (bookingFromOrder defaults), not with nothing.
      let oldState = order ? S.planStateFromBooking(S.bookingFromOrder(order)) : {};
      if (existing) { try { oldState = JSON.parse(existing.stateJson || '{}'); } catch (_) { oldState = {}; } }
      const newState = S.planStateFromBooking(plan.state);
      const { required, touchedScopes } = S.planChangePermissions(oldState, newState);
      for (const floor of touchedScopes) if (!S.canUseFloor(req.user, 'batchPlan', floor)) return noFloorAccess('batchPlan', floor);
      for (const path of required) if (!S.can(req.user, path)) return deny(path);
      planWrites.push({ orderNo, orderKey, existing, newState, version: currentVersion });
    }
    const settingWrites = [];
    for (const [key, entry] of Object.entries(settings)) {
      if (!SETTING_PERMISSIONS[key]) return res.status(400).json({ message: 'Unknown Setup table.' });
      if (!S.can(req.user, SETTING_PERMISSIONS[key])) return deny(SETTING_PERMISSIONS[key]);
      if (!Array.isArray(entry?.value)) return res.status(400).json({ message: 'Invalid Setup data.' });
      const existing = await BatchSetting.findOne({ key }).lean();
      if ((existing?.version || 0) !== Number(entry.version)) {
        return res.status(409).json({ code: 'CONFLICT', message: 'This Setup table was changed by another user. Reload the page to see the latest values.' });
      }
      settingWrites.push({ key, value: entry.value, version: existing?.version || 0 });
    }
    if (cards.length && !S.can(req.user, 'actions.batchCardGenerate')) return deny('actions.batchCardGenerate');
    for (const card of cards) {
      if (!card || typeof card !== 'object' || typeof card.id !== 'string') return res.status(400).json({ message: 'Invalid batch card data.' });
      // The id must be the one the page builds from (order, floor, batch), so a card cannot replace another order's card.
      if (card.id !== S.cardKey(card.number, card.floor, card.batchId)) return res.status(400).json({ message: 'Invalid batch card id.' });
      if (!S.canUseFloor(req.user, 'batchCard', card.floor)) return noFloorAccess('batchCard', card.floor);
      if (buyers) {
        const order = await findOrder(String(card.number ?? '').trim());
        if (!order || !buyers.has(order.buyer)) return noOrderAccess(card.number);
      }
    }

    // ---- write (optimistic version checks again at write time) ----
    const planVersions = {}, settingVersions = {};
    for (const write of planWrites) {
      const stateJson = JSON.stringify(write.newState);
      if (write.existing) {
        const result = await BatchPlan.updateOne({ orderKey: write.orderKey, version: write.version },
          { $set: { stateJson, orderNo: write.orderNo, updatedBy: username }, $inc: { version: 1 } });
        if (!result.matchedCount) return res.status(409).json({ code: 'CONFLICT', message: 'Order ' + write.orderNo + ' was changed by another user. Reload the page to see the latest plan.' });
      } else {
        try { await BatchPlan.create({ orderKey: write.orderKey, orderNo: write.orderNo, stateJson, version: 1, updatedBy: username }); }
        catch (error) {
          if (error.code === 11000) return res.status(409).json({ code: 'CONFLICT', message: 'Order ' + write.orderNo + ' was changed by another user. Reload the page to see the latest plan.' });
          throw error;
        }
      }
      planVersions[write.orderNo] = write.version + 1;
    }
    for (const write of settingWrites) {
      const result = await BatchSetting.updateOne({ key: write.key, version: write.version },
        { $set: { value: write.value, updatedBy: username }, $inc: { version: 1 } });
      if (!result.matchedCount) return res.status(409).json({ code: 'CONFLICT', message: 'This Setup table was changed by another user. Reload the page to see the latest values.' });
      settingVersions[write.key] = write.version + 1;
    }
    for (const card of cards) {
      await BatchCard.updateOne({ cardId: card.id },
        { $set: { cardJson: JSON.stringify(card), orderKey: S.normalizeBookingKey(card.number), updatedBy: username } }, { upsert: true });
    }
    res.json({ planVersions, settingVersions });
  } catch (error) {
    console.error('Batch commit error:', error);
    res.status(500).json({ message: 'Could not save Batch Plan data.' });
  }
});

module.exports = router;
