const DeliveryCompanyOrderHandover = require("../models/deliveryCompanyOrderHandover");
const DeliveryCompany = require("../models/deliveryCompany");
const DeliverySession = require("../models/deliverySession");
const Order = require("../models/order");
const { safeLog } = require("../utils/logSanitize.util");

const HANDOVER_STATUS = "delivery_handover_complete";
const REQUIRED_PREVIOUS_STATUS = "ready_for_driver_pickup";
const DRIVER_CONFIRMED_ORDER_STATUSES = new Set([
  "delivered_to_customer",
  "delivered",
  "completed_off_platform",
]);

function isLegacyDriverConfirmed(orderStatus) {
  return DRIVER_CONFIRMED_ORDER_STATUSES.has(orderStatus);
}

function handoverNeedsDriverReview(handover, orderStatus) {
  if (!handover || handover.driverConfirmedAt) return false;
  return !isLegacyDriverConfirmed(orderStatus);
}

function findHandoverTimestamp(statusTimeline = []) {
  if (!Array.isArray(statusTimeline)) return null;
  for (let i = statusTimeline.length - 1; i >= 0; i -= 1) {
    const entry = statusTimeline[i];
    if (entry?.status === HANDOVER_STATUS && entry.at) {
      return new Date(entry.at);
    }
  }
  return null;
}

async function resolveDeliveryCompanyForOrder(orderId) {
  const order = await Order.findById(orderId)
    .select("deliveryGroup status deliveryCompanyHandoverCompany")
    .lean();
  if (!order?.deliveryGroup) return null;

  const session = await DeliverySession.findById(order.deliveryGroup)
    .select("deliveryCompany")
    .lean();
  if (!session?.deliveryCompany) return null;

  return {
    order,
    companyId: session.deliveryCompany,
  };
}

const BILLING_SKIP_REASONS = new Set(["period_closed", "billing_frozen"]);

async function releaseBillingIncrementClaim(orderId) {
  await DeliveryCompanyOrderHandover.updateOne(
    { order: orderId, billingCountApplied: true },
    { $set: { billingCountApplied: false } },
  );
}

/**
 * Atomically claim and apply one billing-period increment for a handover row.
 * Safe under duplicate handover requests and retriable after transient billing failures.
 */
async function applyBillingIncrementForHandover(orderId, companyId, handoverAt) {
  const claimed = await DeliveryCompanyOrderHandover.findOneAndUpdate(
    { order: orderId, billingCountApplied: false },
    { $set: { billingCountApplied: true } },
  );
  if (!claimed) {
    return { applied: false, reason: "billing_already_applied_or_legacy" };
  }

  const deliveryCompanyBillingService = require("./deliveryCompanyBilling.service");
  try {
    const billingResult = await deliveryCompanyBillingService.incrementHandoverCount(companyId, handoverAt);
    if (!billingResult?.incremented && !BILLING_SKIP_REASONS.has(billingResult?.reason)) {
      await releaseBillingIncrementClaim(orderId);
      const err = new Error("فشل زيادة عداد فوترة شركة التوصيل");
      err.status = 500;
      err.billingReason = billingResult?.reason || "unknown";
      throw err;
    }
    if (!billingResult?.incremented) {
      safeLog("info", "delivery_billing_increment_not_applied", {
        companyId: String(companyId),
        orderId: String(orderId),
        reason: billingResult?.reason,
        monthKey: billingResult?.monthKey,
      });
    }
    return { applied: Boolean(billingResult?.incremented), billingResult };
  } catch (billingErr) {
    await releaseBillingIncrementClaim(orderId);
    safeLog("error", "delivery_billing_increment_failed", {
      message: billingErr.message,
      companyId: String(companyId),
      orderId: String(orderId),
      status: billingErr.status || 500,
    });
    throw billingErr;
  }
}

/**
 * Records a store handover to the delivery company (accounting event).
 * Idempotent — safe to call on retries; only the first successful insert increments the count.
 */
