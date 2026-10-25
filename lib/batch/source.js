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

/* floorOf(row) (optional) replaces the floor read from the Knitting 'Floor' (AC) column.
   Only _fabricColumns.floor changes: no new key is added to a row, because the page's
   Need Re-Confirm fingerprint covers every key of the row. */
function knittingRowsForDemo(items, floorOf = null) {
  return (Array.isArray(items) ? items : []).map(row => {
    const copy = { ...row };
    delete copy._fabricColumns;
    const fabricColumns = fabricColumnsFromRow(copy);
    if (floorOf) fabricColumns.floor = floorOf(copy);
    return { ...copy, _fabricColumns: fabricColumns };
  });
}

/* ---------------- Batch floor from the Dyeing Plan unit (plan section 15.4) ---------------- */
// Same aliases as the demo's BATCH_FLOORS (js/batch/batch-app.js).
const FLOOR_ALIASES = {
  EFL: ['EFL', 'EFL Floor', 'Epyllion Fabrics Limited'],
  EKL: ['EKL', 'EKL Floor', 'Epyllion Knitex Limited'],
  EXT: ['Ext', 'Ext Floor', 'EFL-Ext', 'EFL Ext', 'Extension', 'Extension Floor'],
  PLUVIA: ['Pluvia', 'Pluvia Wash', 'Pluvia Washing'],
  OUTSIDE: ['Outside', 'Outside Dyeing', 'Outside Dyeing Floor', 'Out Side', 'Out Side Dyeing', 'Outsource', 'Outsourcing', 'Subcontract', 'Subcontract Dyeing']
};
// Plan question 1: units of outside dyeing houses (for example DTL, GTL, NRG, PCTL, GUMTI, Pretty)
// go to Outside Dyeing only when they are listed here. Empty until the user confirms them.
const OUTSIDE_DYEING_UNITS = [];
const floorValueKey = value => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const FLOOR_BY_UNIT = new Map([
  ...Object.entries(FLOOR_ALIASES).flatMap(([floor, aliases]) => aliases.map(alias => [floorValueKey(alias), floor])),
  ...OUTSIDE_DYEING_UNITS.map(unit => [floorValueKey(unit), 'OUTSIDE'])
]);
// Written into _fabricColumns.floor. The first alias is how the Knitting AC column spells each
// floor (EFL, EKL, Ext, Pluvia, Outside), so a row that stays on its floor keeps its fingerprint.
const FLOOR_TEXT = Object.fromEntries(Object.entries(FLOOR_ALIASES).map(([floor, aliases]) => [floor, aliases[0]]));

/* Unit -> Batch floor key, or '' when no part of it is a Batch floor.
   Combined values such as "EKL+DTL" or "EFL + Outside" are split on '+' and the first part
   that is a floor wins. The whole text is never matched at once: "EFL+Ext" would read as EXT. */
