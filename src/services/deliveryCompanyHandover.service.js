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

  const existing = await DeliveryCompanyOrderHandover.findOne({ order: orderId })
    .select("_id deliveryCompany")
    .lean();
  if (existing) {
    return {
      recorded: false,
      reason: "already_recorded",
      companyId: existing.deliveryCompany,
    };
  }

  const fullOrder = await Order.findById(orderId).select("statusTimeline deliveryGroup").lean();
  const handoverAt = findHandoverTimestamp(fullOrder?.statusTimeline) || new Date();

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
    });
  } catch (err) {
    if (err?.code === 11000) {
      return { recorded: false, reason: "duplicate", companyId };
    }
    throw err;
  }

  await DeliveryCompany.updateOne(
    { _id: companyId },
    { $inc: { handedOverOrderCount: 1 } },
  );

  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        deliveryCompanyHandoverAt: handoverAt,
        deliveryCompanyHandoverCompany: companyId,
      },
    },
  );

  try {
    const deliveryCompanyBillingService = require("./deliveryCompanyBilling.service");
    const billingResult = await deliveryCompanyBillingService.incrementHandoverCount(companyId, handoverAt);
    if (!billingResult?.incremented) {
      const reason = billingResult?.reason || "unknown";
      const logLevel = reason === "period_closed" || reason === "billing_frozen" ? "info" : "warn";
      safeLog(logLevel, "delivery_billing_increment_not_applied", {
        companyId: String(companyId),
        orderId: String(orderId),
        reason,
        monthKey: billingResult?.monthKey,
      });
    }
  } catch (billingErr) {
    safeLog("error", "delivery_billing_increment_failed", {
      message: billingErr.message,
      companyId: String(companyId),
      orderId: String(orderId),
      status: billingErr.status || 500,
    });
    throw billingErr;
  }

  return { recorded: true, companyId, handoverAt };
}

async function countHandoversForCompany(companyId) {
  if (!companyId) return 0;
  return DeliveryCompanyOrderHandover.countDocuments({
    deliveryCompany: companyId,
  });
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
