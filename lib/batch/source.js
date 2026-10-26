/* Batch Plan module: pure helpers shared by routes/batch.js, routes/upload.js and tests.
   Rules here mirror the Batch Plan demo (Batch_Plan_Single_Code (30).html). */

const FLOOR_KEYS = ['EFL', 'EKL', 'EXT', 'PLUVIA', 'OUTSIDE'];

// Demo: normalizeBookingKey
function normalizeBookingKey(value) {
  return String(value ?? '').trim().toUpperCase()
    .replace(/^(BDS|PPS)[\s-]*/, '').replace(/^-+(?=\d)/, '');
}

const headerKey = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

// First non-empty value whose header matches one of the aliases (case, spaces and symbols ignored).
function valueByHeaders(row, aliases) {
  const values = new Map();
  for (const [key, value] of Object.entries(row || {})) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const normalized = headerKey(key);
    if (!values.has(normalized)) values.set(normalized, value);
  }
  for (const alias of aliases) {
    const key = headerKey(alias);
    if (values.has(key)) return values.get(key);
  }
  return '';
}

/* The demo reads these Knitting Plan cells by physical column letter (C, E, U-AC).
   The project stores rows by header name, so the same values are taken from the
   headers that sit in those columns in the new Knitting Plan file. */
const KNITTING_FABRIC_HEADERS = {
  requiredFinish: ['RequiredQtyKgs', 'Required Qty Kgs', 'Required Qty (Kgs)'],          // E
  construction: ['FabricConstruction', 'Fabric Construction'],                           // C
  peach: ['Peach'],                                                                       // U
  brush: ['Brush'],                                                                       // V
  heatset: ['Heatset', 'Heat Set'],                                                       // W
  yarn: ['Yarn Description', 'Yarn Count', 'Yarn Count & Fabric'],                        // X
  width: ['Fabric Width', 'Width'],                                                       // Y
  gaugeDia: ['Gauge & Dia', 'Gauge Dia', 'Gauge And Dia'],                                // Z
  greyWaste: ['Process Loss', 'Grey Wst.%', 'Grey Waste'],                                // AA
  dryMethod: ['Dry Method'],                                                              // AB
  floor: ['Floor', 'Dyeing Floor']                                                        // AC
};

// Same output as the demo's readKnittingFabricColumns(sheet,row) for the new file layout.
function fabricColumnsFromRow(row) {
  const values = {};
  for (const [field, aliases] of Object.entries(KNITTING_FABRIC_HEADERS)) {
    const value = valueByHeaders(row, aliases);
    if (value === '' || value === null || value === undefined) { values[field] = ''; continue; }
    if (field === 'requiredFinish') values[field] = value;
    else if (field === 'greyWaste') {
      const text = String(value).trim();
      if (text.includes('%')) values[field] = text;
      else if (typeof value === 'number') {
        const percent = Math.abs(value) <= 1 ? value * 100 : value;
        values[field] = Number(percent.toFixed(8)) + '%';
      } else values[field] = text;
    } else values[field] = String(value).trim();
  }
  return values;
}

/* floorOf(row, index) (optional) replaces the floor read from the Knitting 'Floor' (AC) column.
   Only _fabricColumns.floor changes: no new key is added to a row, because the page's
   Need Re-Confirm fingerprint covers every key of the row. */
function knittingRowsForDemo(items, floorOf = null) {
  return (Array.isArray(items) ? items : []).map((row, index) => {
    const copy = { ...row };
    delete copy._fabricColumns;
    const fabricColumns = fabricColumnsFromRow(copy);
    if (floorOf) fabricColumns.floor = floorOf(copy, index);
    return { ...copy, _fabricColumns: fabricColumns };
  });
}

/* ---------------- Batch Plan units from the Dyeing Plan (plan sections 15.4 and 16.3) ----------------
   Every unit set in the Dyeing Plan is its own Batch Plan submenu. A unit's key is its name in capitals
   without spaces or symbols (DTL, NFPL). The demo's five floors keep their keys and old spellings, so
   plans saved before stay where they are: 'Ext', 'EFL-Ext' and 'Extension' are all EXT. */