async function recordStoreHandoverToDeliveryCompany(orderId, {
  previousStatus,
  storeId = null,
  confirmedBy = null,
} = {}) {
  if (previousStatus && previousStatus !== REQUIRED_PREVIOUS_STATUS) {
    return { recorded: false, reason: "invalid_previous_status" };
  }

  const resolved = await resolveDeliveryCompanyForOrder(orderId);
  if (!resolved) return { recorded: false, reason: "no_delivery_company" };

  const { order, companyId } = resolved;
  if (order.status !== HANDOVER_STATUS) {
    return { recorded: false, reason: "not_handover_status" };
  }

  let existing = await DeliveryCompanyOrderHandover.findOne({ order: orderId })
    .select("_id deliveryCompany billingCountApplied handoverAt")
    .lean();
  if (existing?.billingCountApplied === true) {
    return {
      recorded: false,
      reason: "already_recorded",
      companyId: existing.deliveryCompany,
    };
  }

  const fullOrder = await Order.findById(orderId).select("statusTimeline deliveryGroup").lean();
  let handoverAt = existing?.handoverAt || findHandoverTimestamp(fullOrder?.statusTimeline) || new Date();
  let activeCompanyId = existing?.deliveryCompany || companyId;
  let newlyCreated = false;

  if (!existing) {
    let assignedDriverId = null;
    if (fullOrder?.deliveryGroup) {
      const session = await DeliverySession.findById(fullOrder.deliveryGroup)
        .select("assignedDriver.driverId")
        .lean();
      assignedDriverId = session?.assignedDriver?.driverId || null;
    }

    try {
      await DeliveryCompanyOrderHandover.create({
        order: orderId,
        deliveryCompany: companyId,
        store: storeId || undefined,
        confirmedBy: confirmedBy || undefined,
        handoverAt,
        assignedDriverId: assignedDriverId || undefined,
        billingCountApplied: false,
      });
      newlyCreated = true;
    } catch (err) {
      if (err?.code !== 11000) throw err;

      existing = await DeliveryCompanyOrderHandover.findOne({ order: orderId })
        .select("_id deliveryCompany billingCountApplied handoverAt")
        .lean();
      if (!existing) throw err;
      if (existing.billingCountApplied === true) {
        return { recorded: false, reason: "duplicate", companyId: existing.deliveryCompany };
      }
      handoverAt = existing.handoverAt || handoverAt;
      activeCompanyId = existing.deliveryCompany;
    }
  }

  if (newlyCreated) {
    await DeliveryCompany.updateOne(
      { _id: activeCompanyId },
      { $inc: { handedOverOrderCount: 1 } },
    );

    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          deliveryCompanyHandoverAt: handoverAt,
          deliveryCompanyHandoverCompany: activeCompanyId,
        },
      },
    );
  }

  const billing = await applyBillingIncrementForHandover(orderId, activeCompanyId, handoverAt);

  if (newlyCreated) {
    return { recorded: true, companyId: activeCompanyId, handoverAt, billingApplied: billing.applied };
  }

  return {
    recorded: false,
    reason: existing ? "already_recorded" : "duplicate",
    companyId: activeCompanyId,
    handoverAt,
    billingRecovered: billing.applied,
  };
}

async function countHandoversForCompany(companyId) {
  if (!companyId) return 0;
  return DeliveryCompanyOrderHandover.countDocuments({
    deliveryCompany: companyId,
  });
}

