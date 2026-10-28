/* Batch Plan module API (/api/batch).
   Additive: reads Order / DeptValidOrders / OrderDate / DropdownMaster, writes only the new Batch* collections. */
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const DeptValidOrders = require('../models/DeptValidOrders');
const OrderDate = require('../models/OrderDate');
const DropdownMaster = require('../models/DropdownMaster');
const BatchPlan = require('../models/BatchPlan');
const BatchSetting = require('../models/BatchSetting');
const BatchCard = require('../models/BatchCard');
const BatchBpData = require('../models/BatchBpData');
const { authenticateToken } = require('../middleware/auth');
const S = require('../lib/batch/source');
const SETUP_DEFAULTS = require('../lib/batch/setup-defaults');

// Plan snapshots can be large; this router parses its own JSON (mounted before the global parser).
// The token is checked first, so only signed-in users can send a large body.
router.use(authenticateToken);
const parseJson = express.json({ limit: '25mb' });
const MAX_PLANS_PER_SAVE = 1000, MAX_CARDS_PER_SAVE = 5000;

const SETTING_PERMISSIONS = { setup: 'menus.dataManagement.dyeingMc', flatAllowance: 'menus.dataManagement.flatAllowance', unitSetup: 'menus.dataManagement.unitSetup' };
const ACTION_LABELS = {
  'actions.batchEdit': 'edit batch plans', 'actions.batchTentative': 'make a batch plan Tentative',
  'actions.batchConfirm': 'confirm or re-confirm batch plans', 'actions.batchInternalChange': 'approve Internal change',
  'actions.batchMovePending': 'move a batch plan to Pending', 'actions.batchCardGenerate': 'generate batch cards'
};