const FLOOR_ALIASES = {
  EFL: ['EFL', 'EFL Floor', 'Epyllion Fabrics Limited'],
  EKL: ['EKL', 'EKL Floor', 'Epyllion Knitex Limited'],
  EXT: ['Ext', 'Ext Floor', 'EFL-Ext', 'EFL Ext', 'Extension', 'Extension Floor'],
  PLUVIA: ['Pluvia', 'Pluvia Wash', 'Pluvia Washing'],
  OUTSIDE: ['Outside', 'Outside Dyeing', 'Outside Dyeing Floor', 'Out Side', 'Out Side Dyeing', 'Outsource', 'Outsourcing', 'Subcontract', 'Subcontract Dyeing']
};
const floorValueKey = value => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const LEGACY_FLOOR_BY_ALIAS = new Map(Object.entries(FLOOR_ALIASES).flatMap(([floor, aliases]) => aliases.map(alias => [floorValueKey(alias), floor])));
// The Knitting AC spelling of the five old floors. Rows on them keep this text, so their fingerprint does not change.
const FLOOR_TEXT = Object.fromEntries(Object.entries(FLOOR_ALIASES).map(([floor, aliases]) => [floor, aliases[0]]));
const UNIT_KEY_PATTERN = /^[A-Z0-9]{1,40}$/;

/* Unit text -> unit key, or '' for a blank value or a combined value such as "EKL+DTL"
   (plan question 2: such rows stay out of the unit submenus until one unit is set in the Dyeing Plan). */
// Placeholder texts that mean "no unit" (the tracking reports in routes/orders.js skip the same ones).
const NO_UNIT_TEXTS = new Set(['-', 'n/a', 'na', 'select', 'null', 'undefined', 'none', '0']);
function unitKey(unit) {
  const text = String(unit ?? '').trim();
  if (!text || text.includes('+') || NO_UNIT_TEXTS.has(text.toLowerCase())) return '';
  const key = floorValueKey(text);
  // 'ALL' is kept for the all-orders permission (menus.batchPlan.all), so it is never a unit.
  if (!key || key === 'ALL') return '';
  return LEGACY_FLOOR_BY_ALIAS.get(key) || key.slice(0, 40);
}
// Text written into _fabricColumns.floor for a unit key: the old spelling for the five old floors, else the key.
function unitRowText(key) { return FLOOR_TEXT[key] || key; }

