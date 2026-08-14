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

async function resolveDeliveryCompanyForOrder(orderId, committedOrder = null) {
  const hasSnapshot = Boolean(committedOrder?.deliveryGroup);
  const order = hasSnapshot
    ? committedOrder
    : await Order.findById(orderId)
      .select("deliveryGroup status deliveryCompanyHandoverCompany statusTimeline")
      .lean();
  if (!order?.deliveryGroup) return null;

  const session = await DeliverySession.findById(order.deliveryGroup)
    .select("deliveryCompany assignedDriver.driverId")
    .lean();
  if (!session?.deliveryCompany) return null;

  return {
    order,
    companyId: session.deliveryCompany,
    session,
  };
}

function orderHasHandoverStatus(order, committedOrder = null) {
  const status = committedOrder?.status ?? order?.status;
  return status === HANDOVER_STATUS;
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
 * billingCountApplied stays true only after a successful period increment.
 */
async function applyBillingIncrementForHandover(orderId, companyId, handoverAt) {
  const claimed = await DeliveryCompanyOrderHandover.findOneAndUpdate(
    { order: orderId, billingCountApplied: { $ne: true } },
    { $set: { billingCountApplied: true } },
  );
  if (!claimed) {
    return { applied: false, reason: "billing_already_applied" };
  }

  const deliveryCompanyBillingService = require("./deliveryCompanyBilling.service");
  try {
    const billingResult = await deliveryCompanyBillingService.incrementHandoverCount(companyId, handoverAt);
    if (!billingResult?.incremented) {
      await releaseBillingIncrementClaim(orderId);
      const reason = billingResult?.reason || "increment_failed";
      const level = BILLING_SKIP_REASONS.has(reason) ? "info" : "error";
      safeLog(level, "delivery_billing_increment_not_applied", {
        companyId: String(companyId),
        orderId: String(orderId),
        reason,
        monthKey: billingResult?.monthKey,
      });
      return { applied: false, reason };
    }

    if (billingResult.monthKey) {
      await deliveryCompanyBillingService.reconcileCountingPeriodFromLedger(
        companyId,
        billingResult.monthKey,
      ).catch((err) => {
        safeLog("warn", "delivery_billing_reconcile_failed", {
          companyId: String(companyId),
          orderId: String(orderId),
          monthKey: billingResult.monthKey,
          message: err?.message,
        });
      });
    }

    return { applied: true, billingResult };
  } catch (billingErr) {
    await releaseBillingIncrementClaim(orderId);
    safeLog("error", "delivery_billing_increment_failed", {
      message: billingErr.message,
      companyId: String(companyId),
      orderId: String(orderId),
      status: billingErr.status || 500,
    });
    return { applied: false, reason: "increment_error" };
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
  committedOrder = null,
} = {}) {
  if (previousStatus && previousStatus !== REQUIRED_PREVIOUS_STATUS) {
    return { recorded: false, reason: "invalid_previous_status" };
  }

  const resolved = await resolveDeliveryCompanyForOrder(orderId, committedOrder);
  if (!resolved) {
    safeLog("warn", "delivery_company_handover_no_company", {
      orderId: String(orderId),
      hasCommittedOrder: Boolean(committedOrder),
      deliveryGroup: committedOrder?.deliveryGroup ? String(committedOrder.deliveryGroup) : null,
    });
    return { recorded: false, reason: "no_delivery_company" };
  }

  const { order, companyId, session } = resolved;
  if (!orderHasHandoverStatus(order, committedOrder)) {
    safeLog("warn", "delivery_company_handover_not_handover_status", {
      orderId: String(orderId),
      dbStatus: order?.status || null,
      committedStatus: committedOrder?.status || null,
    });
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

  const fullOrder = committedOrder?.statusTimeline
    ? committedOrder
    : await Order.findById(orderId).select("statusTimeline deliveryGroup").lean();
  let handoverAt = existing?.handoverAt || findHandoverTimestamp(fullOrder?.statusTimeline) || new Date();
  let activeCompanyId = existing?.deliveryCompany || companyId;
  let newlyCreated = false;

  if (!existing) {
    const assignedDriverId = session?.assignedDriver?.driverId || null;

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

async function listPendingCustomerDeliveriesForCompany(companyId, { monthKey } = {}) {
  const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
  const query = {
    deliveryCompany: companyId,
    driverConfirmedAt: null,
  };
  if (monthKey) {
    const { getMonthBounds } = require("../utils/billingMonth.util");
    const { start, end } = getMonthBounds(monthKey);
    query.handoverAt = { $gte: start, $lt: end };
  }

  const handovers = await DeliveryCompanyOrderHandover.find(query)
    .sort({ handoverAt: -1 })
    .lean();

  if (!handovers.length) return [];

  const orderIds = handovers.map((h) => h.order);
  const driverIds = [
    ...new Set(handovers.map((h) => h.assignedDriverId).filter(Boolean).map(String)),
  ];

  const [orders, drivers] = await Promise.all([
    Order.find({ _id: { $in: orderIds } })
      .select("orderNumber status customerName createdAt")
      .lean(),
    driverIds.length
      ? DeliveryCompanyDriver.find({ _id: { $in: driverIds } }).select("name").lean()
      : [],
  ]);

  const orderMap = new Map(orders.map((o) => [String(o._id), o]));
  const driverMap = new Map(drivers.map((d) => [String(d._id), d]));

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
        handoverAt: h.handoverAt,
        driverName: driver?.name || "",
      };
    });
}

async function listUnconfirmedHandoversForCompany(companyId, monthKey) {
  return listPendingCustomerDeliveriesForCompany(companyId, { monthKey });
}

async function countPendingCustomerDeliveriesForCompany(companyId) {
  const rows = await listPendingCustomerDeliveriesForCompany(companyId);
  return rows.length;
}

async function countPendingCustomerDeliveriesByCompanies(companyIds) {
  if (!Array.isArray(companyIds) || !companyIds.length) return new Map();

  const handovers = await DeliveryCompanyOrderHandover.find({
    deliveryCompany: { $in: companyIds },
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
  listPendingCustomerDeliveriesForCompany,
  listUnconfirmedHandoversForCompany,
  countPendingCustomerDeliveriesForCompany,
  countPendingCustomerDeliveriesByCompanies,
  countUnconfirmedHandoversByCompanies,
  handoverNeedsDriverReview,
  isLegacyDriverConfirmed,
};
