const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const OrderDate = require("../models/OrderDate");
const DeptValidOrders = require("../models/DeptValidOrders");
const { authenticateToken } = require("../middleware/auth");

// Protect all order endpoints with JWT authentication
router.use(authenticateToken);

// Middleware to enforce buyer permissions strictly on the server-side
router.use(async (req, res, next) => {
  try {
    // 1. Admin users have unrestricted access across all buyers
    if (req.user && req.user.role === "Admin") {
      // Optional: Admin can still filter by allowedBuyers query param for UI views
      if (req.query.allowedBuyers) {
        if (req.query.allowedBuyers === "NONE_ASSIGNED") {
          req.allowedRawBuyers = ["_NONE_"];
        } else {
          const ids = req.query.allowedBuyers
            .split(",")
            .filter((x) => x.trim());
          if (ids.length > 0) {
            const rawBuyers = await Order.distinct("buyer");
            const allowedNames = rawBuyers.filter((b) => {
              const id = String(b)
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");
              return ids.includes(id);
            });
            req.allowedRawBuyers =
              allowedNames.length > 0 ? allowedNames : ["_NONE_"];
          }
        }
      }
      return next();
    }

    // 2. Non-Admin users: STRICT server-side enforcement from req.user.permissions.buyers
    const buyerPerms = req.user?.permissions?.buyers;
    if (!buyerPerms || buyerPerms.accessType === "all") {
      req.allowedRawBuyers = undefined; // All buyers allowed
    } else if (
      buyerPerms.accessType === "none" ||
      !buyerPerms.buyerIds ||
      buyerPerms.buyerIds.length === 0
    ) {
      req.allowedRawBuyers = ["_NONE_"];
    } else {
      // accessType === "selected"
      const rawBuyers = await Order.distinct("buyer");
      const allowedNames = rawBuyers.filter((b) => {
        const id = String(b)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        return buyerPerms.buyerIds.includes(id);
      });
      req.allowedRawBuyers =
        allowedNames.length > 0 ? allowedNames : ["_NONE_"];
    }
  } catch (e) {
    console.error("Error processing allowed buyers middleware:", e);
    req.allowedRawBuyers = ["_NONE_"];
  }
  next();
});

// ==========================================================
// GET /api/orders/buyers — Fetch all unique buyer names (filtered by permissions)
// ==========================================================
router.get("/buyers", async (req, res) => {
  try {
    let buyers;
    if (req.allowedRawBuyers) {
      buyers = req.allowedRawBuyers.filter((b) => b && b !== "_NONE_");
    } else {
      const rawBuyers = await Order.distinct("buyer");
      buyers = rawBuyers
        .map((b) => (b ? String(b).trim() : ""))
        .filter(
          (b) =>
            b &&
            b.toUpperCase() !== "UNDEFINED" &&
            b.toUpperCase() !== "N/A" &&
            b.toUpperCase() !== "GENERAL",
        );
    }
    // Sort buyers alphabetically
    buyers.sort((a, b) => a.localeCompare(b));
    res.json(buyers);
  } catch (error) {
    console.error("Error fetching buyers:", error);
    res.status(500).json({ message: "Failed to fetch buyers." });
  }
});