// A unit name comes from a spreadsheet cell or Dropdown Master Setup. Characters that could form markup are
// dropped, as the project pages do, so no page can render a unit name as HTML.
function unitLabel(text, key) {
  return String(text ?? '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || key;
}

/* The submenu list: [{key, label}] for the used keys. Units in Dropdown Master Setup come first, in its
   order and with its name; other units follow by name (old floors with their old spelling). */
function orderedUnits(usedKeys, dropdownUnits = []) {
  const dropdownNames = new Map();
  for (const unit of dropdownUnits) {
    const key = unitKey(unit && unit.name);
    if (key && !dropdownNames.has(key)) dropdownNames.set(key, unitLabel(unit.name, key));
  }
  const listed = [];
  for (const [key, name] of dropdownNames) if (usedKeys.has(key)) listed.push({ key, label: name });
  const others = Array.from(usedKeys.keys()).filter(key => !dropdownNames.has(key))
    .map(key => ({ key, label: FLOOR_TEXT[key] || unitLabel(usedKeys.get(key), key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...listed, ...others];
}

/* A unit also keeps its submenu while an order still shows on it without rows there (plan section 16.3),
   by the page's own rules: a Confirm plan whose confirmed snapshot has rows (hasOrderOnFloor in
   batch-app.js), or a batch card that is not superseded. */
function planRetainedUnits(state) {
  const plans = state && state.floorPlans && typeof state.floorPlans === 'object' && !Array.isArray(state.floorPlans) ? state.floorPlans : {};
  return Object.entries(plans)
    .filter(([unit, plan]) => UNIT_KEY_PATTERN.test(unit) && plan?.status === 'Confirm' && !!plan.confirmedSnapshot?.sourceRows?.length)
    .map(([unit]) => unit);
}
function cardRetainedUnit(card) {
  const unit = String(card?.floor || '');
  return card && card.status !== 'superseded' && UNIT_KEY_PATTERN.test(unit) ? unit : '';
}

// Same column lookup as the frontend getColData (js/utils.js): header case, spaces and symbols are
// ignored, a later duplicate header wins, and the first matching alias is used even when empty.
function columnValue(row, aliases) {
  const map = {};
  for (const key in row || {}) map[headerKey(key)] = key;
  for (const alias of aliases) {
    const actual = map[headerKey(alias)];
    if (actual !== undefined) return row[actual] === undefined || row[actual] === null ? '' : row[actual];
  }
  return '';
}
// Frontend generateItemId (js/data-processing.js) for a Dyeing Plan row.
function dyeingItemId(itemData) {
  const orderNo = String(itemData.OrderNo ?? 'N/A').trim();
  const colour = String(itemData.Color ?? 'N/A').trim();
  let process = String(itemData.ProcessName ?? itemData['Process Name'] ?? '').trim();
  if (process.toLowerCase() === 'n/a' || process === '-') process = '';
  return `${orderNo}_${colour}_${process}`.toLowerCase().replace(/\s+/g, '');
}
const colourKey = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const unitBuyerKey = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

/* The Unit each Dyeing Plan row shows on the Dyeing Plan screen, worked out exactly as
   js/detailed-view.js does it: the Excel 'Unit', replaced by a saved unit (matched by item id,
   then by the id without a trailing '_' or '_n/a', then by colour), else the General 'Unit'.
   Returns [{colour, unit}] in file order. Nothing is written back. */
function dyeingScreenUnits(order, orderDate) {
  const savedItems = Array.isArray(orderDate?.dyeing) ? orderDate.dyeing : [];
  const byId = new Map();
  savedItems.forEach(item => { if (item && item.itemId) byId.set(item.itemId, item); });
  return (Array.isArray(order?.dyeingItems) ? order.dyeingItems : []).map((row, index) => {
    const itemData = {
      OrderNo: columnValue(row, ['BookingNo', 'OrderNo', 'EWO', 'Booking', 'Order No', 'Booking No']),
      Color: columnValue(row, ['Color', 'Colour', 'Fab Color']),
      Unit: columnValue(row, ['Unit']),
      ProcessName: columnValue(row, ['Process Name', 'ProcessName', 'Process'])
    };
    const itemId = dyeingItemId(itemData) || `item_${index}`;
    let saved = byId.get(itemId);
    if (!saved && savedItems.length > 0) {
      const cleanId = itemId.replace(/(_n\/a|_)$/i, '');
      saved = savedItems.find(item => item && item.itemId && String(item.itemId).toLowerCase().replace(/(_n\/a|_)$/i, '') === cleanId.toLowerCase());
      if (!saved) {
        const colour = String(itemData.Color || '').trim().toLowerCase();
        if (colour) saved = savedItems.find(item => item && item.itemData && String(item.itemData.Color || '').trim().toLowerCase() === colour);
      }
    }
    let unit = itemData.Unit;
    if (saved && saved.itemData && saved.itemData.Unit) unit = saved.itemData.Unit;
    if (!unit && order.floor) unit = order.floor;
    // A 0 or FALSE cell shows as blank on the screen (`itemData.Unit || ''`), so it is blank here too.
    return { colour: colourKey(itemData.Color), unit: String(unit || '').trim() };
  });
}

/* Returns unitOf(knittingRow) -> {key, text} for one order (plan section 16.3): the unit the Dyeing Plan
   shows for the row's colour (first Dyeing row of that colour, whatever the Dyeing Plan status). Orders not
   in the latest Dyeing file, and colours without a Dyeing row, use the General 'Unit', as the Dyeing screen
   does. A blank or combined unit gives key ''. The Unit Setup default is not used (it only feeds Daily Confirm). */
function knittingUnitResolver({ order, orderDate = null, useDyeingRows = false }) {
  const unitByColour = new Map();
  if (useDyeingRows) {
    for (const { colour, unit } of dyeingScreenUnits(order, orderDate)) if (!unitByColour.has(colour)) unitByColour.set(colour, unit);
  }
  const generalUnit = String(order?.floor ?? '').trim();
  return row => {
    const colour = colourKey(KNITTING_COLOUR_HEADERS.map(header => row[header]).find(value => value !== undefined && value !== null && String(value).trim() !== ''));
    const text = unitByColour.has(colour) ? unitByColour.get(colour) : generalUnit;
    return { key: unitKey(text), text };
  };
}

/* Units used by these orders and the rows' floor text. orders: lean Order docs with knittingItems and
   dyeingItems. Returns {usedKeys: Map(key -> first spelling), keysByOrder: Map(orderNo -> [key per knitting row])}. */
function unitsForOrders(orders, { orderDateByNo = new Map(), dyeingOrders = null } = {}) {
  const usedKeys = new Map(), keysByOrder = new Map();
  for (const order of orders) {
    const items = Array.isArray(order.knittingItems) ? order.knittingItems : [];
    if (!items.length) continue;
    const useDyeingRows = (!dyeingOrders || dyeingOrders.has(order.orderNo)) && Array.isArray(order.dyeingItems) && order.dyeingItems.length > 0;
    const unitOf = knittingUnitResolver({ order, orderDate: orderDateByNo.get(order.orderNo), useDyeingRows });
    const keys = items.map(row => {
      const { key, text } = unitOf(row);
      if (key && !usedKeys.has(key)) usedKeys.set(key, String(text).trim());
      return key;
    });
    keysByOrder.set(order.orderNo, keys);
  }
  return { usedKeys, keysByOrder };
}
// The demo's APP_SETTINGS.colorHeaders, read with firstUploadedValue (exact header names).
const KNITTING_COLOUR_HEADERS = ['Color', 'Colour', 'Shade', 'Color Name', 'Colour Name'];

/* Unit Setup rows sent by the page (plan section 15.5). Returns an error text or ''.
   A new or changed default must be an ACTIVE Dropdown Master unit; a row that keeps its saved
   unit is accepted even if that unit was hidden later. */
function unitSetupError(rows, savedRows, activeUnits) {
  if (rows.length > 5000) return 'Unit Setup has too many rows.';
  const active = new Set(activeUnits.map(unit => String(unit).trim().toLowerCase()));
  const saved = new Map();
  for (const row of Array.isArray(savedRows) ? savedRows : []) {
    const key = unitBuyerKey(row?.buyer);
    if (key && !saved.has(key)) saved.set(key, String(row?.unit ?? '').trim().toLowerCase());
  }
  const ids = new Set(), buyers = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return 'Invalid Unit Setup row.';
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const buyer = typeof row.buyer === 'string' ? row.buyer.trim() : '';
    const unit = typeof row.unit === 'string' ? row.unit.trim() : '';
    if (!id || id.length > 100 || ids.has(id)) return 'Invalid Unit Setup row id.';
    if (!buyer || buyer.length > 200) return 'Every Unit Setup row needs a buyer.';
    if (!unit || unit.length > 100) return 'Select a Unit for ' + buyer + '.';
    if (row.hidden !== undefined && typeof row.hidden !== 'boolean') return 'Invalid Unit Setup row.';
    const key = unitBuyerKey(buyer);
    if (buyers.has(key)) return 'Buyer ' + buyer + ' appears twice in Unit Setup.';
    ids.add(id); buyers.add(key);
    if (saved.get(key) !== unit.toLowerCase() && !active.has(unit.toLowerCase())) {
      return 'Unit "' + unit + '" is not an active unit in Dropdown Master Setup.';
    }
  }
  return '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Demo shows Excel dates as en-GB "04 Jan 2026"; the project stores ISO "2026-01-04".
function displayDate(value) {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return match[3] + ' ' + MONTHS[Number(match[2]) - 1] + ' ' + match[1];
  return text || '—';
}

/* Plan dates from the saved department rows (plan section 17): for Knitting, Dyeing and Delivery, the
   earliest Start and the latest End of the rows planned Confirm or Tentative, the way the Planning &
   Production Info report shows them (Delivery: the Floor dates, else the plain ones). '' when no row
   is planned, so the General file's T&A date is used instead. */
function modulePlanDates(orderDate) {
  const dateText = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? value.trim().slice(0, 10) : '');
  const range = (rows, floor) => {
    const starts = [], ends = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row) continue;
      const type = String((floor && row.floorPlanType) || row.planType || '').trim();
      if (type !== 'Confirm' && type !== 'Tentative') continue;
      const start = dateText(floor ? row.floorStartDate || row.startDate : row.startDate);
      const end = dateText(floor ? row.floorEndDate || row.endDate : row.endDate);
      if (start) starts.push(start);
      if (end) ends.push(end);
    }
    starts.sort(); ends.sort();
    return [starts[0] || '', ends[ends.length - 1] || ''];
  };
  const [knitStart, knitEnd] = range(orderDate?.knitting, false);
  const [dyeStart, dyeEnd] = range(orderDate?.dyeing, false);
  const [deliveryStart, deliveryEnd] = range(orderDate?.delivery, true);
  return { knitStart, knitEnd, dyeStart, dyeEnd, deliveryStart, deliveryEnd };
}

/* General file fields that the demo builds a booking from (see plan section 4.1).
   These are always rebuilt from the latest upload and never stored with the plan. */
const SOURCE_KEYS = ['number', 'buyer', 'team', 'date', 'eventDay', 'style', 'pmc', 'merchant', 'unit',
  'brush', 'peach', 'heatset', 'knitStart', 'knitEnd', 'dyeStart', 'dyeEnd', 'deliveryStart', 'deliveryEnd',
  'knittingPlan', 'dyeingPlan', 'deliveryPlan', 'instructions', 'fabric', 'batches', 'recipe', 'lastRevised'];

// planDates: the saved module dates (modulePlanDates); a blank one falls back to the General file's T&A date.
function bookingFromOrder(order, planDates = {}) {
  const text = value => (value === null || value === undefined ? '' : String(value).trim());
  return {
    number: text(order.orderNo),
    buyer: text(order.buyer) || 'UNKNOWN',
    team: text(order.buyerTeam) || '—',
    date: displayDate(order.bookingDate),
    status: 'Pending',
    eventDay: text(order.eventDay) || '—',
    style: text(order.style) || '—',
    pmc: text(order.pmc) || '—',
    merchant: text(order.bookedBy) || text(order.bookingBy) || '—',
    unit: text(order.floor) || text(order.gmtUnit),
    brush: text(order.brush), peach: text(order.peach), heatset: text(order.heatset),
    // Plan section 17: dates planned in the Knitting / Dyeing / Delivery modules first, else the T&A dates.
    knitStart: displayDate(planDates.knitStart || order.knitStart), knitEnd: displayDate(planDates.knitEnd || order.knitEnd),
    dyeStart: displayDate(planDates.dyeStart || order.dyeStart), dyeEnd: displayDate(planDates.dyeEnd || order.dyeEnd),
    deliveryStart: displayDate(planDates.deliveryStart || order.deliStart || order.ship1),
    deliveryEnd: displayDate(planDates.deliveryEnd || order.deliEnd || order.shipLast),
    // Project addition (plan question 3): live statuses of the existing plan modules. Kept in section 16:
    // the user's "no link" meant that the Dyeing Plan status must not filter the unit submenus.
    knittingPlan: text(order.knittingPlanStatus), dyeingPlan: text(order.dyeingPlanStatus), deliveryPlan: text(order.deliveryPlanStatus),
    lastRevised: '—', batchDate: '', revisedBatch: '—',
    fabric: [], batches: [], recipe: [],
    instructions: [order.fabricNotes, order.pmcNotes].map(text).filter(Boolean)
  };
}

// Saved plan state = booking minus the General file fields.
/* Returns an error text when floorPlans holds anything other than plain objects under unit keys
   (capital letters and digits, as made by unitKey). */
function floorPlansError(state) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (state.floorPlans === undefined) return '';
  if (!isObject(state.floorPlans)) return 'Invalid floor plan data.';
  for (const [floor, plan] of Object.entries(state.floorPlans)) {
    if (!UNIT_KEY_PATTERN.test(floor)) return 'Unknown unit "' + floor + '" in the plan.';
    if (!isObject(plan)) return 'Invalid plan data for unit ' + floor + '.';
  }
  return '';
}
function planStateFromBooking(booking) {
  const state = {};
  for (const [key, value] of Object.entries(booking || {})) {
    if (SOURCE_KEYS.includes(key) || key === '_version') continue;
    state[key] = value;
  }
  return state;
}

