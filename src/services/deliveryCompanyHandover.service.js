const DeliveryCompanyOrderHandover = require("../models/deliveryCompanyOrderHandover");
const DeliveryCompany = require("../models/deliveryCompany");
const DeliverySession = require("../models/deliverySession");
const Order = require("../models/order");
const { safeLog } = require("../utils/logSanitize.util");

const HANDOVER_STATUS = "delivery_handover_complete";
const REQUIRED_PREVIOUS_STATUS = "ready_for_driver_pickup";

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

  const fullOrder = await Order.findById(orderId).select("statusTimeline").lean();
  const handoverAt = findHandoverTimestamp(fullOrder?.statusTimeline) || new Date();

  try {
    await DeliveryCompanyOrderHandover.create({
      order: orderId,
      deliveryCompany: companyId,
      store: storeId || undefined,
      confirmedBy: confirmedBy || undefined,
      handoverAt,
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
    await deliveryCompanyBillingService.incrementHandoverCount(companyId, handoverAt);
  } catch (billingErr) {
    safeLog("warn", "delivery_billing_increment_failed", {
      message: billingErr.message,
      companyId: String(companyId),
      orderId: String(orderId),
    });
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

module.exports = {
  HANDOVER_STATUS,
  REQUIRED_PREVIOUS_STATUS,
  recordStoreHandoverToDeliveryCompany,
  countHandoversForCompany,
  rebuildCompanyHandoverCount,
  findHandoverTimestamp,
};
