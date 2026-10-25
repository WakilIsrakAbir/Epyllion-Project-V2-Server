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

function knittingRowsForDemo(items) {
  return (Array.isArray(items) ? items : []).map(row => {
    const copy = { ...row };
    delete copy._fabricColumns;
    return { ...copy, _fabricColumns: fabricColumnsFromRow(copy) };
  });
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
  can, isAdmin, planChangePermissions, scopeStatus, canUseFloor, cardKey
};