/* ---------------- BP Data ---------------- */
// Demo: BP_DATA_HEADERS
const BP_DATA_HEADERS = {
  order: ['OrderNo', 'Order No', 'Booking No', 'Booking Number'],
  colour: ['Color', 'Colour', 'Shade', 'Color Name', 'Colour Name'],
  details: ['FabricDetails', 'Fabric Details', 'Fabric Description'],
  fabricType: ['FabricType', 'Fabric Type'],
  quantity: ['RequiredQtyPCs', 'Required Qty PCs', 'Required Qty (Pcs)', 'Required Quantity PCs', 'Qty PCs']
};
const BP_REQUIRED_FIELDS = ['order', 'colour', 'details', 'fabricType', 'quantity'];

// Returns the demo's error message, or '' when the headers are complete.
function bpHeaderError(rows) {
  if (!rows.length) return '';
  const headers = new Set(Object.keys(rows[0]).map(headerKey));
  for (const field of BP_REQUIRED_FIELDS) {
    if (!BP_DATA_HEADERS[field].some(header => headers.has(headerKey(header)))) {
      return 'BP Data is missing the ' + BP_DATA_HEADERS[field][0] + ' column.';
    }
  }
  return '';
}

function groupBpRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const number = String(valueByHeaders(row, BP_DATA_HEADERS.order)).trim();
    if (!number) continue;
    const key = normalizeBookingKey(number);
    if (!grouped.has(key)) grouped.set(key, { orderNo: number, rows: [] });
    grouped.get(key).rows.push(row);
  }
  return grouped;
}