function requireModuleAccess(req, res, next) {
  if (S.hasBatchAccess(req.user)) return next();
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

/* Setup tables (Dyeing MC, Flat Allowance, Unit Setup) start with the demo's defaults (plan section 15.3).
   A missing table is created with them. A table that is still the empty record no user ever saved
   (version 1, updatedBy 'system') is filled once; its version goes up, so a page opened before that
   gets the "changed by another user" message instead of saving the empty table again.
   A table a user has saved (version 2 or more) is never touched, even when it is empty. */
async function ensureSettings() {
  const existing = await BatchSetting.find({}).lean();
  const byKey = new Map(existing.map(s => [s.key, s]));
  for (const key of ['setup', 'flatAllowance', 'unitSetup']) {
    const doc = byKey.get(key);
    if (!doc) {
      try { await BatchSetting.create({ key, value: SETUP_DEFAULTS[key], version: 1, updatedBy: 'system' }); }
      catch (error) { if (error.code !== 11000) throw error; }
    } else if (doc.version === 1 && doc.updatedBy === 'system' && Array.isArray(doc.value) && doc.value.length === 0) {
      await BatchSetting.updateOne({ key, version: 1, updatedBy: 'system', value: { $size: 0 } },
        { $set: { value: SETUP_DEFAULTS[key] }, $inc: { version: 1 } });
    }
  }
  return BatchSetting.find({}).lean();
}

// Units for Unit Setup: Dropdown Master Setup's UNIT list (ACTIVE and HIDDEN, in its own order).
// Same defaults as routes/dropdowns.js when that list was never created; nothing is written here.
const DEFAULT_UNITS = ['EFL', 'EKL', 'Ext', 'Outside'];
async function unitOptions() {
  const docs = await DropdownMaster.find({ type: 'UNIT' }, { name: 1, status: 1 }).sort({ createdAt: 1 }).lean();
  if (!docs.length) return DEFAULT_UNITS.map(name => ({ name, status: 'ACTIVE' }));
  return docs.map(doc => ({ name: String(doc.name || '').trim(), status: doc.status || 'ACTIVE' })).filter(unit => unit.name);
}

// Every buyer in the uploaded orders, once, for Unit Setup (plan section 15.5).
const NOT_A_BUYER = new Set(['', 'UNDEFINED', 'N/A', 'GENERAL', 'PENDING', 'UNKNOWN']);
async function buyerNames() {
  const names = new Map();
  for (const value of await Order.distinct('buyer')) {
    const name = String(value ?? '').trim().replace(/\s+/g, ' ');
    const key = S.unitBuyerKey(name);
    if (!NOT_A_BUYER.has(key) && !names.has(key)) names.set(key, name);
  }
  return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
}

const ORDER_FIELDS = {
  orderNo: 1, buyer: 1, buyerTeam: 1, bookingDate: 1, eventDay: 1, style: 1, pmc: 1, bookedBy: 1, bookingBy: 1,
  floor: 1, gmtUnit: 1, brush: 1, peach: 1, heatset: 1, knitStart: 1, knitEnd: 1, dyeStart: 1, dyeEnd: 1,
  deliStart: 1, deliEnd: 1, ship1: 1, shipLast: 1, fabricNotes: 1, pmcNotes: 1,
  knittingPlanStatus: 1, dyeingPlanStatus: 1, deliveryPlanStatus: 1, knittingItems: 1, dyeingItems: 1
};
// For the sidebar unit list only: the knitting colour headers the unit rule reads (exact names, as the demo's
// firstUploadedValue reads them) instead of whole knitting rows, to keep memory low on every page load.
const UNIT_ORDER_FIELDS = {
  orderNo: 1, buyer: 1, floor: 1, dyeingItems: 1,
  'knittingItems.Color': 1, 'knittingItems.Colour': 1, 'knittingItems.Shade': 1, 'knittingItems.Color Name': 1, 'knittingItems.Colour Name': 1
};
async function generalOrders(user, fields = ORDER_FIELDS) {
  const valid = await DeptValidOrders.findOne({ dept: 'general' }).lean();
  const filter = valid?.validOrderNos?.length ? { orderNo: { $in: valid.validOrderNos } } : {};
  const buyers = await allowedBuyerSet(user);
  if (buyers) filter.buyer = { $in: Array.from(buyers) };
  return Order.find(filter, fields).lean();
}

/* Units of these orders' knitting rows, from the Dyeing Plan unit (plan section 16.3), and the data they
   need: the latest Dyeing file's order list and the saved Dyeing Plan units. */
// Only what the Dyeing screen's unit rule reads from a saved Dyeing row (lib/batch/source.js dyeingScreenUnits).
const UNIT_DATE_FIELDS = { orderNo: 1, 'dyeing.itemId': 1, 'dyeing.itemData.Unit': 1, 'dyeing.itemData.Color': 1 };
// For GET /state also the saved plan dates (lib/batch/source.js modulePlanDates, plan section 17).
const PLAN_DATE_FIELDS = { ...UNIT_DATE_FIELDS,
  'knitting.planType': 1, 'knitting.startDate': 1, 'knitting.endDate': 1,
  'dyeing.planType': 1, 'dyeing.startDate': 1, 'dyeing.endDate': 1,
  'delivery.planType': 1, 'delivery.floorPlanType': 1, 'delivery.startDate': 1, 'delivery.endDate': 1, 'delivery.floorStartDate': 1, 'delivery.floorEndDate': 1 };
async function orderUnits(orders, fields = UNIT_DATE_FIELDS) {
  const [dyeingValid, orderDates] = await Promise.all([
    DeptValidOrders.findOne({ dept: 'dyeing' }).lean(),
    OrderDate.find({ orderNo: { $in: orders.map(o => o.orderNo) } }, fields).lean()
  ]);
  // Like the Dyeing Plan list, only orders in the latest Dyeing file use their Dyeing rows; the others use the General 'Unit'.
  const dyeingOrders = dyeingValid?.validOrderNos?.length ? new Set(dyeingValid.validOrderNos) : null;
  const orderDateByNo = new Map(orderDates.map(doc => [doc.orderNo, doc]));
  return { ...S.unitsForOrders(orders, { orderDateByNo, dyeingOrders }), orderDateByNo };
}

/* Units that these orders' saved plans and cards keep in the sidebar: the same rules as GET /state
   (S.planRetainedUnits, S.cardRetainedUnit). Each record stores its units when it is saved, so the sidebar
   list does not parse every saved plan on each page load. A record saved before these fields existed, or a
   plan saved since by an older server (its version moved on), is read once here and its fields are filled
   in, without changing its version or updatedAt. */
async function retainedUnits(orderKeys) {
  const units = new Set();
  const [plans, cards] = await Promise.all([
    BatchPlan.find({ orderKey: { $in: orderKeys } }, { orderKey: 1, version: 1, retainedUnits: 1, retainedVersion: 1 }).lean(),
    BatchCard.find({ orderKey: { $in: orderKeys } }, { cardId: 1, retainedUnit: 1 }).lean()
  ]);
  const stalePlans = [], staleCards = [];
  for (const plan of plans) {
    if (plan.retainedVersion === plan.version && Array.isArray(plan.retainedUnits)) plan.retainedUnits.forEach(unit => units.add(unit));
    else stalePlans.push(plan.orderKey);
  }
  for (const card of cards) {
    if (typeof card.retainedUnit !== 'string') staleCards.push(card.cardId);
    else if (card.retainedUnit) units.add(card.retainedUnit);
  }
  const saveFields = (Model, ops) => ops.length && Model.bulkWrite(ops, { ordered: false, timestamps: false })
    .catch(error => console.error('Batch retained units not saved:', error));
  // In small groups, so only a few saved plans are parsed at a time.
  for (let i = 0; i < stalePlans.length; i += 100) {
    const docs = await BatchPlan.find({ orderKey: { $in: stalePlans.slice(i, i + 100) } }, { orderKey: 1, version: 1, stateJson: 1 }).lean();
    await saveFields(BatchPlan, docs.map(doc => {
      let state = {};
      try { state = JSON.parse(doc.stateJson || '{}'); } catch (_) { state = {}; }
      const kept = S.planRetainedUnits(state);
      kept.forEach(unit => units.add(unit));
      return { updateOne: { filter: { orderKey: doc.orderKey, version: doc.version }, update: { $set: { retainedUnits: kept, retainedVersion: doc.version } } } };
    }));
  }
  for (let i = 0; i < staleCards.length; i += 200) {
    const docs = await BatchCard.find({ cardId: { $in: staleCards.slice(i, i + 200) } }, { cardId: 1, cardJson: 1 }).lean();
    await saveFields(BatchCard, docs.map(doc => {
      let card = null;
      try { card = JSON.parse(doc.cardJson); } catch (_) { card = null; }
      const unit = S.cardRetainedUnit(card);
      if (unit) units.add(unit);
      return { updateOne: { filter: { cardId: doc.cardId, retainedUnit: { $exists: false } }, update: { $set: { retainedUnit: unit } } } };
    }));
  }
  return units;
}

// ==========================================
// GET /api/batch/units — the unit submenus for the project sidebar (plan section 16.3).
// Never answers 403: the project page logs the user out on any 403, so a user without Batch access gets [].
// ==========================================
router.get('/units', async (req, res) => {
  try {
    if (!S.hasBatchAccess(req.user)) return res.json({ units: [] });
    const orders = await generalOrders(req.user, UNIT_ORDER_FIELDS);
    const [{ usedKeys }, dropdownUnits, kept] = await Promise.all([
      orderUnits(orders), unitOptions(), retainedUnits(orders.map(o => S.normalizeBookingKey(o.orderNo)))
    ]);
    // Same list as GET /state's batchUnits: units of the rows, then units kept by plans and cards.
    for (const unit of kept) if (!usedKeys.has(unit)) usedKeys.set(unit, unit);
    res.json({ units: S.orderedUnits(usedKeys, dropdownUnits) });
  } catch (error) {
    console.error('Batch units error:', error);
    res.status(500).json({ message: 'Could not load Batch Plan units.' });
  }
});

// ==========================================
// GET /api/batch/state — everything the Batch Plan page needs (demo appState shape)
// ==========================================
router.get('/state', requireModuleAccess, async (req, res) => {
  // Plan section 18.10: the time of each phase goes into a Server-Timing header (DevTools > Network, and the
  // page's load summary), so a slow load can be traced to the database, the build or the download.
  const started = Date.now(), phases = [];
  let mark = started;
  const phase = name => { const now = Date.now(); phases.push(name + ';dur=' + (now - mark)); mark = now; };
  try {
    const [orders, settings] = await Promise.all([generalOrders(req.user), ensureSettings()]);
    phase('orders');
    orders.sort((a, b) => String(b.orderNo).localeCompare(String(a.orderNo), undefined, { numeric: true }));
    const keys = orders.map(o => S.normalizeBookingKey(o.orderNo));
    const canSetUnits = S.can(req.user, 'menus.dataManagement.unitSetup');
    const [plans, bpRows, cardDocs, { usedKeys, keysByOrder, orderDateByNo }, units, buyers] = await Promise.all([
      BatchPlan.find({ orderKey: { $in: keys } }).lean(),
      BatchBpData.find({ orderKey: { $in: keys } }).lean(),
      BatchCard.find({ orderKey: { $in: keys } }).lean(),
      orderUnits(orders, PLAN_DATE_FIELDS),
      unitOptions(),
      canSetUnits ? buyerNames() : Promise.resolve([])
    ]);
    phase('plans');
    const planByKey = new Map(plans.map(p => [p.orderKey, p]));
    const settingMap = Object.fromEntries(settings.map(s => [s.key, s]));
    const master = [], planVersions = {}, genInfo = {}, knitPlan = {}, bpData = {};
    for (const order of orders) {
      const key = S.normalizeBookingKey(order.orderNo), plan = planByKey.get(key);
      let state = {};
      if (plan) { try { state = JSON.parse(plan.stateJson || '{}'); } catch (_) { state = {}; } }
      master.push({ ...S.bookingFromOrder(order, S.modulePlanDates(orderDateByNo.get(order.orderNo))), ...state });
      planVersions[order.orderNo] = plan ? plan.version : 0;
      genInfo[order.orderNo] = { OrderNo: order.orderNo, Buyer: order.buyer || '' };
      // A unit with a confirmed plan keeps its submenu even when no row is on it now: the page keeps such an
      // order on that unit through its confirmed snapshot rows, so it can still be opened (plan section 16.3).
      for (const unit of S.planRetainedUnits(state)) if (!usedKeys.has(unit)) usedKeys.set(unit, unit);
      // Each knitting row's floor = the unit the Dyeing Plan shows for its colour (plan section 16.3).
      const rowKeys = keysByOrder.get(order.orderNo);
      if (rowKeys) knitPlan[order.orderNo] = S.knittingRowsForDemo(order.knittingItems, (row, index) => (rowKeys[index] ? S.unitRowText(rowKeys[index]) : ''));
    }
    const orderNoByKey = new Map(orders.map(o => [S.normalizeBookingKey(o.orderNo), o.orderNo]));
    for (const doc of bpRows) {
      const orderNo = orderNoByKey.get(doc.orderKey) || doc.orderNo;
      (bpData[orderNo] = bpData[orderNo] || []).push(doc.row || {});
    }
    const cards = [];
    for (const doc of cardDocs) { try { cards.push(JSON.parse(doc.cardJson)); } catch (_) { /* skip damaged record */ } }
    // A unit that still has a batch card that is not superseded keeps its submenu, so the card stays reachable.
    for (const card of cards) {
      const unit = S.cardRetainedUnit(card);
      if (unit && !usedKeys.has(unit)) usedKeys.set(unit, unit);
    }
    const batchUnits = S.orderedUnits(usedKeys, units);
    phase('build');
    const body = JSON.stringify({
      user: { username: req.user.username, role: req.user.role, permissions: req.user.permissions || {} },
      master, planVersions,
      datasets: { genInfo, knitPlan, bpData },
      setup: settingMap.setup?.value || [], flatAllowance: settingMap.flatAllowance?.value || [], unitSetup: settingMap.unitSetup?.value || [],
      settingVersions: { setup: settingMap.setup?.version || 0, flatAllowance: settingMap.flatAllowance?.version || 0, unitSetup: settingMap.unitSetup?.version || 0 },
      cards,
      // The unit tabs in the page heading, [{key, label}] (plan sections 16.3 and 18).
      batchUnits,
      // Unit Setup page: the Dropdown Master units and every buyer (buyers only for users who can edit Unit Setup).
      units, buyers
    });
    phase('json');
    phases.push('total;dur=' + (Date.now() - started), 'orders-count;desc="' + orders.length + ' orders, ' + Math.round(body.length / 1024) + ' KB"');
    res.set({
      'Server-Timing': phases.join(', '),
      // Lets the page read the timings and the response size from a different origin (the frontend host).
      'Access-Control-Expose-Headers': 'Server-Timing',
      'Timing-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.type('application/json').send(body);
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
      if (key === 'unitSetup') {
        const activeUnits = (await unitOptions()).filter(unit => unit.status === 'ACTIVE').map(unit => unit.name);
        const unitError = S.unitSetupError(entry.value, existing?.value || [], activeUnits);
        if (unitError) return res.status(400).json({ message: unitError });
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
      // The units this plan keeps in the sidebar, for GET /units (retainedUnits above).
      const retained = { retainedUnits: S.planRetainedUnits(write.newState), retainedVersion: write.version + 1 };
      if (write.existing) {
        const result = await BatchPlan.updateOne({ orderKey: write.orderKey, version: write.version },
          { $set: { stateJson, orderNo: write.orderNo, updatedBy: username, ...retained }, $inc: { version: 1 } });
        if (!result.matchedCount) return res.status(409).json({ code: 'CONFLICT', message: 'Order ' + write.orderNo + ' was changed by another user. Reload the page to see the latest plan.' });
      } else {
        try { await BatchPlan.create({ orderKey: write.orderKey, orderNo: write.orderNo, stateJson, version: 1, updatedBy: username, ...retained }); }
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
        { $set: { cardJson: JSON.stringify(card), orderKey: S.normalizeBookingKey(card.number), updatedBy: username, retainedUnit: S.cardRetainedUnit(card) } }, { upsert: true });
    }
    res.json({ planVersions, settingVersions });
  } catch (error) {
    console.error('Batch commit error:', error);
    res.status(500).json({ message: 'Could not save Batch Plan data.' });
  }
});

module.exports = router;