function floorFromUnit(unit) {
  for (const part of String(unit ?? '').split('+')) {
    const floor = FLOOR_BY_UNIT.get(floorValueKey(part));
    if (floor) return floor;
  }
  return '';
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

// Buyer -> default unit from Unit Setup, the way the page's unitForBuyer reads it (first row that is not hidden).
function unitDefaultsMap(unitSetupRows) {
  const defaults = new Map();
  for (const row of Array.isArray(unitSetupRows) ? unitSetupRows : []) {
    if (!row || row.hidden) continue;
    const key = unitBuyerKey(row.buyer);
    if (key && !defaults.has(key)) defaults.set(key, String(row.unit ?? '').trim());
  }
  return defaults;
}

/* Returns floorOf(knittingRow) for one order (plan section 15.4):
   1. the unit the Dyeing Plan shows for the row's colour (first Dyeing row of that colour);
      orders not in the latest Dyeing file, and colours without a Dyeing row, use the General 'Unit';
   2. a blank unit uses the buyer's default from Unit Setup;
   3. a unit that is not a Batch floor (plan question 1) leaves the row without a floor.
   The result is the floor text written into _fabricColumns.floor, or '' for no floor. */
function knittingFloorResolver({ order, orderDate = null, useDyeingRows = false, unitDefaults = new Map() }) {
  const unitByColour = new Map();
  if (useDyeingRows) {
    for (const { colour, unit } of dyeingScreenUnits(order, orderDate)) if (!unitByColour.has(colour)) unitByColour.set(colour, unit);
  }
  const generalUnit = String(order?.floor ?? '').trim();
  const buyerDefault = unitDefaults.get(unitBuyerKey(order?.buyer)) || '';
  return row => {
    const colour = colourKey(KNITTING_COLOUR_HEADERS.map(header => row[header]).find(value => value !== undefined && value !== null && String(value).trim() !== ''));
    const unit = unitByColour.has(colour) ? unitByColour.get(colour) : generalUnit;
    const floor = floorFromUnit(unit || buyerDefault);
    return floor ? FLOOR_TEXT[floor] : '';
  };
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

/* General file fields that the demo builds a booking from (see plan section 4.1).
   These are always rebuilt from the latest upload and never stored with the plan. */
const SOURCE_KEYS = ['number', 'buyer', 'team', 'date', 'eventDay', 'style', 'pmc', 'merchant', 'unit',
  'brush', 'peach', 'heatset', 'knitStart', 'knitEnd', 'dyeStart', 'dyeEnd', 'deliveryStart', 'deliveryEnd',
  'knittingPlan', 'dyeingPlan', 'deliveryPlan', 'instructions', 'fabric', 'batches', 'recipe', 'lastRevised'];

function bookingFromOrder(order) {
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
    knitStart: displayDate(order.knitStart), knitEnd: displayDate(order.knitEnd),
    dyeStart: displayDate(order.dyeStart), dyeEnd: displayDate(order.dyeEnd),
    deliveryStart: displayDate(order.deliStart || order.ship1),
    deliveryEnd: displayDate(order.deliEnd || order.shipLast),
    // Project addition (plan question 3): live statuses of the existing plan modules.
    knittingPlan: text(order.knittingPlanStatus), dyeingPlan: text(order.dyeingPlanStatus), deliveryPlan: text(order.deliveryPlanStatus),
    lastRevised: '—', batchDate: '', revisedBatch: '—',
    fabric: [], batches: [], recipe: [],
    instructions: [order.fabricNotes, order.pmcNotes].map(text).filter(Boolean)
  };
}

// Saved plan state = booking minus the General file fields.
/* Returns an error text when floorPlans holds anything other than plain objects under the five floors. */
function floorPlansError(state) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (state.floorPlans === undefined) return '';
  if (!isObject(state.floorPlans)) return 'Invalid floor plan data.';
  for (const [floor, plan] of Object.entries(state.floorPlans)) {
    if (!FLOOR_KEYS.includes(floor)) return 'Unknown floor "' + floor + '" in the plan.';
    if (!isObject(plan)) return 'Invalid plan data for floor ' + floor + '.';
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
  for (const floor of [null, ...FLOOR_KEYS]) {
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

/* Menu permission for one plan scope: the root (all floors) needs "all", a floor needs "all" or that floor. */
function canUseFloor(user, group, floor) {
  return can(user, 'menus.' + group + '.all') || (!!floor && can(user, 'menus.' + group + '.' + String(floor).toLowerCase()));
}
function cardKey(number, floor, batchId) { return JSON.stringify([normalizeBookingKey(number), floor, batchId]); }

module.exports = {
  FLOOR_KEYS, SOURCE_KEYS, BP_DATA_HEADERS, KNITTING_FABRIC_HEADERS,
  normalizeBookingKey, headerKey, valueByHeaders, fabricColumnsFromRow, knittingRowsForDemo,
  displayDate, bookingFromOrder, planStateFromBooking, floorPlansError, bpHeaderError, groupBpRows,
  can, isAdmin, planChangePermissions, scopeStatus, canUseFloor, cardKey,
  FLOOR_TEXT, floorFromUnit, dyeingScreenUnits, unitDefaultsMap, knittingFloorResolver, unitBuyerKey, unitSetupError
};