/* ---------------- Permissions ---------------- */
function permissionValue(user, path) {
  let node = user && user.permissions;
  for (const part of path.split('.')) node = node && node[part];
  return node === true;
}
function isAdmin(user) { return !!user && user.role === 'Admin'; }
function can(user, path) { return isAdmin(user) || permissionValue(user, path); }

const scopeStatus = (state, floor) => (floor ? state?.floorPlans?.[floor]?.status : undefined) || state?.status || 'Pending';
function scopeContent(state, floor) {
  if (floor) return state?.floorPlans?.[floor] || null;
  const { floorPlans, ...root } = state || {};
  return root;
}
const stable = value => JSON.stringify(value, (key, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]])) : val));

/* Which action permissions a saved plan change needs (plan section 10.4).
   Returns {required: [...], changedScopes: [{floor, from, to}]}. */
function planChangePermissions(oldState, newState) {
  const required = new Set(), changedScopes = [], touchedScopes = [];
  // Every unit that has a plan before or after the change (plan section 16: units are not a fixed list).
  const units = new Set([...Object.keys(oldState?.floorPlans || {}), ...Object.keys(newState?.floorPlans || {})]);
  for (const floor of [null, ...units]) {
    const from = scopeStatus(oldState, floor), to = scopeStatus(newState, floor);
    const before = stable(scopeContent(oldState, floor) || {}), after = stable(scopeContent(newState, floor) || {});
    if (from !== to || before !== after) touchedScopes.push(floor);
    if (from !== to) {
      changedScopes.push({ floor, from, to });
      required.add(to === 'Tentative' ? 'actions.batchTentative' : to === 'Confirm' ? 'actions.batchConfirm' : 'actions.batchMovePending');
    } else if (before !== after) {
      if (to === 'Confirm') {
        const reconfirmed = stable(scopeContent(oldState, floor)?.lastReconfirmation) !== stable(scopeContent(newState, floor)?.lastReconfirmation);
        required.add(reconfirmed ? 'actions.batchConfirm' : 'actions.batchInternalChange');
      } else required.add('actions.batchEdit');
    }
  }
  if (!required.size && stable(oldState || {}) !== stable(newState || {})) required.add('actions.batchEdit');
  return { required: Array.from(required), changedScopes, touchedScopes };
}