async function countHandoversByCompaniesForMonth(companyIds, monthKey) {
  if (!Array.isArray(companyIds) || !companyIds.length) return new Map();
  const { getMonthBounds } = require("../utils/billingMonth.util");
  const { start, end } = getMonthBounds(monthKey);
  const rows = await DeliveryCompanyOrderHandover.aggregate([
    {
      $match: {
        deliveryCompany: { $in: companyIds },
        handoverAt: { $gte: start, $lt: end },
      },
    },
    { $group: { _id: "$deliveryCompany", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

async function countHandoversByCompaniesLifetime(companyIds) {
  if (!Array.isArray(companyIds) || !companyIds.length) return new Map();
  const rows = await DeliveryCompanyOrderHandover.aggregate([
    { $match: { deliveryCompany: { $in: companyIds } } },
    { $group: { _id: "$deliveryCompany", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

async function rebuildCompanyHandoverCount(companyId) {
  const count = await countHandoversForCompany(companyId);
  await DeliveryCompany.updateOne(
    { _id: companyId },
    { $set: { handedOverOrderCount: count } },
  );
  return count;
}

async function markDriverConfirmedForOrders(orderIds, driverId) {
  if (!Array.isArray(orderIds) || !orderIds.length) return { updated: 0 };
  const now = new Date();
  const result = await DeliveryCompanyOrderHandover.updateMany(
    {
      order: { $in: orderIds },
      driverConfirmedAt: null,
    },
    {
      $set: {
        driverConfirmedAt: now,
        driverConfirmedBy: driverId || undefined,
      },
    },
  );
  return { updated: result.modifiedCount || 0 };
}

async function listDriverPendingConfirmations(driverId) {
  if (!driverId) return [];
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const handovers = await DeliveryCompanyOrderHandover.find({
    assignedDriverId: driverId,
    driverConfirmedAt: null,
    handoverAt: { $lte: cutoff },
  })
    .sort({ handoverAt: 1 })
    .limit(20)
    .lean();

  if (!handovers.length) return [];

  const orderIds = handovers.map((h) => h.order);
  const orders = await Order.find({ _id: { $in: orderIds } })
    .select("orderNumber status deliveryGroup")
    .lean();
  const orderMap = new Map(orders.map((o) => [String(o._id), o]));

  return handovers
    .filter((h) => {
      const order = orderMap.get(String(h.order));
      return order && handoverNeedsDriverReview(h, order.status);
    })
    .map((h) => {
      const order = orderMap.get(String(h.order));
      return {
        handoverId: h._id,
        orderId: h.order,
        orderNumber: order?.orderNumber || "",
        sessionId: order?.deliveryGroup || null,
        handoverAt: h.handoverAt,
      };
    });
}

async function listAdminHandoversForMonth(companyId, monthKey) {
  const { getMonthBounds } = require("../utils/billingMonth.util");
  const { start, end } = getMonthBounds(monthKey);
  const handovers = await DeliveryCompanyOrderHandover.find({
    deliveryCompany: companyId,
    handoverAt: { $gte: start, $lt: end },
  })
    .sort({ handoverAt: -1 })
    .lean();

  if (!handovers.length) return [];

  const orderIds = handovers.map((h) => h.order);
  const orders = await Order.find({ _id: { $in: orderIds } })
    .select("orderNumber status")
    .lean();
  const orderMap = new Map(orders.map((o) => [String(o._id), o]));

  return handovers.map((h) => {
    const order = orderMap.get(String(h.order));
    const needsReview = handoverNeedsDriverReview(h, order?.status);
    return {
      _id: h._id,
      orderId: h.order,
      orderNumber: order?.orderNumber || "",
      orderStatus: order?.status || "",
      handoverAt: h.handoverAt,
      driverConfirmedAt: h.driverConfirmedAt || null,
      driverConfirmed: !needsReview,
      needsReview,
    };
  });
}

async function countUnconfirmedHandoversForMonth(companyId, monthKey) {
  const rows = await listAdminHandoversForMonth(companyId, monthKey);
  return rows.filter((r) => r.needsReview).length;
}

async function listUnconfirmedHandoversForCompany(companyId, monthKey) {
  const { getMonthBounds } = require("../utils/billingMonth.util");
  const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
  const { start, end } = getMonthBounds(monthKey);

  const handovers = await DeliveryCompanyOrderHandover.find({
    deliveryCompany: companyId,
    handoverAt: { $gte: start, $lt: end },
    driverConfirmedAt: null,
  })
    .sort({ handoverAt: -1 })
    .lean();

  if (!handovers.length) return [];

  const orderIds = handovers.map((h) => h.order);
  const driverIds = [
    ...new Set(handovers.map((h) => h.assignedDriverId).filter(Boolean).map(String)),
  ];

  const [orders, drivers, company] = await Promise.all([
    Order.find({ _id: { $in: orderIds } })
      .select("orderNumber status customerName createdAt")
      .lean(),
    driverIds.length
      ? DeliveryCompanyDriver.find({ _id: { $in: driverIds } }).select("name").lean()
      : [],
    DeliveryCompany.findById(companyId).select("name").lean(),
  ]);

  const orderMap = new Map(orders.map((o) => [String(o._id), o]));
  const driverMap = new Map(drivers.map((d) => [String(d._id), d]));
  const companyName = company?.name || "";

  return handovers
    .filter((h) => {
      const order = orderMap.get(String(h.order));
      return order && handoverNeedsDriverReview(h, order.status);
    })
    .map((h) => {
      const order = orderMap.get(String(h.order));
      const driver = h.assignedDriverId
        ? driverMap.get(String(h.assignedDriverId))
        : null;
      return {
        handoverId: h._id,
        orderId: h.order,
        orderNumber: order?.orderNumber || "",
        customerName: order?.customerName || "",
        orderDate: order?.createdAt || h.handoverAt,
        handoverAt: h.handoverAt,
        driverName: driver?.name || "",
        companyName,
      };
    });
}

async function countUnconfirmedHandoversByCompanies(companyIds, monthKey) {
  if (!Array.isArray(companyIds) || !companyIds.length) return new Map();

  const { getMonthBounds } = require("../utils/billingMonth.util");
  const { start, end } = getMonthBounds(monthKey);

  const handovers = await DeliveryCompanyOrderHandover.find({
    deliveryCompany: { $in: companyIds },
    handoverAt: { $gte: start, $lt: end },
    driverConfirmedAt: null,
  })
    .select("order deliveryCompany assignedDriverId driverConfirmedAt")
    .lean();

  if (!handovers.length) return new Map();

  const orderIds = handovers.map((h) => h.order);
  const orders = await Order.find({ _id: { $in: orderIds } })
    .select("status")
    .lean();
  const orderMap = new Map(orders.map((o) => [String(o._id), o]));

  const counts = new Map();
  for (const h of handovers) {
    const order = orderMap.get(String(h.order));
    if (!order || !handoverNeedsDriverReview(h, order.status)) continue;
    const key = String(h.deliveryCompany);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

module.exports = {
  HANDOVER_STATUS,
  REQUIRED_PREVIOUS_STATUS,
  recordStoreHandoverToDeliveryCompany,
  countHandoversForCompany,
  countHandoversByCompaniesForMonth,
  countHandoversByCompaniesLifetime,
  rebuildCompanyHandoverCount,
  findHandoverTimestamp,
  markDriverConfirmedForOrders,
  listDriverPendingConfirmations,
  listAdminHandoversForMonth,
  countUnconfirmedHandoversForMonth,
  listUnconfirmedHandoversForCompany,
  countUnconfirmedHandoversByCompanies,
  handoverNeedsDriverReview,
  isLegacyDriverConfirmed,
};