// ==========================================
// GET /api/orders/all-list — All orders (for Order Status page)
// No department filter, returns all orders with pagination + search
// ==========================================
router.get("/all-list", async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "" } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (req.allowedRawBuyers) {
      filter.buyer = { $in: req.allowedRawBuyers };
    }

    if (search) {
      filter.$or = [
        { orderNo: { $regex: search, $options: "i" } },
        { buyer: { $regex: search, $options: "i" } },
      ];
    }

    const projection = { orderNo: 1, buyer: 1, bookingDate: 1, status: 1 };

    const [orders, total] = await Promise.all([
      Order.find(filter, projection)
        .sort({ orderNo: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.status(200).json({
      orders,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error("Error fetching all-list:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// GET /api/orders — Paginated order list for a department
// Query params: dept, status, buyer, page, limit, search
// ==========================================
router.get("/", async (req, res) => {
  try {
    const {
      dept = "knitting",
      status = "Pending", // Pending | Confirm | Tentative | Completed
      buyer = "",
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = {};

    // Only show orders from uploaded file for this department
    const deptValid = await DeptValidOrders.findOne({ dept }).lean();
    if (
      deptValid &&
      deptValid.validOrderNos &&
      deptValid.validOrderNos.length > 0
    ) {
      filter.orderNo = { $in: deptValid.validOrderNos };
    }

    // Department plan status filter
    const statusField = `${dept}PlanStatus`;
    if (status === "Completed") {
      filter[statusField] = "Completed";
    } else if (status === "Pending") {
      filter.$or = [
        { [statusField]: "Pending" },
        { [statusField]: { $exists: false } },
        { [statusField]: null },
        { [statusField]: "" },
      ];
    } else {
      filter[statusField] = status;
    }

    // Buyer filter
    if (buyer) {
      filter.buyer = { $regex: buyer, $options: "i" };
    }

    if (req.allowedRawBuyers) {
      if (filter.buyer) {
        filter.$and = filter.$and || [];
        filter.$and.push({ buyer: filter.buyer });
        filter.$and.push({ buyer: { $in: req.allowedRawBuyers } });
        delete filter.buyer;
      } else {
        filter.buyer = { $in: req.allowedRawBuyers };
      }
    }

    // Search by orderNo
    if (search) {
      const searchCondition =
        req.query.exact === "true"
          ? { orderNo: { $regex: `^${search}$`, $options: "i" } }
          : { orderNo: { $regex: search, $options: "i" } };

      if (filter.orderNo) {
        // validOrderNos filter already set — combine with $and
        filter.$and = filter.$and || [];
        filter.$and.push({ orderNo: filter.orderNo });
        filter.$and.push(searchCondition);
        delete filter.orderNo;
      } else {
        filter.orderNo = searchCondition.orderNo;
      }
    }

    // Only return orders that have items for this department
    const itemsField = `${dept}Items`;
    filter[itemsField] = { $exists: true, $ne: [] };

    // Projection: only return what the list view needs (not full item arrays)
    const projection = {
      orderNo: 1,
      buyer: 1,
      bookingDate: 1,
      status: 1,
      requiredQtyKgs: 1,
      [`${dept}PlanStatus`]: 1,
    };

    if (req.query.populateItems === "true") {
      projection[`${dept}Items`] = 1;
      projection.knitStart = 1;
      projection.knitEnd = 1;
      projection.dyeStart = 1;
      projection.dyeEnd = 1;
      projection.deliStart = 1;
      projection.deliEnd = 1;
      projection.ydStart = 1;
      projection.ydEnd = 1;
    }

    const [orders, total] = await Promise.all([
      Order.find(filter, projection)
        .sort({ orderNo: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    // Get unique buyers for buyer filter tabs (from all orders matching this department)
    const buyerTabFilter = { [itemsField]: { $exists: true, $ne: [] } };
    if (
      deptValid &&
      deptValid.validOrderNos &&
      deptValid.validOrderNos.length > 0
    ) {
      buyerTabFilter.orderNo = { $in: deptValid.validOrderNos };
    }
    if (req.allowedRawBuyers) {
      buyerTabFilter.buyer = { $in: req.allowedRawBuyers };
    }
    const buyersList = await Order.distinct("buyer", buyerTabFilter);

    res.status(200).json({
      orders,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
      buyers: [
        ...new Set(
          buyersList
            .filter((b) => b && b.trim() !== "" && b !== "N/A")
            .map((b) => b.trim().toUpperCase()),
        ),
      ].sort(),
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Helpers for generating consistent item IDs matching active items
function normKeyOrder(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getValOrder(row, keys) {
  if (!row) return "";
  const rowKeys = Object.keys(row);
  for (const k of keys) {
    const norm = normKeyOrder(k);
    const found = rowKeys.find((rk) => normKeyOrder(rk) === norm);
    if (
      found !== undefined &&
      row[found] !== undefined &&
      row[found] !== null
    ) {
      return row[found];
    }
  }
  return "";
}

function generateBackendItemIdOrder(row, dept, orderNo) {
  if (!row) return "";
  if (row.itemId) return String(row.itemId).toLowerCase().replace(/\s+/g, "");

  const bNo = String(
    getValOrder(row, [
      "BookingNo",
      "OrderNo",
      "EWO",
      "Booking",
      "Order No",
      "Booking No",
    ]) ||
      orderNo ||
      "N/A",
  ).trim();
  const color = String(
    getValOrder(row, ["Color", "Colour", "Fab Color"]) || "N/A",
  ).trim();

  if (dept === "knitting" || dept === "delivery") {
    const fabConst = String(
      getValOrder(row, [
        "FabricConstruction",
        "Fabric Construction",
        "Construction",
        "Fab Const",
        "Fabric",
      ]) || "N/A",
    ).trim();
    const gsm = String(
      getValOrder(row, ["GSM", "G.S.M", "Body GSM"]) || "N/A",
    ).trim();
    return `${bNo}_${color}_${fabConst}_${gsm}`
      .toLowerCase()
      .replace(/\s+/g, "");
  } else if (dept === "yd") {
    const type = String(
      getValOrder(row, ["Booking Type", "Type", "YD Type", "BookingType"]) ||
        "N/A",
    ).trim();
    const ydb = String(getValOrder(row, ["YDB", "YD B"]) || "N/A").trim();
    return `${bNo}_${type}_${ydb}`.toLowerCase().replace(/\s+/g, "");
  } else {
    // dyeing, finishing
    let procName = String(
      getValOrder(row, ["Process Name", "ProcessName", "Process"]) || "",
    ).trim();
    if (procName.toLowerCase() === "n/a" || procName === "-") procName = "";
    return `${bNo}_${color}_${procName}`.toLowerCase().replace(/\s+/g, "");
  }
}

// ==========================================
// GET /api/orders/:orderNo — Single order full detail
// Query params: dept (to know which items to include)
// ==========================================
router.get("/:orderNo", async (req, res) => {
  try {
    const { orderNo } = req.params;
    const { dept = "knitting" } = req.query;

    // Get order data
    const filter = { orderNo };
    if (req.allowedRawBuyers) filter.buyer = { $in: req.allowedRawBuyers };
    const order = await Order.findOne(filter).lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Get saved plan data from OrderDate
    let planData = await OrderDate.findOne({ orderNo }).lean();

    // Return complete planData without discarding items
    // (client detailed-view handles matching with active items)

    res.status(200).json({
      order,
      planData: planData || null,
    });
  } catch (error) {
    console.error("Error fetching order detail:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// GET /api/orders/buyers/:dept — Get all buyers for a department
// ==========================================
router.get("/buyers/:dept", async (req, res) => {
  try {
    const { dept } = req.params;
    const itemsField = `${dept}Items`;

    const filter = { [itemsField]: { $exists: true, $ne: [] } };

    // Only show buyers from orders in the uploaded file
    const deptValid = await DeptValidOrders.findOne({ dept }).lean();
    if (
      deptValid &&
      deptValid.validOrderNos &&
      deptValid.validOrderNos.length > 0
    ) {
      filter.orderNo = { $in: deptValid.validOrderNos };
    }

    if (req.allowedRawBuyers) filter.buyer = { $in: req.allowedRawBuyers };
    const buyers = await Order.distinct("buyer", filter);

    res
      .status(200)
      .json(buyers.filter((b) => b && b !== "N/A" && b !== "").sort());
  } catch (error) {
    console.error("Error fetching buyers:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// GET /api/orders/report/:dept — Report data (Confirm + Tentative orders with full items)
// Query params: page, limit
// ==========================================
router.get("/report/:dept", async (req, res) => {
  try {
    const { dept } = req.params;
    const { includePending } = req.query;

    const statusField = `${dept}PlanStatus`;
    const itemsField = `${dept}Items`;

    const allowedStatuses =
      includePending === "true" || dept === "yd" || dept === "delivery"
        ? ["Confirm", "Tentative", "Pending"]
        : ["Confirm", "Tentative"];

    const filter = {
      $or: [
        { [statusField]: { $in: allowedStatuses } },
        ...(includePending === "true"
          ? [
              { [statusField]: { $exists: false } },
              { [statusField]: null },
              { [statusField]: "" },
            ]
          : []),
      ],
      [itemsField]: { $exists: true, $ne: [] },
    };

    // Only show orders from uploaded file
    const deptValid = await DeptValidOrders.findOne({ dept }).lean();
    if (
      deptValid &&
      deptValid.validOrderNos &&
      deptValid.validOrderNos.length > 0
    ) {
      filter.orderNo = { $in: deptValid.validOrderNos };
    }

    if (req.allowedRawBuyers) filter.buyer = { $in: req.allowedRawBuyers };

    // No limit — fetch ALL confirmed/tentative orders for report
    const orders = await Order.find(filter).sort({ orderNo: -1 }).lean();
    const total = orders.length;

    // Also get plan data for these orders
    const orderNos = orders.map((o) => o.orderNo);
    const planDocs = await OrderDate.find({
      orderNo: { $in: orderNos },
    }).lean();

    const planMap = {};
    planDocs.forEach((p) => {
      planMap[p.orderNo] = p;
    });

    res.status(200).json({
      orders,
      planMap,
      total,
    });
  } catch (error) {
    console.error("Error fetching report:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// GET /api/orders/tracking/:dept — Actual tracking data (confirmed plans)
// Returns orders with confirmed plans for tracking page
// ==========================================
router.get("/tracking/:dept", async (req, res) => {
  try {
    const { dept } = req.params;
    const {
      page = 1,
      limit = 10,
      buyer = "",
      search = "",
      all = "",
      status = "",
      startMin = "",
      startMax = "",
      endMin = "",
      endMax = "",
    } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, parseInt(limit) || 10);
    const noLimit = all === "true" || parseInt(limit) === 0;
    const skip = noLimit ? 0 : (pageNum - 1) * limitNum;

    const dbDept = dept === "deliveryfloor" ? "delivery" : dept;
    const statusField = `${dbDept}PlanStatus`;
    const actualField =
      (dept === "deliveryfloor" ? "delivery" : dept) + "Actual";

    // 1. Get Confirmed orders from Order collection (LIGHTWEIGHT)
    const orderFilter = { [statusField]: "Confirm" };

    // Only show orders from uploaded file
    const deptValid = await DeptValidOrders.findOne({ dept: dbDept }).lean();
    if (
      deptValid &&
      deptValid.validOrderNos &&
      deptValid.validOrderNos.length > 0
    ) {
      orderFilter.orderNo = { $in: deptValid.validOrderNos };
    }

    if (buyer) orderFilter.buyer = { $regex: buyer, $options: "i" };
    if (search) {
      const escaped = String(search)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = req.query.exact === "true" ? `^${escaped}$` : escaped;
      const searchRegex = new RegExp(pattern, "i");

      // If we already have $in filter, we need to combine with search
      if (orderFilter.orderNo && orderFilter.orderNo.$in) {
        orderFilter.orderNo.$in = orderFilter.orderNo.$in.filter((no) =>
          searchRegex.test(no),
        );
      } else {
        orderFilter.orderNo = { $regex: pattern, $options: "i" };
      }
    }

    if (req.allowedRawBuyers) {
      if (orderFilter.buyer) {
        orderFilter.$and = orderFilter.$and || [];
        orderFilter.$and.push({ buyer: orderFilter.buyer });
        orderFilter.$and.push({ buyer: { $in: req.allowedRawBuyers } });
        delete orderFilter.buyer;
      } else {
        orderFilter.buyer = { $in: req.allowedRawBuyers };
      }
    }

    const confirmedOrders = await Order.find(orderFilter, {
      orderNo: 1,
      buyer: 1,
      bookingDate: 1,
      knitStart: 1,
      knitEnd: 1,
      dyeStart: 1,
      dyeEnd: 1,
      deliStart: 1,
      deliEnd: 1,
    })
      .sort({ orderNo: -1 })
      .lean();

    const orderNos = confirmedOrders.map((o) => o.orderNo);

    // 2. Find orphaned tracking data — OrderDate docs with actual data (LIGHTWEIGHT)
    //    for orders NOT in the confirmed/completed list
    const orphanMatch = [{ orderNo: { $nin: orderNos } }];
    if (search) {
      const escaped = String(search)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = req.query.exact === "true" ? `^${escaped}$` : escaped;
      orphanMatch.push({ orderNo: { $regex: pattern, $options: "i" } });
    }

    const orphanFilter = {
      $and: orphanMatch,
      $or: [
        { [`${dbDept}Status`]: "Confirm" },
        { [`${actualField}.actualStart`]: { $exists: true, $ne: "" } },
        { [`${actualField}.actualEnd`]: { $exists: true, $ne: "" } },
        { [`${actualField}.failReason`]: { $exists: true, $ne: "" } },
        { [`${actualField}.relatedDept`]: { $exists: true, $ne: "" } },
      ],
    };

    const orphanedDocs = await OrderDate.find(
      orphanFilter,
      { orderNo: 1, [actualField]: 1 }, // ONLY fetch actual tracking info
    ).lean();

    // Get Order info for orphaned orders (buyer/bookingDate)
    const orphanedOrderNos = orphanedDocs.map((d) => d.orderNo);
    let orphanedOrderInfos = [];
    if (orphanedOrderNos.length > 0) {
      const orphanOrderFilter = { orderNo: { $in: orphanedOrderNos } };
      if (buyer) orphanOrderFilter.buyer = { $regex: buyer, $options: "i" };

      if (req.allowedRawBuyers) {
        if (orphanOrderFilter.buyer) {
          orphanOrderFilter.$and = orphanOrderFilter.$and || [];
          orphanOrderFilter.$and.push({ buyer: orphanOrderFilter.buyer });
        }
        orphanOrderFilter.buyer = { $in: req.allowedRawBuyers };
      }

      orphanedOrderInfos = await Order.find(orphanOrderFilter, {
        orderNo: 1,
        buyer: 1,
        bookingDate: 1,
      }).lean();
    }

    // If buyer filter active, only keep orphaned docs with matching Order buyer
    let filteredOrphanedDocs = orphanedDocs;
    if (buyer || req.allowedRawBuyers) {
      const orphanedWithBuyer = new Set(
        orphanedOrderInfos.map((o) => o.orderNo),
      );
      filteredOrphanedDocs = orphanedDocs.filter((d) =>
        orphanedWithBuyer.has(d.orderNo),
      );
    }

    // 3. Merge all tracking orderNos
    const allTrackingOrderNos = [
      ...orderNos,
      ...filteredOrphanedDocs.map((d) => d.orderNo),
    ];

    if (allTrackingOrderNos.length === 0) {
      return res.status(200).json({
        planDocs: [],
        orderMap: {},
        total: 0,
        page: 1,
        limit: limitNum,
        totalPages: 0,
        buyers: [],
      });
    }

    // 4. Fetch lightweight plan tracking info for confirmed/completed orders (NO ARRAYS)
    const planTrackingInfo =
      orderNos.length > 0
        ? await OrderDate.find(
            { orderNo: { $in: orderNos } },
            { orderNo: 1, [actualField]: 1 }, // ONLY fetch actual tracking info
          ).lean()
        : [];

    // Pad missing OrderDate entries for confirmed/completed orders
    const planDocSet = new Set(planTrackingInfo.map((p) => p.orderNo));
    orderNos.forEach((orderNo) => {
      if (!planDocSet.has(orderNo)) {
        planTrackingInfo.push({ orderNo });
        planDocSet.add(orderNo);
      }
    });

    // Add orphaned docs to planTrackingInfo (avoid duplicates)
    filteredOrphanedDocs.forEach((doc) => {
      if (!planDocSet.has(doc.orderNo)) {
        planTrackingInfo.push(doc);
        planDocSet.add(doc.orderNo);
      }
    });

    // 5. Filter by Pending/Complete status (based on actualEnd)
    let filteredPlanInfo = planTrackingInfo;
    if (status === "Pending" || status === "Complete") {
      filteredPlanInfo = planTrackingInfo.filter((plan) => {
        const actual = plan[actualField];
        const hasActualEnd =
          actual && actual.actualEnd && actual.actualEnd.trim() !== "";
        if (status === "Pending") return !hasActualEnd;
        if (status === "Complete") return hasActualEnd;
        return true;
      });
    }

    const hasDateFilter = startMin || startMax || endMin || endMax;
    if (hasDateFilter && filteredPlanInfo.length > 0) {
      const filterOrderNos = filteredPlanInfo.map((p) => p.orderNo);

      const filterDocs = await OrderDate.find(
        { orderNo: { $in: filterOrderNos } },
        { orderNo: 1, [dbDept]: 1 },
      ).lean();

      const filterOrders = await Order.find(
        { orderNo: { $in: filterOrderNos } },
        {
          orderNo: 1,
          [`${dbDept}Items`]: 1,
          knitStart: 1,
          knitEnd: 1,
          dyeStart: 1,
          dyeEnd: 1,
          deliStart: 1,
          deliEnd: 1,
        },
      ).lean();

      const filterOrdersMap = {};
      filterOrders.forEach((o) => {
        filterOrdersMap[o.orderNo] = o;
      });

      filteredPlanInfo = filteredPlanInfo.filter((plan) => {
        const doc = filterDocs.find((d) => d.orderNo === plan.orderNo);
        const orderInfo = filterOrdersMap[plan.orderNo] || {};
        const rawItems =
          doc && doc[dbDept] && doc[dbDept].length > 0
            ? doc[dbDept]
            : orderInfo[`${dbDept}Items`] || [];

        let startDates = [],
          endDates = [];
        if (dept === "deliveryfloor") {
          const floorItems = rawItems.filter((item) => {
            const type =
              item.floorPlanType || item["Delivery Plan Type (Floor)"] || "";
            return type === "Confirm" || type === "Tentative";
          });
          startDates = floorItems
            .map(
              (item) =>
                item.floorStartDate ||
                item["Delivery Plan Start (Floor)"] ||
                "",
            )
            .filter((d) => d && d !== "" && d !== "-");
          endDates = floorItems
            .map(
              (item) =>
                item.floorEndDate || item["Delivery Plan End (Floor)"] || "",
            )
            .filter((d) => d && d !== "" && d !== "-");
        } else {
          startDates = rawItems
            .map(
              (item) =>
                item.startDate ||
                item["Plan Start Date"] ||
                item["Plan Start"] ||
                item["Start Date"] ||
                item["Knit Start Date"] ||
                item["Dyeing Start Date"] ||
                (dbDept === "delivery" ? item["Delivery Plan Start"] : "") ||
                "",
            )
            .filter((d) => d && d !== "" && d !== "-");
          endDates = rawItems
            .map(
              (item) =>
                item.endDate ||
                item["Plan End Date"] ||
                item["Plan End"] ||
                item["End Date"] ||
                item["Knit End Date"] ||
                item["Dyeing End Date"] ||
                (dbDept === "delivery" ? item["Delivery Plan End"] : "") ||
                "",
            )
            .filter((d) => d && d !== "" && d !== "-");
        }

        if (startDates.length === 0 && endDates.length === 0) {
          if (dept === "knitting") {
            if (orderInfo.knitStart) startDates = [orderInfo.knitStart];
            if (orderInfo.knitEnd) endDates = [orderInfo.knitEnd];
          } else if (dept === "dyeing") {
            if (orderInfo.dyeStart) startDates = [orderInfo.dyeStart];
            if (orderInfo.dyeEnd) endDates = [orderInfo.dyeEnd];
          } else if (dept === "delivery") {
            if (orderInfo.deliStart) startDates = [orderInfo.deliStart];
            if (orderInfo.deliEnd) endDates = [orderInfo.deliEnd];
          }
        }

        startDates.sort();
        endDates.sort();

        const pStart = startDates.length > 0 ? startDates[0] : "";
        const pEnd = endDates.length > 0 ? endDates[endDates.length - 1] : "";

        if (startMin && pStart) {
          if (
            new Date(pStart).setHours(0, 0, 0, 0) <
            new Date(startMin).setHours(0, 0, 0, 0)
          )
            return false;
        } else if (startMin && !pStart) return false;

        if (startMax && pStart) {
          if (
            new Date(pStart).setHours(0, 0, 0, 0) >
            new Date(startMax).setHours(0, 0, 0, 0)
          )
            return false;
        } else if (startMax && !pStart) return false;

        if (endMin && pEnd) {
          if (
            new Date(pEnd).setHours(0, 0, 0, 0) <
            new Date(endMin).setHours(0, 0, 0, 0)
          )
            return false;
        } else if (endMin && !pEnd) return false;

        if (endMax && pEnd) {
          if (
            new Date(pEnd).setHours(0, 0, 0, 0) >
            new Date(endMax).setHours(0, 0, 0, 0)
          )
            return false;
        } else if (endMax && !pEnd) return false;

        return true;
      });
    }

    // 6. Build orderMap (confirmed/completed + orphaned)
    const orderMap = {};
    confirmedOrders.forEach((o) => {
      orderMap[o.orderNo] = o;
    });
    orphanedOrderInfos.forEach((o) => {
      if (!orderMap[o.orderNo]) orderMap[o.orderNo] = o;
    });

    // 7. Get all buyers for filter tabs (include all sources)
    const buyerFilterQuery = {
      [statusField]: "Confirm",
    };
    const allBuyersList = await Order.distinct("buyer", buyerFilterQuery);
    // Also include buyers from orphaned orders
    orphanedOrderInfos.forEach((o) => {
      if (o.buyer) allBuyersList.push(o.buyer);
    });
    const buyers = [
      ...new Set(
        allBuyersList
          .filter((b) => b && b.trim() !== "" && b !== "N/A")
          .map((b) => b.trim().toUpperCase()),
      ),
    ].sort();

    // 8. Paginate the filtered lightweight results
    const totalFiltered = filteredPlanInfo.length;
    const paginatedInfo = noLimit
      ? filteredPlanInfo
      : filteredPlanInfo.slice(skip, skip + limitNum);

    // 9. Fetch HEAVY plan data (arrays) ONLY for the paginated orderNos
    const paginatedOrderNos = paginatedInfo.map((p) => p.orderNo);
    let paginatedDocs = [];
    if (paginatedOrderNos.length > 0) {
      const projection = {
        orderNo: 1,
        [dbDept]: 1,
        [`${dbDept}Status`]: 1,
        [`${dbDept}CompletedDate`]: 1,
        [actualField]: 1,
      };
      if (
        dept === "dyeing" ||
        dept === "delivery" ||
        dept === "deliveryfloor"
      ) {
        projection.dyeing = 1;
      }
      paginatedDocs = await OrderDate.find(
        { orderNo: { $in: paginatedOrderNos } },
        projection,
      ).lean();
    }

    // Pad missing heavy docs if they don't exist in DB yet (for confirmed orders)
    const heavyDocSet = new Set(paginatedDocs.map((p) => p.orderNo));
    paginatedOrderNos.forEach((orderNo) => {
      if (!heavyDocSet.has(orderNo)) {
        paginatedDocs.push({ orderNo, [dbDept]: [] });
      }
    });

    // Fetch uploaded items to populate dates for orders that only exist in Order collection
    // (i.e., OrderDate has no dept array for them)
    const orderProjection = { orderNo: 1, [`${dbDept}Items`]: 1 };
    if (dept === "delivery" || dept === "deliveryfloor") {
      orderProjection.dyeingItems = 1;
    }
    const paginatedOrders = await Order.find(
      { orderNo: { $in: paginatedOrderNos } },
      orderProjection,
    ).lean();
    const paginatedOrdersMap = {};
    const paginatedDyeingOrdersMap = {};
    paginatedOrders.forEach((o) => {
      paginatedOrdersMap[o.orderNo] = o[`${dbDept}Items`] || [];
      if (dept === "delivery" || dept === "deliveryfloor") {
        paginatedDyeingOrdersMap[o.orderNo] = o.dyeingItems || [];
      }
    });

    paginatedDocs.forEach((doc) => {
      doc.uploadedItems = paginatedOrdersMap[doc.orderNo] || [];
      if (dept === "delivery" || dept === "deliveryfloor") {
        if (!doc.dyeing || doc.dyeing.length === 0) {
          const rawDyeing = paginatedDyeingOrdersMap[doc.orderNo] || [];
          if (rawDyeing.length > 0) {
            doc.dyeing = rawDyeing.map((raw) => ({ itemData: raw }));
          }
        }
      }

      if (!doc[dbDept] || doc[dbDept].length === 0) {
        const rawItems = paginatedOrdersMap[doc.orderNo] || [];
        doc[dbDept] = rawItems.map((raw) => {
          let startDate =
            raw["Plan Start Date"] ||
            raw["Plan Start"] ||
            raw["Start Date"] ||
            raw["Knit Start Date"] ||
            raw["Dyeing Start Date"] ||
            "";
          let endDate =
            raw["Plan End Date"] ||
            raw["Plan End"] ||
            raw["End Date"] ||
            raw["Knit End Date"] ||
            raw["Dyeing End Date"] ||
            "";

          if (dbDept === "delivery") {
            startDate = raw["Delivery Plan Start"] || startDate;
            endDate = raw["Delivery Plan End"] || endDate;
            return {
              itemData: raw,
              floorStartDate: raw["Delivery Plan Start (Floor)"] || "",
              floorEndDate: raw["Delivery Plan End (Floor)"] || "",
              floorPlanType: raw["Delivery Plan Type (Floor)"] || "",
              startDate,
              endDate,
            };
          }
          return {
            itemData: raw,
            startDate,
            endDate,
          };
        });
      }
    });

    // Populate unit and processName for dyeing, delivery, and deliveryfloor
    if (dept === "dyeing" || dept === "delivery" || dept === "deliveryfloor") {
      const invalidStrings = new Set([
        "",
        "-",
        "n/a",
        "select",
        "null",
        "undefined",
      ]);
      paginatedDocs.forEach((doc) => {
        const dyeingItems =
          doc.dyeing && doc.dyeing.length > 0
            ? doc.dyeing
            : (paginatedDyeingOrdersMap[doc.orderNo] || []).map((r) => ({
                itemData: r,
              }));
        const units = [];
        const processes = [];

        dyeingItems.forEach((it) => {
          const d = it.itemData || it;
          const u =
            d.Unit !== undefined && d.Unit !== null
              ? String(d.Unit).trim()
              : it.Unit !== undefined && it.Unit !== null
                ? String(it.Unit).trim()
                : "";
          if (u) {
            u.split("+")
              .map((s) => s.trim())
              .filter(Boolean)
              .forEach((part) => {
                if (
                  !invalidStrings.has(part.toLowerCase()) &&
                  !units.includes(part)
                ) {
                  units.push(part);
                }
              });
          }

          const p =
            d.ProcessName ||
            d["Process Name"] ||
            d.Process ||
            it.ProcessName ||
            it["Process Name"] ||
            "";
          if (p) {
            String(p)
              .trim()
              .split("+")
              .map((s) => s.trim())
              .filter(Boolean)
              .forEach((part) => {
                if (
                  !invalidStrings.has(part.toLowerCase()) &&
                  !processes.includes(part)
                ) {
                  processes.push(part);
                }
              });
          }
        });

        doc.unit = units.join("+");
        doc.processName = processes.join("+");
      });
    }

    // Ensure the paginatedDocs are in the same sorted order as paginatedInfo
    const finalPaginatedDocs = [];
    paginatedOrderNos.forEach((orderNo) => {
      const doc = paginatedDocs.find((d) => d.orderNo === orderNo);
      if (doc) finalPaginatedDocs.push(doc);
    });

    // Only keep orderMap entries for paginated docs (save memory)
    const paginatedOrderMap = {};
    finalPaginatedDocs.forEach((p) => {
      if (orderMap[p.orderNo])
        paginatedOrderMap[p.orderNo] = orderMap[p.orderNo];
    });

    res.status(200).json({
      planDocs: finalPaginatedDocs,
      orderMap: paginatedOrderMap,
      total: totalFiltered,
      page: noLimit ? 1 : pageNum,
      limit: noLimit ? totalFiltered : limitNum,
      totalPages: noLimit ? 1 : Math.ceil(totalFiltered / limitNum),
      buyers,
    });
  } catch (error) {
    console.error("Error fetching tracking:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// ==========================================
// Helper: Normalize raw Excel item data to consistent column keys
// Ensures Pending items (raw Excel) match Confirm/Tentative items (saved plan)
// ==========================================
function normalizeItemRow(rawItem, dept) {
  const rawKeys = Object.keys(rawItem);
  const getField = (keys) => {
    // Direct key match first
    for (const k of keys) {
      if (rawItem[k] !== undefined && rawItem[k] !== null && rawItem[k] !== "")
        return rawItem[k];
    }
    // Case-insensitive fuzzy match
    for (const k of keys) {
      const normK = k.toLowerCase().replace(/[^a-z0-9]/g, "");
      const found = rawKeys.find(
        (rk) => rk.toLowerCase().replace(/[^a-z0-9]/g, "") === normK,
      );
      if (found && rawItem[found] !== undefined && rawItem[found] !== null)
        return rawItem[found];
    }
    return "";
  };

  if (dept === "delivery") {
    return {
      OrderNo: getField([
        "OrderNo",
        "BookingNo",
        "EWO",
        "Booking",
        "Order No",
        "Booking No",
      ]),
      Buyer: getField(["Buyer", "BuyerName", "Customer"]),
      Color: getField(["Color", "Colour", "Fab Color"]),
      FabricConstruction: getField([
        "FabricConstruction",
        "Construction",
        "Fab Const",
        "Fabric",
      ]),
      GSM: getField(["GSM", "G.S.M"]),
      RequiredQtyKgs: getField([
        "RequiredQtyKgs",
        "Req Qty",
        "Qty",
        "Order Qty",
      ]),
      Allowance: getField([
        "Allowance %",
        "Allowance",
        "Wastage %",
        "Wastage",
        "Allow %",
        "Allow",
      ]),
      YarnReq: getField(["Yarn req.", "YarnReq", "Yarn Req", "Yarn Req."]),
      AllocatedQty: getField([
        "Allocated Qty",
        "Allocated Qty ",
        "AllocatedQty",
        "Alloc Qty",
      ]),
      YarnBala: getField([
        "Yarn bala.",
        "YarnBala",
        "Yarn Bala",
        "Yarn Balance",
      ]),
      GreyReq: getField(["Grey Req.", "GreyReq", "Grey Req"]),
      KnitProd: getField([
        "Knit Prod.",
        "KnitProd",
        "Knit Prod",
        "Knit Production",
      ]),
      KnitBala: getField([
        "Knit. Bala.",
        "KnitBala",
        "Knit Bala.",
        "Knit Bala",
        "Knit. Bal.",
      ]),
      NetReceivedQtyKgs: getField([
        "NetReceivedQtyKgs",
        "NetReceivedQty",
        "ReceivedQty",
      ]),
      NetDeliveryQtyKgs: getField([
        "NetDeliveryQtyKgs",
        "NetDeliveryQty",
        "DeliveryQty",
      ]),
      DeliBal: getField([
        "Deli. Bal.",
        "Deli Bal.",
        "DeliBal",
        "Delivery Balance",
        "Deli. Bala.",
      ]),
      RFD: getField(["RFD"]),
      Slowmoving: getField(["Slowmoving"]),
      FFStock: getField(["FF Stock", "FFStock", "FF_Stock"]),
      BPQty: getField(["BP Qty", "BPQty", "BP_Qty"]),
      DyeingProd: getField([
        "Dyeing Prod.",
        "DyeingProd",
        "Dyeing Prod",
        "Dyeing ok",
        "Dyeing Production",
      ]),
      DyeingBala: getField([
        "Dyeing Bala.",
        "DyeingBala",
        "Dyeing Bala",
        "Dyeing Bal.",
      ]),
    };
  } else if (dept === "knitting") {
    return {
      OrderNo: getField([
        "OrderNo",
        "BookingNo",
        "EWO",
        "Booking",
        "Order No",
        "Booking No",
      ]),
      Buyer: getField(["Buyer", "BuyerName", "Customer"]),
      Color: getField(["Color", "Colour", "Fab Color"]),
      FabricConstruction: getField([
        "FabricConstruction",
        "Construction",
        "Fab Const",
        "Fabric",
      ]),
      GSM: getField(["GSM", "G.S.M"]),
      RequiredQtyKgs: getField([
        "RequiredQtyKgs",
        "Req Qty",
        "Qty",
        "Order Qty",
      ]),
      Allowance: getField([
        "Allowance %",
        "Allowance",
        "Wastage %",
        "Wastage",
        "Allow %",
        "Allow",
      ]),
      YarnReq: getField(["Yarn req.", "YarnReq", "Yarn Req", "Yarn Req."]),
      AllocatedQty: getField([
        "Allocated Qty",
        "Allocated Qty ",
        "AllocatedQty",
        "Alloc Qty",
      ]),
      YarnBala: getField([
        "Yarn bala.",
        "YarnBala",
        "Yarn Bala",
        "Yarn Balance",
      ]),
      GreyReq: getField(["Grey Req.", "GreyReq", "Grey Req"]),
      KnitProd: getField([
        "Knit Prod.",
        "KnitProd",
        "Knit Prod",
        "Knit Production",
      ]),
      KnitBala: getField([
        "Knit. Bala.",
        "KnitBala",
        "Knit Bala.",
        "Knit Bala",
        "Knit. Bal.",
      ]),
      NetReceivedQtyKgs: getField([
        "NetReceivedQtyKgs",
        "NetReceivedQty",
        "ReceivedQty",
      ]),
      NetDeliveryQtyKgs: getField([
        "NetDeliveryQtyKgs",
        "NetDeliveryQty",
        "DeliveryQty",
      ]),
      DeliBal: getField([
        "Deli. Bal.",
        "Deli Bal.",
        "DeliBal",
        "Delivery Balance",
        "Deli. Bala.",
      ]),
      RFD: getField(["RFD"]),
      Slowmoving: getField(["Slowmoving"]),
      FFStock: getField(["FF Stock", "FFStock", "FF_Stock"]),
    };
  } else if (dept === "dyeing" || dept === "finishing") {
    return {
      OrderNo: getField([
        "OrderNo",
        "BookingNo",
        "EWO",
        "Booking",
        "Order No",
        "Booking No",
      ]),
      Color: getField(["Color", "Colour", "Fab Color"]),
      RequiredQtyKgs: getField([
        "RequiredQtyKgs",
        "Req Qty",
        "Qty",
        "Order Qty",
      ]),
      Buyer: getField(["Buyer", "BuyerName", "Customer"]),
      Unit: getField(["Unit"]),
      ProcessName: getField(["Process Name", "ProcessName", "Process"]),
      Allowance: getField([
        "Allowance %",
        "Allowance",
        "Wastage %",
        "Wastage",
        "Allow %",
        "Allow",
      ]),
      YarnReq: getField(["Yarn req.", "YarnReq", "Yarn Req", "Yarn Req."]),
      AllocatedQty: getField([
        "Allocated Qty",
        "Allocated Qty ",
        "AllocatedQty",
        "Alloc Qty",
      ]),
      YarnBala: getField([
        "Yarn bala.",
        "YarnBala",
        "Yarn Bala",
        "Yarn Balance",
      ]),
      GreyReq: getField(["Grey Req.", "GreyReq", "Grey Req"]),
      KnitProd: getField([
        "Knit Prod.",
        "KnitProd",
        "Knit Prod",
        "Knit Production",
      ]),
      KnitBala: getField([
        "Knit. Bala.",
        "KnitBala",
        "Knit Bala.",
        "Knit Bala",
        "Knit. Bal.",
      ]),
      BPQty: getField(["BP Qty", "BPQty", "BP_Qty"]),
      DyeingProd: getField([
        "Dyeing Prod.",
        "DyeingProd",
        "Dyeing Prod",
        "Dyeing ok",
        "Dyeing Production",
      ]),
      DyeingBala: getField([
        "Dyeing Bala.",
        "DyeingBala",
        "Dyeing Bala",
        "Dyeing Bal.",
      ]),
      NetReceivedQtyKgs: getField([
        "NetReceivedQtyKgs",
        "NetReceivedQty",
        "ReceivedQty",
      ]),
      NetDeliveryQtyKgs: getField([
        "NetDeliveryQtyKgs",
        "NetDeliveryQty",
        "DeliveryQty",
      ]),
      DeliBal: getField([
        "Deli. Bal.",
        "Deli Bal.",
        "DeliBal",
        "Delivery Balance",
        "Deli. Bala.",
      ]),
      RFD: getField(["RFD"]),
      Slowmoving: getField(["Slowmoving"]),
      FFStock: getField(["FF Stock", "FFStock", "FF_Stock"]),
    };
  } else if (dept === "yd") {
    return {
      OrderNo: getField([
        "OrderNo",
        "BookingNo",
        "EWO",
        "Booking",
        "Order No",
        "Booking No",
      ]),
      "Booking Type": getField(["Booking Type", "Type", "YD Type"]),
      YDB: getField(["YDB", "YD B"]),
      "YD Booking Date": getField(["YD Booking Date", "Date", "Booking Date"]),
      "YD T&A Start": getField([
        "YD T&A Start",
        "T&A Start",
        "YD T&A Start Date",
        "YD TNA Start",
        "TNA Start",
        "Start Date",
      ]),
      "YD T&A End": getField([
        "YD T&A End",
        "T&A End",
        "YD T&A End Date",
        "YD TNA End",
        "TNA End",
        "End Date",
      ]),
      Buyer: getField(["Buyer", "BuyerName", "Customer"]),
      "YD REQ.": getField(["YD REQ.", "YD REQ", "YD Req", "Requirement"]),
      DYED: getField(["DYED", "Dyed", "Dye"]),
      "YD BALANCE": getField(["YD BALANCE", "YD Balance"]),
      "YD Delivered": getField(["YD Delivered", "Delivered", "Delivery"]),
      "YD DELIVERY BALANCE": getField([
        "YD DELIVERY BALANCE",
        "YD Balance_1",
        "YD Balance 2",
      ]),
      "Barrier Qty.": getField(["Barrier Qty.", "Barrier Qty", "Barrier"]),
      "Workable Qty.": getField(["Workable Qty.", "Workable Qty", "Workable"]),
    };
  }
  return rawItem; // fallback
}

// ==========================================
// GET /api/orders/report-download/:dept — Generate and download Excel report directly
// Uses projection to minimize data loaded from MongoDB
// ==========================================
// ==========================================
// GET /api/orders/report-download/:dept — Generate and download Excel report directly
// Uses projection and chunking to minimize memory load
// ==========================================
router.get("/report-download/:dept", async (req, res) => {
  try {
    const XLSX = require("xlsx");
    const { dept } = req.params;

    const statusField = `${dept}PlanStatus`;
    const itemsField = `${dept}Items`;

    // Department-specific status filter:
    // Delivery: Pending + Confirm + Tentative
    // Knitting/Dyeing/YD/Finishing: Confirm + Tentative only
    const statusList =
      dept === "delivery" || dept === "yd"
        ? ["Pending", "Confirm", "Tentative"]
        : ["Confirm", "Tentative"];
    const filter = {
      [statusField]: { $in: statusList },
    };

    // Only include orders from uploaded file
    const deptValid = await DeptValidOrders.findOne({ dept }).lean();
    if (
      deptValid &&
      deptValid.validOrderNos &&
      deptValid.validOrderNos.length > 0
    ) {
      filter.orderNo = { $in: deptValid.validOrderNos };
    }

    if (req.allowedRawBuyers) filter.buyer = { $in: req.allowedRawBuyers };

    // 1. Get minimal order info
    const orders = await Order.find(filter, {
      orderNo: 1,
      buyer: 1,
      "T&A Knitting Start": 1,
      "T&A Knitting End": 1,
    }).lean();
    const orderNos = orders.map((o) => o.orderNo);

    if (orderNos.length === 0) {
      return res.status(404).json({ message: "No data to export" });
    }

    const orderBuyerMap = {};
    const orderInfoMap = {};
    orders.forEach((o) => {
      orderBuyerMap[o.orderNo] = o.buyer;
      orderInfoMap[o.orderNo] = {
        knitStart: o["T&A Knitting Start"] || "",
        knitEnd: o["T&A Knitting End"] || "",
      };
    });

    let planProjection = { orderNo: 1, [dept]: 1 };
    if (dept === "delivery") {
      planProjection.knitting = 1;
      planProjection.dyeing = 1;
    } else if (dept === "yd") {
      planProjection.knitting = 1;
    }

    let allRows = [];
    const planDocOrderNos = new Set();
    const chunkSize = 500; // Process 500 orders at a time to save memory

    // 2. Fetch Plan Data in Chunks
    for (let i = 0; i < orderNos.length; i += chunkSize) {
      const chunkOrderNos = orderNos.slice(i, i + chunkSize);

      const orderItemProjection = { orderNo: 1 };
      if (dept === "knitting") {
        orderItemProjection.knittingItems = 1;
      } else if (dept === "dyeing") {
        orderItemProjection.dyeingItems = 1;
        orderItemProjection.knittingItems = 1;
        orderItemProjection.deliveryItems = 1;
      } else if (dept === "delivery") {
        orderItemProjection.deliveryItems = 1;
        orderItemProjection.knittingItems = 1;
        orderItemProjection.dyeingItems = 1;
      }

      const [planDocsChunk, orderItemsDocs] = await Promise.all([
        OrderDate.find(
          {
            orderNo: { $in: chunkOrderNos },
            [dept]: { $exists: true, $ne: [] },
          },
          planProjection,
        ).lean(),
        ["knitting", "dyeing", "delivery"].includes(dept)
          ? Order.find(
              { orderNo: { $in: chunkOrderNos } },
              orderItemProjection,
            ).lean()
          : Promise.resolve([]),
      ]);

      const orderItemsMap = {};
      const orderKnitMap = {};
      const orderDyeMap = {};
      const orderDeliMap = {};
      orderItemsDocs.forEach((d) => {
        if (d.knittingItems) orderKnitMap[d.orderNo] = d.knittingItems;
        if (d.dyeingItems) orderDyeMap[d.orderNo] = d.dyeingItems;
        if (d.deliveryItems) orderDeliMap[d.orderNo] = d.deliveryItems;
        if (dept === "knitting")
          orderItemsMap[d.orderNo] = d.knittingItems || [];
        else if (dept === "dyeing")
          orderItemsMap[d.orderNo] = d.dyeingItems || [];
        else if (dept === "delivery")
          orderItemsMap[d.orderNo] = d.deliveryItems || [];
      });

      planDocsChunk.forEach((plan) => {
        planDocOrderNos.add(plan.orderNo);
        const items = plan[dept] || [];

        const latestItems = orderItemsMap[plan.orderNo] || [];
        const latestNormItems = latestItems.map((li) =>
          normalizeItemRow(li, dept),
        );
        const knitNormItems = (orderKnitMap[plan.orderNo] || []).map((li) =>
          normalizeItemRow(li, "knitting"),
        );
        const dyeNormItems = (orderDyeMap[plan.orderNo] || []).map((li) =>
          normalizeItemRow(li, "dyeing"),
        );
        const deliNormItems = (orderDeliMap[plan.orderNo] || []).map((li) =>
          normalizeItemRow(li, "delivery"),
        );

        items.forEach((item) => {
          let row = normalizeItemRow(item.itemData || {}, dept);

          const myColor = String(row.Color || "")
            .trim()
            .toLowerCase();
          const myConst = String(row.FabricConstruction || "")
            .trim()
            .toLowerCase();
          const myGSM = String(row.GSM || "")
            .trim()
            .toLowerCase();
          const myProcess = String(row.ProcessName || "")
            .trim()
            .toLowerCase();

          if (dept === "knitting") {
            const latestMatch =
              latestNormItems.find(
                (ln) =>
                  String(ln.Color || "")
                    .trim()
                    .toLowerCase() === myColor &&
                  String(ln.FabricConstruction || "")
                    .trim()
                    .toLowerCase() === myConst &&
                  String(ln.GSM || "")
                    .trim()
                    .toLowerCase() === myGSM,
              ) ||
              latestNormItems.find(
                (ln) =>
                  String(ln.Color || "")
                    .trim()
                    .toLowerCase() === myColor,
              );

            if (latestMatch) {
              if (
                latestMatch.Allowance !== undefined &&
                latestMatch.Allowance !== ""
              )
                row.Allowance = latestMatch.Allowance;
              if (
                latestMatch.YarnReq !== undefined &&
                latestMatch.YarnReq !== ""
              )
                row.YarnReq = latestMatch.YarnReq;
              if (
                latestMatch.AllocatedQty !== undefined &&
                latestMatch.AllocatedQty !== ""
              )
                row.AllocatedQty = latestMatch.AllocatedQty;
              if (
                latestMatch.YarnBala !== undefined &&
                latestMatch.YarnBala !== ""
              )
                row.YarnBala = latestMatch.YarnBala;
              if (
                latestMatch.GreyReq !== undefined &&
                latestMatch.GreyReq !== ""
              )
                row.GreyReq = latestMatch.GreyReq;
              if (
                latestMatch.KnitProd !== undefined &&
                latestMatch.KnitProd !== ""
              )
                row.KnitProd = latestMatch.KnitProd;
              if (
                latestMatch.KnitBala !== undefined &&
                latestMatch.KnitBala !== ""
              )
                row.KnitBala = latestMatch.KnitBala;
              if (
                latestMatch.RequiredQtyKgs !== undefined &&
                latestMatch.RequiredQtyKgs !== ""
              )
                row.RequiredQtyKgs = latestMatch.RequiredQtyKgs;
              if (
                latestMatch.NetReceivedQtyKgs !== undefined &&
                latestMatch.NetReceivedQtyKgs !== ""
              )
                row.NetReceivedQtyKgs = latestMatch.NetReceivedQtyKgs;
              if (
                latestMatch.NetDeliveryQtyKgs !== undefined &&
                latestMatch.NetDeliveryQtyKgs !== ""
              )
                row.NetDeliveryQtyKgs = latestMatch.NetDeliveryQtyKgs;
              if (
                latestMatch.DeliBal !== undefined &&
                latestMatch.DeliBal !== ""
              )
                row.DeliBal = latestMatch.DeliBal;
              if (latestMatch.RFD !== undefined && latestMatch.RFD !== "")
                row.RFD = latestMatch.RFD;
              if (
                latestMatch.Slowmoving !== undefined &&
                latestMatch.Slowmoving !== ""
              )
                row.Slowmoving = latestMatch.Slowmoving;
              if (
                latestMatch.FFStock !== undefined &&
                latestMatch.FFStock !== ""
              )
                row.FFStock = latestMatch.FFStock;
            }
          } else if (dept === "dyeing") {
            const latestMatch =
              latestNormItems.find(
                (ln) =>
                  String(ln.Color || "")
                    .trim()
                    .toLowerCase() === myColor &&
                  myProcess &&
                  String(ln.ProcessName || "")
                    .trim()
                    .toLowerCase() === myProcess,
              ) ||
              latestNormItems.find(
                (ln) =>
                  String(ln.Color || "")
                    .trim()
                    .toLowerCase() === myColor,
              );

            if (latestMatch) {
              if (
                latestMatch.KnitProd !== undefined &&
                latestMatch.KnitProd !== ""
              )
                row.KnitProd = latestMatch.KnitProd;
              if (
                latestMatch.KnitBala !== undefined &&
                latestMatch.KnitBala !== ""
              )
                row.KnitBala = latestMatch.KnitBala;
              if (latestMatch.BPQty !== undefined && latestMatch.BPQty !== "")
                row.BPQty = latestMatch.BPQty;
              if (
                latestMatch.DyeingProd !== undefined &&
                latestMatch.DyeingProd !== ""
              )
                row.DyeingProd = latestMatch.DyeingProd;
              if (
                latestMatch.DyeingBala !== undefined &&
                latestMatch.DyeingBala !== ""
              )
                row.DyeingBala = latestMatch.DyeingBala;
              if (
                latestMatch.GreyReq !== undefined &&
                latestMatch.GreyReq !== ""
              )
                row.GreyReq = latestMatch.GreyReq;
              if (
                latestMatch.NetReceivedQtyKgs !== undefined &&
                latestMatch.NetReceivedQtyKgs !== ""
              )
                row.NetReceivedQtyKgs = latestMatch.NetReceivedQtyKgs;
              if (
                latestMatch.NetDeliveryQtyKgs !== undefined &&
                latestMatch.NetDeliveryQtyKgs !== ""
              )
                row.NetDeliveryQtyKgs = latestMatch.NetDeliveryQtyKgs;
              if (latestMatch.RFD !== undefined && latestMatch.RFD !== "")
                row.RFD = latestMatch.RFD;
              if (
                latestMatch.Slowmoving !== undefined &&
                latestMatch.Slowmoving !== ""
              )
                row.Slowmoving = latestMatch.Slowmoving;
              if (
                latestMatch.FFStock !== undefined &&
                latestMatch.FFStock !== ""
              )
                row.FFStock = latestMatch.FFStock;
              if (
                latestMatch.RequiredQtyKgs !== undefined &&
                latestMatch.RequiredQtyKgs !== ""
              )
                row.RequiredQtyKgs = latestMatch.RequiredQtyKgs;
              if (latestMatch.Unit && latestMatch.Unit !== "")
                row.Unit = latestMatch.Unit;
              if (latestMatch.ProcessName && latestMatch.ProcessName !== "")
                row.ProcessName = latestMatch.ProcessName;
            }

            // Cross-populate Allowance, YarnReq, AllocatedQty, YarnBala from Knitting if available
            const knitMatch = knitNormItems.find(
              (kn) =>
                String(kn.Color || "")
                  .trim()
                  .toLowerCase() === myColor,
            );
            if (knitMatch) {
              if (
                (row.Allowance === undefined || row.Allowance === "") &&
                knitMatch.Allowance !== undefined &&
                knitMatch.Allowance !== ""
              )
                row.Allowance = knitMatch.Allowance;
              if (
                (row.YarnReq === undefined || row.YarnReq === "") &&
                knitMatch.YarnReq !== undefined &&
                knitMatch.YarnReq !== ""
              )
                row.YarnReq = knitMatch.YarnReq;
              if (
                (row.AllocatedQty === undefined || row.AllocatedQty === "") &&
                knitMatch.AllocatedQty !== undefined &&
                knitMatch.AllocatedQty !== ""
              )
                row.AllocatedQty = knitMatch.AllocatedQty;
              if (
                (row.YarnBala === undefined || row.YarnBala === "") &&
                knitMatch.YarnBala !== undefined &&
                knitMatch.YarnBala !== ""
              )
                row.YarnBala = knitMatch.YarnBala;
            }

            // Cross-populate DeliBal from Delivery or calculate
            const deliMatch = deliNormItems.find(
              (dn) =>
                String(dn.Color || "")
                  .trim()
                  .toLowerCase() === myColor,
            );
            if (
              deliMatch &&
              deliMatch.DeliBal !== undefined &&
              deliMatch.DeliBal !== ""
            ) {
              row.DeliBal = deliMatch.DeliBal;
            } else if (row.DeliBal === undefined || row.DeliBal === "") {
              const req = Number(row.RequiredQtyKgs) || 0;
              const del = Number(row.NetDeliveryQtyKgs) || 0;
              if (req > 0) row.DeliBal = req - del;
            }
          } else if (dept === "delivery") {
            const latestMatch =
              latestNormItems.find(
                (ln) =>
                  String(ln.Color || "")
                    .trim()
                    .toLowerCase() === myColor &&
                  String(ln.FabricConstruction || "")
                    .trim()
                    .toLowerCase() === myConst &&
                  String(ln.GSM || "")
                    .trim()
                    .toLowerCase() === myGSM,
              ) ||
              latestNormItems.find(
                (ln) =>
                  String(ln.Color || "")
                    .trim()
                    .toLowerCase() === myColor,
              );

            if (latestMatch) {
              if (
                latestMatch.Allowance !== undefined &&
                latestMatch.Allowance !== ""
              )
                row.Allowance = latestMatch.Allowance;
              if (
                latestMatch.YarnReq !== undefined &&
                latestMatch.YarnReq !== ""
              )
                row.YarnReq = latestMatch.YarnReq;
              if (
                latestMatch.AllocatedQty !== undefined &&
                latestMatch.AllocatedQty !== ""
              )
                row.AllocatedQty = latestMatch.AllocatedQty;
              if (
                latestMatch.YarnBala !== undefined &&
                latestMatch.YarnBala !== ""
              )
                row.YarnBala = latestMatch.YarnBala;
              if (
                latestMatch.GreyReq !== undefined &&
                latestMatch.GreyReq !== ""
              )
                row.GreyReq = latestMatch.GreyReq;
              if (
                latestMatch.KnitProd !== undefined &&
                latestMatch.KnitProd !== ""
              )
                row.KnitProd = latestMatch.KnitProd;
              if (
                latestMatch.KnitBala !== undefined &&
                latestMatch.KnitBala !== ""
              )
                row.KnitBala = latestMatch.KnitBala;
              if (
                latestMatch.NetReceivedQtyKgs !== undefined &&
                latestMatch.NetReceivedQtyKgs !== ""
              )
                row.NetReceivedQtyKgs = latestMatch.NetReceivedQtyKgs;
              if (
                latestMatch.NetDeliveryQtyKgs !== undefined &&
                latestMatch.NetDeliveryQtyKgs !== ""
              )
                row.NetDeliveryQtyKgs = latestMatch.NetDeliveryQtyKgs;
              if (
                latestMatch.DeliBal !== undefined &&
                latestMatch.DeliBal !== ""
              )
                row.DeliBal = latestMatch.DeliBal;
              if (latestMatch.RFD !== undefined && latestMatch.RFD !== "")
                row.RFD = latestMatch.RFD;
              if (
                latestMatch.Slowmoving !== undefined &&
                latestMatch.Slowmoving !== ""
              )
                row.Slowmoving = latestMatch.Slowmoving;
              if (
                latestMatch.FFStock !== undefined &&
                latestMatch.FFStock !== ""
              )
                row.FFStock = latestMatch.FFStock;
              if (
                latestMatch.RequiredQtyKgs !== undefined &&
                latestMatch.RequiredQtyKgs !== ""
              )
                row.RequiredQtyKgs = latestMatch.RequiredQtyKgs;
            }

            // Cross-populate BPQty, DyeingProd, DyeingBala from Dyeing items
            const dyeMatch = dyeNormItems.find(
              (dn) =>
                String(dn.Color || "")
                  .trim()
                  .toLowerCase() === myColor,
            );
            if (dyeMatch) {
              if (dyeMatch.BPQty !== undefined && dyeMatch.BPQty !== "")
                row.BPQty = dyeMatch.BPQty;
              if (
                dyeMatch.DyeingProd !== undefined &&
                dyeMatch.DyeingProd !== ""
              )
                row.DyeingProd = dyeMatch.DyeingProd;
              if (
                dyeMatch.DyeingBala !== undefined &&
                dyeMatch.DyeingBala !== ""
              )
                row.DyeingBala = dyeMatch.DyeingBala;
            }

            // Cross-populate knitting items if missing
            const knitMatch = knitNormItems.find(
              (kn) =>
                String(kn.Color || "")
                  .trim()
                  .toLowerCase() === myColor,
            );
            if (knitMatch) {
              if (
                (row.Allowance === undefined || row.Allowance === "") &&
                knitMatch.Allowance !== undefined &&
                knitMatch.Allowance !== ""
              )
                row.Allowance = knitMatch.Allowance;
              if (
                (row.YarnReq === undefined || row.YarnReq === "") &&
                knitMatch.YarnReq !== undefined &&
                knitMatch.YarnReq !== ""
              )
                row.YarnReq = knitMatch.YarnReq;
              if (
                (row.AllocatedQty === undefined || row.AllocatedQty === "") &&
                knitMatch.AllocatedQty !== undefined &&
                knitMatch.AllocatedQty !== ""
              )
                row.AllocatedQty = knitMatch.AllocatedQty;
              if (
                (row.YarnBala === undefined || row.YarnBala === "") &&
                knitMatch.YarnBala !== undefined &&
                knitMatch.YarnBala !== ""
              )
                row.YarnBala = knitMatch.YarnBala;
            }

            if (row.DeliBal === undefined || row.DeliBal === "") {
              const req = Number(row.RequiredQtyKgs) || 0;
              const del = Number(row.NetDeliveryQtyKgs) || 0;
              if (req > 0) row.DeliBal = req - del;
            }
          }

          row["OrderNo"] = plan.orderNo;
          if (!row["Buyer"]) row["Buyer"] = orderBuyerMap[plan.orderNo] || "";

          if (dept === "delivery") {
            let knitStart = "",
              knitEnd = "",
              knitType = "";
            let dyeStart = "",
              dyeEnd = "",
              dyeType = "";

            const myColor = String(row.Color || "")
              .trim()
              .toLowerCase();
            const myConst = String(row.FabricConstruction || "")
              .trim()
              .toLowerCase();
            const myGSM = String(row.GSM || "")
              .trim()
              .toLowerCase();

            if (plan.knitting && Array.isArray(plan.knitting)) {
              const kItem = plan.knitting.find(
                (k) =>
                  k.itemData &&
                  String(k.itemData.Color || "")
                    .trim()
                    .toLowerCase() === myColor &&
                  String(k.itemData.FabricConstruction || "")
                    .trim()
                    .toLowerCase() === myConst &&
                  String(k.itemData.GSM || "")
                    .trim()
                    .toLowerCase() === myGSM,
              );
              if (kItem) {
                knitStart = kItem.startDate || "";
                knitEnd = kItem.endDate || "";
                knitType = kItem.planType || "";
              }
            }

            if (plan.dyeing && Array.isArray(plan.dyeing)) {
              const dItem = plan.dyeing.find(
                (d) =>
                  d.itemData &&
                  String(d.itemData.Color || "")
                    .trim()
                    .toLowerCase() === myColor,
              );
              if (dItem) {
                dyeStart = dItem.startDate || "";
                dyeEnd = dItem.endDate || "";
                dyeType = dItem.planType || "";
              }
            }

            row["Knit Start Date"] = knitStart;
            row["Knit End Date"] = knitEnd;
            row["Knit Plan Type"] = knitType;
            row["Dyeing Start Date"] = dyeStart;
            row["Dyeing End Date"] = dyeEnd;
            row["Dyeing Plan Type"] = dyeType;
            row["Delivery Plan Start"] = item.startDate || "";
            row["Delivery Plan End"] = item.endDate || "";
            row["Delivery Plan Type"] = item.planType || "";
            row["Delivery Plan Start (Floor)"] = item.floorStartDate || "";
            row["Delivery Plan End (Floor)"] = item.floorEndDate || "";
            row["Delivery Plan Type (Floor)"] = item.floorPlanType || "";
            row["Limitation"] = item.limitation || "";
            row["Remarks"] = item.remarks || "";
          } else {
            row["Plan Start Date"] = item.startDate || "";
            row["Plan End Date"] = item.endDate || "";
            row["Plan Type"] = item.planType || "";
            if (dept === "yd") {
              row["Yarn Ok Date"] = item.yarnOkDate || "";
              row["Matching Option Date"] = item.matchingOptionDate || "";
              row["Floor Start Date"] = item.floorStartDate || "";
              row["Floor End Date"] = item.floorEndDate || "";
              row["Floor Plan Type"] = item.floorPlanType || "";

              let knitStart = "",
                knitEnd = "";

              if (
                plan.knitting &&
                Array.isArray(plan.knitting) &&
                plan.knitting.length > 0
              ) {
                const kItem = plan.knitting[0];
                knitStart = kItem.startDate || "";
                knitEnd = kItem.endDate || "";
              } else if (orderInfoMap[plan.orderNo]) {
                let parsedKnitStart =
                  orderInfoMap[plan.orderNo].knitStart !== "N/A" &&
                  orderInfoMap[plan.orderNo].knitStart !== "-"
                    ? orderInfoMap[plan.orderNo].knitStart
                    : "";
                let parsedKnitEnd =
                  orderInfoMap[plan.orderNo].knitEnd !== "N/A" &&
                  orderInfoMap[plan.orderNo].knitEnd !== "-"
                    ? orderInfoMap[plan.orderNo].knitEnd
                    : "";
                knitStart = parsedKnitStart;
                knitEnd = parsedKnitEnd;
              }

              row["Knit Start Date"] = knitStart;
              row["Knit End Date"] = knitEnd;
            }
            row["Limitation"] = item.limitation || "";
            row["Remarks"] = item.remarks || "";
          }

          allRows.push(row);
        });
      });
    }

    // 3. Include pure Pending items (only for Delivery) in Chunks
    if (dept === "delivery") {
      const pendingOrderNos = orderNos.filter((no) => !planDocOrderNos.has(no));

      for (let i = 0; i < pendingOrderNos.length; i += chunkSize) {
        const chunkNos = pendingOrderNos.slice(i, i + chunkSize);

        const [pendingItemsDocs, pendingPlanDocs] = await Promise.all([
          Order.find(
            { orderNo: { $in: chunkNos } },
            {
              orderNo: 1,
              buyer: 1,
              [`${dept}Items`]: 1,
              dyeingItems: 1,
              knittingItems: 1,
            },
          ).lean(),
          OrderDate.find(
            { orderNo: { $in: chunkNos } },
            { orderNo: 1, knitting: 1, dyeing: 1 },
          ).lean(),
        ]);

        const pendingPlanMap = {};
        pendingPlanDocs.forEach((p) => {
          pendingPlanMap[p.orderNo] = p;
        });

        pendingItemsDocs.forEach((orderDoc) => {
          const plan = pendingPlanMap[orderDoc.orderNo] || {};
          const dyeItems = (orderDoc.dyeingItems || []).map((di) =>
            normalizeItemRow(di, "dyeing"),
          );

          if (orderDoc[`${dept}Items`]) {
            orderDoc[`${dept}Items`].forEach((itemData) => {
              let row = normalizeItemRow(itemData, dept);
              row["OrderNo"] = orderDoc.orderNo;
              if (!row["Buyer"])
                row["Buyer"] =
                  orderDoc.buyer || orderBuyerMap[orderDoc.orderNo] || "";

              let knitStart = "",
                knitEnd = "",
                knitType = "";
              let dyeStart = "",
                dyeEnd = "",
                dyeType = "";

              const myColor = String(row.Color || "")
                .trim()
                .toLowerCase();
              const myConst = String(row.FabricConstruction || "")
                .trim()
                .toLowerCase();
              const myGSM = String(row.GSM || "")
                .trim()
                .toLowerCase();

              const dyeMatch = dyeItems.find(
                (di) =>
                  String(di.Color || "")
                    .trim()
                    .toLowerCase() === myColor,
              );
              if (dyeMatch) {
                if (dyeMatch.BPQty !== undefined && dyeMatch.BPQty !== "")
                  row.BPQty = dyeMatch.BPQty;
                if (
                  dyeMatch.DyeingProd !== undefined &&
                  dyeMatch.DyeingProd !== ""
                )
                  row.DyeingProd = dyeMatch.DyeingProd;
                if (
                  dyeMatch.DyeingBala !== undefined &&
                  dyeMatch.DyeingBala !== ""
                )
                  row.DyeingBala = dyeMatch.DyeingBala;
              }

              if (plan.knitting && Array.isArray(plan.knitting)) {
                const kItem = plan.knitting.find(
                  (k) =>
                    k.itemData &&
                    String(k.itemData.Color || "")
                      .trim()
                      .toLowerCase() === myColor &&
                    String(k.itemData.FabricConstruction || "")
                      .trim()
                      .toLowerCase() === myConst &&
                    String(k.itemData.GSM || "")
                      .trim()
                      .toLowerCase() === myGSM,
                );
                if (kItem) {
                  knitStart = kItem.startDate || "";
                  knitEnd = kItem.endDate || "";
                  knitType = kItem.planType || "";
                }
              }

              if (plan.dyeing && Array.isArray(plan.dyeing)) {
                const dItem = plan.dyeing.find(
                  (d) =>
                    d.itemData &&
                    String(d.itemData.Color || "")
                      .trim()
                      .toLowerCase() === myColor,
                );
                if (dItem) {
                  dyeStart = dItem.startDate || "";
                  dyeEnd = dItem.endDate || "";
                  dyeType = dItem.planType || "";
                }
              }

              row["Knit Start Date"] = knitStart;
              row["Knit End Date"] = knitEnd;
              row["Knit Plan Type"] = knitType;
              row["Dyeing Start Date"] = dyeStart;
              row["Dyeing End Date"] = dyeEnd;
              row["Dyeing Plan Type"] = dyeType;
              row["Delivery Plan Start"] = "";
              row["Delivery Plan End"] = "";
              row["Delivery Plan Type"] = "";
              row["Delivery Plan Start (Floor)"] = "";
              row["Delivery Plan End (Floor)"] = "";
              row["Delivery Plan Type (Floor)"] = "";
              row["Limitation"] = "";
              row["Remarks"] = "";
              allRows.push(row);
            });
          }
        });
      }
    }

    if (allRows.length === 0) {
      return res.status(404).json({ message: "No data to export" });
    }

    // 4. Generate Excel
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(allRows);

    // 5. Post-process cells: convert dates and OrderNo to proper formats
    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      const headers = [];
      let orderNoCol = -1;
      const dateCols = [];

      // Pre-calculate header indexes for speed
      for (let C = range.s.c; C <= range.e.c; ++C) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
        const hdr = cell ? String(cell.v).toLowerCase() : "";
        headers[C] = hdr;
        if (hdr === "orderno") orderNoCol = C;
        if (
          hdr.includes("date") ||
          hdr.includes("start") ||
          hdr.includes("end")
        ) {
          dateCols.push(C);
        }
      }

      for (let R = 1; R <= range.e.r; ++R) {
        // Convert OrderNo to number format
        if (orderNoCol >= 0) {
          const cellRef = XLSX.utils.encode_cell({ r: R, c: orderNoCol });
          const cell = ws[cellRef];
          if (cell && cell.v) {
            const num = Number(cell.v);
            if (!isNaN(num)) {
              cell.t = "n";
              cell.v = num;
            }
          }
        }

        // Convert date columns to Excel date numbers (optimized loop)
        for (const C of dateCols) {
          const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
          const cell = ws[cellRef];
          if (
            !cell ||
            !cell.v ||
            cell.v === "" ||
            cell.v === "N/A" ||
            cell.v === "-"
          )
            continue;

          const d = new Date(cell.v);
          if (!isNaN(d.getTime())) {
            const excelDate = d.getTime() / 86400000 + 25569;
            cell.t = "n";
            cell.v = excelDate;
            cell.z = "dd/mm/yyyy";
          }
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, ws, `${dept}_Report`);

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const dateStr = new Date().toISOString().split("T")[0];
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${dept.toUpperCase()}_Report_${dateStr}.xlsx"`,
    );
    res.send(buf);
  } catch (error) {
    console.error("Report download error:", error);
    res.status(500).json({ message: "Error generating report" });
  }
});

// ==========================================
// GET /api/orders/tracking-download/:dept — Download tracking report as Excel
// Generates Excel with ALL confirmed orders for the department
// ==========================================
router.get("/tracking-download/:dept", async (req, res) => {
  try {
    const XLSX = require("xlsx");
    const { dept } = req.params;
    const { status = "Pending" } = req.query; // 'Pending' or 'Complete'

    const dbDept = dept === "deliveryfloor" ? "delivery" : dept;
    const statusField = `${dbDept}PlanStatus`;
    const actualKey = (dept === "deliveryfloor" ? "delivery" : dept) + "Actual";

    // Get confirmed orders only
    const orderFilter = { [statusField]: "Confirm" };

    // Only include orders from uploaded file
    const deptValid = await DeptValidOrders.findOne({ dept: dbDept }).lean();
    if (
      deptValid &&
      deptValid.validOrderNos &&
      deptValid.validOrderNos.length > 0
    ) {
      orderFilter.orderNo = { $in: deptValid.validOrderNos };
    }

    if (req.allowedRawBuyers) orderFilter.buyer = { $in: req.allowedRawBuyers };
    const confirmedOrders = await Order.find(orderFilter, {
      orderNo: 1,
      buyer: 1,
      bookingDate: 1,
    }).lean();

    const orderNos = confirmedOrders.map((o) => o.orderNo);
    const orderMap = {};
    confirmedOrders.forEach((o) => {
      orderMap[o.orderNo] = o;
    });

    // Find orphaned tracking data from OrderDate
    const orphanedDocs = await OrderDate.find(
      {
        orderNo: { $nin: orderNos },
        $or: [
          { [`${dbDept}Status`]: "Confirm" },
          { [`${actualKey}.actualStart`]: { $exists: true, $ne: "" } },
          { [`${actualKey}.actualEnd`]: { $exists: true, $ne: "" } },
          { [`${actualKey}.failReason`]: { $exists: true, $ne: "" } },
          { [`${actualKey}.relatedDept`]: { $exists: true, $ne: "" } },
        ],
      },
      { orderNo: 1, [dbDept]: 1, [actualKey]: 1 },
    ).lean();

    // Get Order info for orphaned orders
    const orphanedOrderNos = orphanedDocs.map((d) => d.orderNo);
    if (orphanedOrderNos.length > 0) {
      const orphanOrderFilter = { orderNo: { $in: orphanedOrderNos } };
      if (req.allowedRawBuyers)
        orphanOrderFilter.buyer = { $in: req.allowedRawBuyers };
      const orphanedOrderInfos = await Order.find(orphanOrderFilter, {
        orderNo: 1,
        buyer: 1,
        bookingDate: 1,
      }).lean();
      orphanedOrderInfos.forEach((o) => {
        if (!orderMap[o.orderNo]) orderMap[o.orderNo] = o;
      });
    }

    // Get plan data for confirmed/completed orders
    const planDocs =
      orderNos.length > 0
        ? await OrderDate.find(
            { orderNo: { $in: orderNos } },
            { orderNo: 1, [dbDept]: 1, [actualKey]: 1 },
          ).lean()
        : [];

    // Add orphaned docs to planDocs
    const planDocSet = new Set(planDocs.map((p) => p.orderNo));
    orphanedDocs.forEach((doc) => {
      if (req.allowedRawBuyers && !orderMap[doc.orderNo]) return; // Skip orphans belonging to unallowed buyers
      if (!planDocSet.has(doc.orderNo)) {
        planDocs.push(doc);
        planDocSet.add(doc.orderNo);
      }
    });

    // Ensure confirmed orderNos have a doc in planDocs (so they get processed)
    orderNos.forEach((orderNo) => {
      if (!planDocSet.has(orderNo)) {
        planDocs.push({ orderNo, [dbDept]: [] });
        planDocSet.add(orderNo);
      }
    });

    // Fetch uploaded items to populate dates for orders that only exist in Order collection
    const trackingOrderNos = planDocs.map((p) => p.orderNo);
    const trackingOrders = await Order.find(
      { orderNo: { $in: trackingOrderNos } },
      { orderNo: 1, [`${dbDept}Items`]: 1 },
    ).lean();
    const trackingOrdersMap = {};
    trackingOrders.forEach((o) => {
      trackingOrdersMap[o.orderNo] = o[`${dbDept}Items`] || [];
    });

    planDocs.forEach((doc) => {
      if (!doc[dbDept] || doc[dbDept].length === 0) {
        const rawItems = trackingOrdersMap[doc.orderNo] || [];
        doc[dbDept] = rawItems.map((raw) => {
          let startDate =
            raw["Plan Start Date"] ||
            raw["Plan Start"] ||
            raw["Start Date"] ||
            raw["Knit Start Date"] ||
            raw["Dyeing Start Date"] ||
            "";
          let endDate =
            raw["Plan End Date"] ||
            raw["Plan End"] ||
            raw["End Date"] ||
            raw["Knit End Date"] ||
            raw["Dyeing End Date"] ||
            "";

          if (dbDept === "delivery") {
            startDate = raw["Delivery Plan Start"] || startDate;
            endDate = raw["Delivery Plan End"] || endDate;
            return {
              itemData: raw,
              floorStartDate: raw["Delivery Plan Start (Floor)"] || "",
              floorEndDate: raw["Delivery Plan End (Floor)"] || "",
              floorPlanType: raw["Delivery Plan Type (Floor)"] || "",
              startDate,
              endDate,
            };
          }
          return {
            itemData: raw,
            startDate,
            endDate,
          };
        });
      }
    });

    // Build tracking rows
    let rows = [];

    // Process OrderDate docs
    const processedOrderNos = new Set();
    planDocs.forEach((plan) => {
      processedOrderNos.add(plan.orderNo);
      const deptItems = plan[dbDept] || [];
      const orderInfo = orderMap[plan.orderNo] || {};

      let planStart = "",
        planEnd = "";
      if (deptItems.length > 0) {
        if (dept === "deliveryfloor") {
          const floorItems = deptItems.filter(
            (i) =>
              i.floorPlanType === "Confirm" || i.floorPlanType === "Tentative",
          );
          const starts = floorItems
            .map((i) => i.floorStartDate)
            .filter((d) => d && d !== "");
          const ends = floorItems
            .map((i) => i.floorEndDate)
            .filter((d) => d && d !== "");
          if (starts.length) {
            starts.sort();
            planStart = starts[0];
          }
          if (ends.length) {
            ends.sort();
            planEnd = ends[ends.length - 1];
          }
        } else {
          const starts = deptItems
            .map((i) => i.startDate)
            .filter((d) => d && d !== "");
          const ends = deptItems
            .map((i) => i.endDate)
            .filter((d) => d && d !== "");
          if (starts.length) {
            starts.sort();
            planStart = starts[0];
          }
          if (ends.length) {
            ends.sort();
            planEnd = ends[ends.length - 1];
          }
        }
      }

      let actualStart = "",
        actualEnd = "",
        failReason = "",
        relatedDept = "";
      if (plan[actualKey]) {
        actualStart = plan[actualKey].actualStart || "";
        actualEnd = plan[actualKey].actualEnd || "";
        failReason = plan[actualKey].failReason || "";
        relatedDept = plan[actualKey].relatedDept || "";
      }

      // Filter by status (Pending = no actualEnd, Complete = has actualEnd with real date)
      const hasActualEnd =
        actualEnd && actualEnd.trim() !== "" && actualEnd !== "-";
      if (status === "Pending" && hasActualEnd) return;
      if (status === "Complete" && !hasActualEnd) return;

      // Compute pass/fail
      const todayDateVal = new Date().setHours(0, 0, 0, 0);
      const calcResult = (actualDate, planDate) => {
        const hasActual =
          actualDate && actualDate.trim() !== "" && actualDate !== "-";
        const hasPlan = planDate && planDate.trim() !== "" && planDate !== "-";
        if (hasActual) {
          if (!hasPlan) return "—";
          return new Date(actualDate).setHours(0, 0, 0, 0) <=
            new Date(planDate).setHours(0, 0, 0, 0)
            ? "Pass"
            : "Fail";
        }
        if (hasPlan) {
          if (new Date(planDate).setHours(0, 0, 0, 0) < todayDateVal) {
            return "Fail";
          }
        }
        return "—";
      };

      const startResult = calcResult(actualStart, planStart);
      const endResult = calcResult(actualEnd, planEnd);

      rows.push({
        "Order/Booking No.": plan.orderNo,
        Buyer: orderInfo.buyer || "",
        "Plan Start": planStart,
        "Plan End": planEnd,
        "Actual Start": actualStart,
        "Actual End": actualEnd,
        "Start Result": startResult,
        "End Result": endResult,
        "Fail Reason": failReason,
        "Related Dept.": relatedDept,
      });
    });

    // Add orders without OrderDate docs (only for Pending status)
    orderNos.forEach((orderNo) => {
      if (!processedOrderNos.has(orderNo)) {
        const orderInfo = orderMap[orderNo] || {};
        if (status === "Complete") return; // No actual data = pending
        rows.push({
          "Order/Booking No.": orderNo,
          Buyer: orderInfo.buyer || "",
          "Plan Start": "",
          "Plan End": "",
          "Actual Start": "",
          "Actual End": "",
          "Start Result": "—",
          "End Result": "—",
          "Fail Reason": "",
          "Related Dept.": "",
        });
      }
    });

    if (rows.length === 0) {
      return res.status(404).json({ message: "No data to export" });
    }

    // Add SL column
    rows.forEach((r, i) => {
      r["SL"] = i + 1;
    });
    // Reorder columns
    const orderedRows = rows.map((r) => ({
      SL: r["SL"],
      "Order/Booking No.": r["Order/Booking No."],
      Buyer: r["Buyer"],
      "Plan Start": r["Plan Start"],
      "Plan End": r["Plan End"],
      "Actual Start": r["Actual Start"],
      "Actual End": r["Actual End"],
      "Start Result": r["Start Result"],
      "End Result": r["End Result"],
      "Fail Reason": r["Fail Reason"],
      "Related Dept.": r["Related Dept."],
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(orderedRows);

    // Format date columns as proper Excel dates (not text)
    const range = XLSX.utils.decode_range(ws["!ref"]);
    // Find which columns are date columns by checking header row
    const dateColIndices = [];
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
      if (cell) {
        const hdr = String(cell.v).toLowerCase();
        if (
          hdr === "plan start" ||
          hdr === "plan end" ||
          hdr === "actual start" ||
          hdr === "actual end"
        ) {
          dateColIndices.push(C);
        }
      }
    }
    // Convert date text values to Excel date cells
    for (let R = 1; R <= range.e.r; ++R) {
      for (const C of dateColIndices) {
        const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[cellRef];
        if (
          !cell ||
          cell.v === undefined ||
          cell.v === null ||
          cell.v === "" ||
          cell.v === "—" ||
          cell.v === "-"
        )
          continue;
        const d = new Date(cell.v);
        if (!isNaN(d.getTime())) {
          cell.t = "d";
          cell.v = d;
          cell.z = "dd/mm/yyyy";
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, ws, "Report");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const deptName = dept.charAt(0).toUpperCase() + dept.slice(1);
    const dateStr = new Date().toISOString().split("T")[0];
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${deptName}_${status}_Tracking_Report_${dateStr}.xlsx"`,
    );
    res.send(buf);
  } catch (error) {
    console.error("Tracking download error:", error);
    res.status(500).json({ message: "Error generating report" });
  }
});

module.exports = router;