/* Menu permission for one plan scope: the root (all units) needs "all", a unit needs "all" or that unit
   (permission key = unit key in small letters, e.g. menus.batchPlan.dtl). */
function canUseFloor(user, group, floor) {
  return can(user, 'menus.' + group + '.all') || (!!floor && can(user, 'menus.' + group + '.' + String(floor).toLowerCase()));
}
// Any Batch Plan, Batch Card, Batch Report or Batch Setup menu permission (unit keys are not a fixed list).
function hasBatchAccess(user) {
  if (isAdmin(user)) return true;
  const menus = (user && user.permissions && user.permissions.menus) || {};
  const anyTrue = group => Object.values(menus[group] || {}).some(value => value === true);
  return anyTrue('batchPlan') || anyTrue('batchCard') || anyTrue('batchReport') ||
    ['dyeingMc', 'flatAllowance', 'unitSetup'].some(key => menus.dataManagement && menus.dataManagement[key] === true);
}
function cardKey(number, floor, batchId) { return JSON.stringify([normalizeBookingKey(number), floor, batchId]); }

module.exports = {
  FLOOR_KEYS, SOURCE_KEYS, BP_DATA_HEADERS, KNITTING_FABRIC_HEADERS,
  normalizeBookingKey, headerKey, valueByHeaders, fabricColumnsFromRow, knittingRowsForDemo,
  displayDate, bookingFromOrder, planStateFromBooking, floorPlansError, bpHeaderError, groupBpRows,
  can, isAdmin, planChangePermissions, scopeStatus, canUseFloor, hasBatchAccess, cardKey,
  FLOOR_TEXT, unitKey, unitRowText, orderedUnits, dyeingScreenUnits, knittingUnitResolver, unitsForOrders,
  planRetainedUnits, cardRetainedUnit, modulePlanDates, unitBuyerKey, unitSetupError
};
