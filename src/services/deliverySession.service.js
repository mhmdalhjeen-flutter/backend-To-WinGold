const DeliverySession = require("../models/deliverySession");
const DeliveryCompany = require("../models/deliveryCompany");
const Order = require("../models/order");
const Store = require("../models/store");
const User = require("../models/user");
const { DELIVERY_METHODS } = require("../constants/marketplaceOrder.constants");
const {
  SESSION_STATUSES,
  SESSION_STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  getCustomerStatusLabel,
  getCompanyStatusLabel,
  NEW_COMPANY_REQUEST_STATUSES,
  ASSIGNABLE_COMPANY_STATUSES,
  ACCEPTED_COMPANY_STATUSES,
  ASSIGNED_COMPANY_STATUSES,
  OUT_FOR_DELIVERY_STATUSES,
  SENT_ORDER_STATUSES,
  DELIVERED_SESSION_STATUSES,
  REJECTED_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  CUSTOMER_ACTIVE_STATUSES,
  STORE_STOP_LABELS,
  COLLECTION_STATUS_LABELS,
  PAYMENT_STATUSES,
  normalizeSessionStatus,
  allStoresApproved,
  deriveInitialSubmittedStatus,
  allStopsCollected,
} = require("../constants/deliverySession.constants");
const deliveryPricingService = require("./deliveryPricing.service");
const deliveryNotificationService = require("./deliveryNotification.service");
const deliveryCompanyDriverService = require("./deliveryCompanyDriver.service");
const { requireObjectId, cleanString } = require("../utils/inputSecurity.util");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { safeLog } = require("../utils/logSanitize.util");

function pushTimeline(doc, status, note = "") {
  doc.statusTimeline = doc.statusTimeline || [];
  doc.statusTimeline.push({ status, at: new Date(), note });
}

/** Immutable timeline helper for Order documents */
function pushTimelineUpdate(timeline, status, note = "") {
  const list = Array.isArray(timeline) ? [...timeline] : [];
  list.push({ status, at: new Date(), note: note || "" });
  return list;
}

async function resolveCompany(companyId) {
  const id = String(companyId || "");
  let company = null;
  if (/^[a-f\d]{24}$/i.test(id)) {
    company = await DeliveryCompany.findOne({ _id: id, deletedAt: null, isActive: true });
  }
  if (!company) {
    company = await DeliveryCompany.findOne({ slug: id, deletedAt: null, isActive: true });
  }
  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة أو غير مفعّلة");
    err.status = 404;
    throw err;
  }
  return company;
}

async function fetchDeliveryOrders(customerId, orderIds) {
  const ids = orderIds.map((id) => requireObjectId(id, "orderIds"));
  const orders = await Order.find({
    _id: { $in: ids },
    customer: customerId,
    deliveryMethod: DELIVERY_METHODS.DELIVERY,
  }).lean();

  if (orders.length !== ids.length) {
    const err = new Error("بعض الطلبات غير صالحة للتوصيل — تأكد أن طريقة التسليم = Delivery");
    err.status = 400;
    throw err;
  }

  return orders;
}

async function buildStoreStops(orders) {
  const storeIds = [...new Set(orders.map((o) => String(o.store)))];
  const stores = await Store.find({ _id: { $in: storeIds } })
    .select("name phone whatsapp address owner")
    .lean();
  const storeById = Object.fromEntries(stores.map((s) => [String(s._id), s]));

  return orders.map((order) => {
    const store = storeById[String(order.store)] || {};
    return {
      order: order._id,
      store: order.store,
      storeOwnerId: store.owner || null,
      storeName: order.storeName || store.name || "",
      storePhone: store.phone || "",
      storeWhatsapp: store.whatsapp || "",
      storeAddress: store.address || "",
      orderNumber: order.orderNumber || String(order._id).slice(-6),
      verificationCode: order.verificationCode || "",
      orderStatus: order.status || "pending",
      collectionStatus: "pending",
      collectedAt: null,
    };
  });
}

function syncLegacyPaymentFields(doc) {
  if (doc.payment?.method) doc.paymentMethod = doc.payment.method;
  if (doc.payment?.status) doc.paymentStatus = doc.payment.status;
  if (doc.payment?.verified != null) {
    doc.paymentVerified = doc.payment.verified;
    doc.paymentVerifiedAt = doc.payment.verifiedAt || doc.paymentVerifiedAt;
  }
  if (doc.payment?.receiptImage) doc.paymentProof = doc.payment.receiptImage;
  if (doc.payment?.transferDetails) doc.transferInformation = doc.payment.transferDetails;
  if (doc.payment?.notes) doc.paymentNotes = doc.payment.notes;
}

function syncPaymentSubdocument(doc, body = {}) {
  doc.payment = doc.payment || {};
  if (body.paymentMethod) doc.payment.method = cleanString(body.paymentMethod, { field: "paymentMethod", max: 64 });
  if (body.paymentNotes != null) doc.payment.notes = cleanString(body.paymentNotes, { field: "paymentNotes", max: 1000 });
  if (body.transferInformation) {
    doc.payment.transferDetails = {
      senderName: cleanString(body.transferInformation.senderName, { field: "senderName", max: 120 }),
      contactNumber: cleanString(body.transferInformation.contactNumber, { field: "contactNumber", max: 32 }),
      referenceNumber: cleanString(body.transferInformation.referenceNumber, { field: "referenceNumber", max: 64 }),
      note: cleanString(body.transferInformation.note, { field: "note", max: 500 }),
    };
    doc.payment.senderName = doc.payment.transferDetails.senderName;
    doc.payment.senderPhone = doc.payment.transferDetails.contactNumber;
  }
  syncLegacyPaymentFields(doc);
}

function attachCompanyFields(summary, company) {
  if (!company) return summary;
  const plain = company.toObject ? company.toObject() : company;
  summary.companyName = plain.name || "";
  summary.companyPhone = plain.phone || "";
  summary.companyWhatsapp = plain.whatsapp || plain.phone || "";
  return summary;
}

function formatSessionSummary(session, company = null) {
  const plain = session.toObject ? session.toObject() : { ...session };
  const status = normalizeSessionStatus(plain.status);
  const storeCount = new Set((plain.storeStops || []).map((s) => String(s.store))).size;
  const assigned = plain.assignedDriver || null;
  const companyRef = company || plain.deliveryCompany;
  const orderNumbers = (plain.storeStops || []).map((s) => s.orderNumber).filter(Boolean);
  const orderNumber = orderNumbers.length === 1
    ? orderNumbers[0]
    : orderNumbers.length > 1
      ? orderNumbers.join(" · ")
      : `#${String(plain._id || "").slice(-6)}`;
  const timeline = plain.statusTimeline || [];
  const lastTimeline = timeline[timeline.length - 1];
  const lastUpdatedAt = lastTimeline?.at || plain.updatedAt || plain.createdAt;
  const rejectionReason = plain.rejectionReason
    || (status === SESSION_STATUSES.REJECTED ? lastTimeline?.note || "" : "");

  return attachCompanyFields({
    ...plain,
    status,
    statusLabel: getCompanyStatusLabel(status),
    customerStatusLabel: getCustomerStatusLabel(status),
    orderNumber,
    lastUpdatedAt,
    rejectionReason,
    internalNote: assigned?.note || "",
    storeCount,
    orderCount: plain.orders?.length || plain.storeStops?.length || 0,
    deliveryFee: plain.deliveryFee ?? plain.feeBreakdown?.totalFee ?? 0,
    paymentMethod: plain.payment?.method || plain.paymentMethod,
    paymentStatus: plain.payment?.status || plain.paymentStatus,
    paymentVerified: plain.payment?.verified ?? plain.paymentVerified,
    paymentProof: plain.payment?.receiptImage || plain.paymentProof,
    transferInformation: plain.payment?.transferDetails || plain.transferInformation,
    assignedDriver: assigned,
    driverName: assigned?.name || "",
    driverPhone: assigned?.phone || "",
    driverWhatsapp: assigned?.whatsapp || assigned?.phone || "",
    driverNote: assigned?.note || "",
  }, companyRef && companyRef.name ? companyRef : null);
}

function formatSessionDetails(session, company = null) {
  const summary = formatSessionSummary(session, company);
  summary.storeStops = (summary.storeStops || []).map((stop) => ({
    ...stop,
    orderStatusLabel: STORE_STOP_LABELS[stop.orderStatus] || stop.orderStatus,
    collectionStatusLabel: COLLECTION_STATUS_LABELS[stop.collectionStatus] || stop.collectionStatus,
  }));
  return summary;
}

async function refreshStoreStopsFromOrders(session) {
  const orderIds = (session.orders || []).map((o) => o._id || o);
  if (!orderIds.length) return session;

  const freshOrders = await Order.find({ _id: { $in: orderIds } })
    .select("status orderNumber verificationCode deliveryMethod deliveryGroup")
    .lean();
  const orderMap = Object.fromEntries(freshOrders.map((o) => [String(o._id), o]));

  session.storeStops = (session.storeStops || []).map((stop) => {
    const order = orderMap[String(stop.order)] || {};
    return {
      ...stop,
      orderStatus: order.status || stop.orderStatus,
      orderNumber: order.orderNumber || stop.orderNumber,
      verificationCode: order.verificationCode || stop.verificationCode,
    };
  });

  return session;
}

async function getActiveSessionForCustomer(customerId) {
  const session = await DeliverySession.findOne({
    customer: customerId,
    status: { $in: [...CUSTOMER_ACTIVE_STATUSES, "waiting_for_acceptance", "accepted", "on_the_way", "driver_assigned"] },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!session) return null;
  return formatSessionDetails(await refreshStoreStopsFromOrders(session));
}

async function getSessionForCustomer(customerId, sessionId) {
  const id = requireObjectId(sessionId, "sessionId");
  const session = await DeliverySession.findOne({ _id: id, customer: customerId }).lean();
  if (!session) {
    const err = new Error("جلسة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }
  return formatSessionDetails(await refreshStoreStopsFromOrders(session));
}

async function listSessionsForCustomer(customerId, { limit = 20 } = {}) {
  const sessions = await DeliverySession.find({ customer: customerId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return sessions.map(formatSessionSummary);
}

async function calculateSessionFee(companyId, orderCount) {
  return deliveryPricingService.calculateFee(companyId, orderCount);
}

/**
 * Confirm/submit a delivery session — idempotent by sessionId.
 * Only delivery-method orders are linked; pickup/nearby orders are rejected.
 * When sessionId already exists, new orders are merged into the same request.
 */
async function confirmSession(customerId, body = {}) {
  const sessionId = body.sessionId
    ? cleanString(body.sessionId, { field: "sessionId", max: 120 })
    : "";

  const company = await resolveCompany(body.companyId);
  const orders = await fetchDeliveryOrders(customerId, body.orderIds || []);
  const customer = await User.findById(customerId).select("name phone whatsapp address preferences").lean();
  const newStops = await buildStoreStops(orders);

  if (sessionId) {
    const existing = await DeliverySession.findOne({ customer: customerId, sessionId });
    if (existing) {
      if (TERMINAL_SESSION_STATUSES.has(normalizeSessionStatus(existing.status))) {
        const err = new Error("لا يمكن إضافة طلبات إلى جلسة توصيل منتهية");
        err.status = 400;
        throw err;
      }
      if (String(existing.deliveryCompany) !== String(company._id)) {
        const err = new Error("جلسة التوصيل مرتبطة بشركة أخرى");
        err.status = 400;
        throw err;
      }

      const existingOrderIds = new Set((existing.orders || []).map((o) => String(o._id || o)));
      const toAdd = orders.filter((o) => !existingOrderIds.has(String(o._id)));
      if (!toAdd.length) {
        return formatSessionDetails(existing, company);
      }

      const stopsToAdd = newStops.filter((s) => toAdd.some((o) => String(o._id) === String(s.order)));
      existing.orders = [...(existing.orders || []), ...toAdd.map((o) => o._id)];
      existing.storeStops = [...(existing.storeStops || []), ...stopsToAdd];

      const feeBreakdown = deliveryPricingService.calculateFeeFromCompany(company, existing.orders.length);
      existing.feeBreakdown = feeBreakdown;
      existing.deliveryFee = feeBreakdown.totalFee;
      existing.currency = feeBreakdown.currency;

      const previousStatus = normalizeSessionStatus(existing.status);
      if (
        previousStatus === SESSION_STATUSES.READY_FOR_PICKUP
        && !allStoresApproved(existing.storeStops)
      ) {
        existing.status = SESSION_STATUSES.WAITING_FOR_STORES;
        pushTimeline(existing, SESSION_STATUSES.WAITING_FOR_STORES, "أُضيفت طلبات جديدة بانتظار موافقة المتجر");
      } else if (
        previousStatus === SESSION_STATUSES.WAITING_FOR_STORES
        && allStoresApproved(existing.storeStops)
      ) {
        existing.status = SESSION_STATUSES.READY_FOR_PICKUP;
        pushTimeline(existing, SESSION_STATUSES.READY_FOR_PICKUP, "جميع المتاجر وافقت على الطلبات");
      } else {
        pushTimeline(existing, existing.status, `أُضيف ${toAdd.length} طلب(ات) إلى رحلة التوصيل`);
      }

      existing.markModified("storeStops");
      existing.markModified("orders");
      existing.markModified("feeBreakdown");
      await existing.save();

      await Order.updateMany(
        { _id: { $in: toAdd.map((o) => o._id) } },
        { $set: { deliveryGroup: existing._id } },
      );

      const formatted = formatSessionDetails(existing, company);
      setImmediate(() => {
        for (const stop of stopsToAdd) {
          if (!stop.storeOwnerId) continue;
          deliveryNotificationService.onStoreOrderUpdated(formatted, {
            ...stop,
            orderStatusLabel: STORE_STOP_LABELS[stop.orderStatus] || stop.orderStatus,
          }).catch(() => {});
        }
        if (normalizeSessionStatus(existing.status) !== previousStatus) {
          deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
        }
      });
      return formatted;
    }
  }

  const feeBreakdown = deliveryPricingService.calculateFeeFromCompany(company, orders.length);
  const clientFee = Number(body.deliveryFee);
  if (Number.isFinite(clientFee) && clientFee > 0 && Math.abs(clientFee - feeBreakdown.totalFee) > 0.01) {
    safeLog("warn", "delivery_fee_mismatch", {
      customerId: String(customerId),
      clientFee,
      serverFee: feeBreakdown.totalFee,
    });
  }

  const receiptImage = body.paymentProof
    ? await processOptionalImage(body.paymentProof, { maxWidth: 1200, enforceCloudinaryHttps: true })
    : "";

  const paymentMethod = cleanString(body.paymentMethod, { field: "paymentMethod", max: 64 });
  const isCash = paymentMethod === "cash_on_delivery";
  const paymentStatus = isCash ? PAYMENT_STATUSES.PENDING : (receiptImage ? PAYMENT_STATUSES.PAID : PAYMENT_STATUSES.PENDING);

  const initialStatus = deriveInitialSubmittedStatus(newStops);

  const doc = await DeliverySession.create({
    sessionId,
    customer: customerId,
    deliveryCompany: company._id,
    orders: orders.map((o) => o._id),
    storeStops: newStops,
    status: initialStatus,
    statusTimeline: [{ status: initialStatus, at: new Date(), note: "تم تأكيد طلب التوصيل" }],
    deliveryAddress: orders[0]?.deliveryAddress || customer?.address || "",
    deliveryArea: cleanString(body.deliveryArea, { field: "deliveryArea", max: 500 }),
    regionId: customer?.preferences?.regionId || null,
    customerName: customer?.name || orders[0]?.customerName || "",
    customerPhone: customer?.phone || orders[0]?.customerPhone || "",
    customerWhatsapp: customer?.whatsapp || "",
    deliveryFee: feeBreakdown.totalFee,
    feeBreakdown,
    currency: feeBreakdown.currency,
    payment: {
      method: paymentMethod,
      status: paymentStatus,
      receiptImage,
      senderName: cleanString(body.transferInformation?.senderName, { field: "senderName", max: 120 }),
      senderPhone: cleanString(body.transferInformation?.contactNumber, { field: "contactNumber", max: 32 }),
      transferDetails: {
        senderName: cleanString(body.transferInformation?.senderName, { field: "senderName", max: 120 }),
        contactNumber: cleanString(body.transferInformation?.contactNumber, { field: "contactNumber", max: 32 }),
        referenceNumber: cleanString(body.transferInformation?.referenceNumber, { field: "referenceNumber", max: 64 }),
        note: cleanString(body.transferInformation?.note, { field: "note", max: 500 }),
      },
      notes: cleanString(body.paymentNotes, { field: "paymentNotes", max: 1000 }),
      verified: false,
    },
    paymentMethod,
    paymentStatus,
    paymentProof: receiptImage,
    paymentNotes: cleanString(body.paymentNotes, { field: "paymentNotes", max: 1000 }),
    transferInformation: {
      senderName: cleanString(body.transferInformation?.senderName, { field: "senderName", max: 120 }),
      contactNumber: cleanString(body.transferInformation?.contactNumber, { field: "contactNumber", max: 32 }),
      referenceNumber: cleanString(body.transferInformation?.referenceNumber, { field: "referenceNumber", max: 64 }),
      note: cleanString(body.transferInformation?.note, { field: "note", max: 500 }),
    },
    submittedAt: new Date(),
  });

  await Order.updateMany(
    { _id: { $in: orders.map((o) => o._id) } },
    { $set: { deliveryGroup: doc._id } },
  );

  const formatted = formatSessionDetails(doc, company);
  setImmediate(() => {
    deliveryNotificationService.onSessionCreated(formatted).catch(() => {});
    if (initialStatus === SESSION_STATUSES.READY_FOR_PICKUP) {
      deliveryNotificationService.onReadyForPickup(formatted).catch(() => {});
    }
  });

  return formatted;
}

/** Sync session after store hands order to driver */
async function syncAfterStoreHandover(orderId) {
  const oid = requireObjectId(orderId, "orderId");
  const order = await Order.findById(oid).select("status deliveryMethod deliveryGroup store").lean();
  if (!order || order.deliveryMethod !== DELIVERY_METHODS.DELIVERY || !order.deliveryGroup) return;

  const doc = await DeliverySession.findById(order.deliveryGroup);
  if (!doc) return;

  const previousStatus = normalizeSessionStatus(doc.status);
  if (TERMINAL_SESSION_STATUSES.has(previousStatus)) return;

  doc.storeStops = (doc.storeStops || []).map((stop) => {
    if (String(stop.order) !== String(oid)) return stop;
    return {
      ...stop,
      orderStatus: order.status,
      collectionStatus: "collected",
      collectedAt: stop.collectedAt || new Date(),
    };
  });

  if (allStopsCollected(doc.storeStops) && previousStatus === SESSION_STATUSES.DRIVER_ASSIGNED) {
    doc.status = SESSION_STATUSES.OUT_FOR_DELIVERY;
    pushTimeline(doc, SESSION_STATUSES.OUT_FOR_DELIVERY, "استلم السائق الطلب من المتجر");
  }

  doc.markModified("storeStops");
  await doc.save();

  const company = await DeliveryCompany.findById(doc.deliveryCompany).select("name phone whatsapp").lean();
  const formatted = formatSessionDetails(doc, company);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
  });
  return formatted;
}

/** Sync order status into delivery sessions after store updates */
async function syncOrderInSessions(orderId) {
  const oid = requireObjectId(orderId, "orderId");
  const order = await Order.findById(oid).select("status deliveryMethod deliveryGroup").lean();
  if (!order || order.deliveryMethod !== DELIVERY_METHODS.DELIVERY || !order.deliveryGroup) return;

  const doc = await DeliverySession.findById(order.deliveryGroup);
  if (!doc) return;

  const previousStatus = normalizeSessionStatus(doc.status);
  if (TERMINAL_SESSION_STATUSES.has(previousStatus)) return;

  let changed = false;
  const REJECTED_ORDER_STATUSES = new Set(["rejected", "cancelled"]);

  doc.storeStops = (doc.storeStops || []).map((stop) => {
    if (String(stop.order) !== String(oid)) return stop;
    if (stop.orderStatus === order.status) return stop;
    changed = true;
    return { ...stop, orderStatus: order.status };
  });

  if (!changed) return;

  const hasRejectedStop = (doc.storeStops || []).some((stop) =>
    REJECTED_ORDER_STATUSES.has(stop.orderStatus)
  );

  if (hasRejectedStop) {
    doc.status = SESSION_STATUSES.CANCELLED;
    pushTimeline(doc, SESSION_STATUSES.CANCELLED, "رفض أحد المتاجر الطلب — تم إلغاء طلب التوصيل");
    doc.markModified("storeStops");
    await doc.save();

    await Order.updateMany(
      { _id: { $in: doc.orders || [] }, deliveryGroup: doc._id },
      { $unset: { deliveryGroup: 1 } },
    );

    const company = await DeliveryCompany.findById(doc.deliveryCompany).select("name phone whatsapp").lean();
    const formatted = formatSessionDetails(doc, company);
    setImmediate(() => {
      deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
    });
    return;
  }

  if (
    previousStatus === SESSION_STATUSES.WAITING_FOR_STORES &&
    allStoresApproved(doc.storeStops)
  ) {
    doc.status = SESSION_STATUSES.READY_FOR_PICKUP;
    pushTimeline(doc, SESSION_STATUSES.READY_FOR_PICKUP, "جميع المتاجر وافقت على الطلبات");
  }

  doc.markModified("storeStops");
  await doc.save();

  const company = await DeliveryCompany.findById(doc.deliveryCompany).select("name phone whatsapp").lean();
  const formatted = formatSessionDetails(doc, company);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
  });
}

async function assertCompanyUser(user) {
  if (!user?.deliveryCompanyId) {
    const err = new Error("حساب الشركة غير مربوط بشركة توصيل");
    err.status = 403;
    throw err;
  }
  return user.deliveryCompanyId;
}

async function getDashboardStats(user) {
  const companyId = await assertCompanyUser(user);
  const baseQuery = { deliveryCompany: companyId };

  const newStatuses = [...NEW_COMPANY_REQUEST_STATUSES];
  const sentStatuses = [...SENT_ORDER_STATUSES];
  const deliveredStatuses = [...DELIVERED_SESSION_STATUSES];
  const rejectedStatuses = [...REJECTED_SESSION_STATUSES];

  const [pendingConfirmation, assignedToDriver, sentOrders, delivered, rejected] = await Promise.all([
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: newStatuses } }),
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: [...ASSIGNED_COMPANY_STATUSES] } }),
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: sentStatuses } }),
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: deliveredStatuses } }),
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: rejectedStatuses } }),
  ]);

  return {
    pendingConfirmation,
    assignedToDriver,
    sentOrders,
    delivered,
    rejected,
    // legacy aliases for older clients
    newRequests: pendingConfirmation,
    outForDelivery: sentOrders,
  };
}

async function listSessionsForCompany(user, { status, history = false } = {}) {
  const companyId = await assertCompanyUser(user);
  const query = { deliveryCompany: companyId };

  if (history) {
    query.status = {
      $in: [...TERMINAL_SESSION_STATUSES],
    };
  } else if (status === "new") {
    query.status = { $in: [...NEW_COMPANY_REQUEST_STATUSES] };
  } else if (status === "assigned") {
    query.status = { $in: [...ASSIGNED_COMPANY_STATUSES] };
  } else if (status === "sent" || status === "out_for_delivery") {
    query.status = { $in: [...SENT_ORDER_STATUSES] };
  } else if (status === "accepted") {
    query.status = { $in: [...ACCEPTED_COMPANY_STATUSES] };
  } else if (status === "delivered") {
    query.status = { $in: [...DELIVERED_SESSION_STATUSES] };
  } else if (status === "rejected") {
    query.status = { $in: [...REJECTED_SESSION_STATUSES] };
  } else if (status) {
    query.status = status;
  } else {
    // Default company inbox: include waiting-for-store through active delivery
    query.status = {
      $in: [
        SESSION_STATUSES.WAITING_FOR_STORES,
        SESSION_STATUSES.READY_FOR_PICKUP,
        SESSION_STATUSES.DRIVER_ASSIGNED,
        SESSION_STATUSES.ACCEPTED,
        SESSION_STATUSES.OUT_FOR_DELIVERY,
        "waiting_for_acceptance",
        "collecting_orders",
        "on_delivery",
        "on_the_way",
      ],
    };
  }

  const sessions = await DeliverySession.find(query).sort({ createdAt: -1 }).limit(history ? 100 : 50).lean();
  return sessions.map(formatSessionSummary);
}

async function getSessionForCompany(user, sessionId) {
  const companyId = await assertCompanyUser(user);
  const id = requireObjectId(sessionId, "sessionId");
  const session = await DeliverySession.findOne({ _id: id, deliveryCompany: companyId }).lean();
  if (!session) {
    const err = new Error("طلب التوصيل غير موجود");
    err.status = 404;
    throw err;
  }
  const company = await DeliveryCompany.findById(companyId).select("name phone whatsapp").lean();
  return formatSessionDetails(await refreshStoreStopsFromOrders(session), company);
}

async function syncOrdersOnDriverAssigned(sessionDoc) {
  const orderIds = (sessionDoc.orders || []).map((o) => o._id || o);
  if (!orderIds.length) return;

  const orders = await Order.find({
    _id: { $in: orderIds },
    status: "ready_for_delivery_pickup",
  }).select("_id statusTimeline");

  for (const order of orders) {
    await Order.findOneAndUpdate(
      { _id: order._id, status: "ready_for_delivery_pickup" },
      {
        $set: {
          status: "ready_for_driver_pickup",
          statusTimeline: pushTimelineUpdate(order.statusTimeline, "ready_for_driver_pickup"),
        },
      }
    );
  }
}

async function assignDriverToSession(user, sessionId, { driverId, note = "" } = {}) {
  const preview = await getSessionForCompany(user, sessionId);
  const normalized = normalizeSessionStatus(preview.status);
  const assignable = new Set([
    ...ASSIGNABLE_COMPANY_STATUSES,
    ...ASSIGNED_COMPANY_STATUSES,
  ]);
  if (!assignable.has(normalized) && !assignable.has(preview.status)) {
    const err = new Error(
      normalized === SESSION_STATUSES.WAITING_FOR_STORES
        ? "انتظر موافقة المتجر قبل تعيين سائق"
        : "لا يمكن تعيين سائق لهذا الطلب"
    );
    err.status = 400;
    throw err;
  }

  const driver = await deliveryCompanyDriverService.assertDriverForCompany(user, driverId, { requireActive: true });
  const assignmentNote = cleanString(note, { field: "note", max: 500 });

  const doc = await DeliverySession.findById(preview._id);
  const previousStatus = normalizeSessionStatus(doc.status);
  doc.driver = null;
  doc.assignedDriver = {
    driverId: driver._id,
    name: driver.name,
    phone: driver.phone,
    whatsapp: driver.whatsapp || driver.phone,
    note: assignmentNote,
    assignedAt: new Date(),
  };
  doc.status = SESSION_STATUSES.DRIVER_ASSIGNED;
  const timelineNote = assignmentNote
    ? `تعيين السائق ${driver.name} — ${assignmentNote}`
    : `تعيين السائق ${driver.name}`;
  pushTimeline(doc, SESSION_STATUSES.DRIVER_ASSIGNED, timelineNote);
  await doc.save();

  await syncOrdersOnDriverAssigned(doc);

  const company = await DeliveryCompany.findById(doc.deliveryCompany).select("name phone whatsapp").lean();
  const formatted = formatSessionDetails(doc, company);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted, {
      driverName: driver.name,
      driverPhone: driver.phone,
      driverWhatsapp: driver.whatsapp || driver.phone,
      driverId: driver._id,
    }).catch(() => {});
  });
  return formatted;
}

async function rejectSession(user, sessionId, reason = "") {
  const preview = await getSessionForCompany(user, sessionId);
  const normalized = normalizeSessionStatus(preview.status);
  const rejectable = new Set([
    ...NEW_COMPANY_REQUEST_STATUSES,
    SESSION_STATUSES.WAITING_FOR_STORES,
    SESSION_STATUSES.READY_FOR_PICKUP,
  ]);
  if (!rejectable.has(normalized) && !rejectable.has(preview.status)) {
    const err = new Error("لا يمكن رفض هذا الطلب في حالته الحالية");
    err.status = 400;
    throw err;
  }

  const doc = await DeliverySession.findById(preview._id);
  const previousStatus = normalizeSessionStatus(doc.status);
  const note = cleanString(reason, { field: "reason", max: 500 }) || "رفضت شركة التوصيل الطلب";
  doc.status = SESSION_STATUSES.REJECTED;
  doc.rejectionReason = note;
  pushTimeline(doc, SESSION_STATUSES.REJECTED, note);
  await doc.save();

  await Order.updateMany(
    { _id: { $in: doc.orders || [] }, deliveryGroup: doc._id },
    { $unset: { deliveryGroup: 1 } },
  );

  const company = await DeliveryCompany.findById(doc.deliveryCompany).select("name phone whatsapp").lean();
  const formatted = formatSessionDetails(doc, company);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted, { rejectReason: note }).catch(() => {});
  });
  return formatted;
}

async function markOutForDelivery(user, sessionId) {
  const doc = await DeliverySession.findById(requireObjectId(sessionId, "sessionId"));
  await assertCompanyUser(user);
  if (!doc || String(doc.deliveryCompany) !== String(user.deliveryCompanyId)) {
    const err = new Error("طلب التوصيل غير موجود");
    err.status = 404;
    throw err;
  }

  const current = normalizeSessionStatus(doc.status);
  const allowed = new Set([
    ...ACCEPTED_COMPANY_STATUSES,
    ...ASSIGNED_COMPANY_STATUSES,
    SESSION_STATUSES.ACCEPTED,
    SESSION_STATUSES.DRIVER_ASSIGNED,
  ]);
  if (!allowed.has(current) && !allowed.has(doc.status)) {
    const err = new Error("يجب تعيين سائق قبل تحديد الطلب كقيد التوصيل");
    err.status = 400;
    throw err;
  }

  const previousStatus = current;
  doc.status = SESSION_STATUSES.OUT_FOR_DELIVERY;
  pushTimeline(doc, SESSION_STATUSES.OUT_FOR_DELIVERY, "الطلب قيد التوصيل");
  await doc.save();

  const company = await DeliveryCompany.findById(doc.deliveryCompany).select("name phone whatsapp").lean();
  const formatted = formatSessionDetails(doc, company);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
  });
  return formatted;
}

async function completeSession(user, sessionId) {
  const doc = await DeliverySession.findById(requireObjectId(sessionId, "sessionId"));
  await assertCompanyUser(user);
  if (!doc || String(doc.deliveryCompany) !== String(user.deliveryCompanyId)) {
    const err = new Error("طلب التوصيل غير موجود");
    err.status = 404;
    throw err;
  }

  const current = normalizeSessionStatus(doc.status);
  const allowed = new Set([...OUT_FOR_DELIVERY_STATUSES, SESSION_STATUSES.OUT_FOR_DELIVERY]);
  if (!allowed.has(current) && !allowed.has(doc.status)) {
    const err = new Error("يجب أن يكون الطلب قيد التوصيل قبل تأكيد التسليم");
    err.status = 400;
    throw err;
  }

  const previousStatus = current;
  doc.status = SESSION_STATUSES.COMPLETED;
  pushTimeline(doc, SESSION_STATUSES.COMPLETED, "تم تسليم الطلبات للزبون");
  await doc.save();

  const now = new Date();
  const deleteAfter = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const orderIds = (doc.orders || []).map((o) => o._id || o);
  if (orderIds.length) {
    await Order.updateMany(
      {
        _id: { $in: orderIds },
        status: {
          $in: [
            "delivery_handover_complete",
            "delivered_to_driver",
            "ready_for_driver_pickup",
            "ready_for_delivery_pickup",
            "preparing",
            "store_accepted",
          ],
        },
      },
      {
        $set: {
          status: "delivered_to_customer",
          completedAt: now,
          deleteAfter,
        },
      },
    );
  }

  const company = await DeliveryCompany.findById(doc.deliveryCompany).select("name phone whatsapp").lean();
  const formatted = formatSessionDetails(doc, company);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
  });
  return formatted;
}

async function cancelSession(customerId, sessionId, reason = "") {
  const id = requireObjectId(sessionId, "sessionId");
  const doc = await DeliverySession.findOne({ _id: id, customer: customerId });
  if (!doc) {
    const err = new Error("جلسة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  const current = normalizeSessionStatus(doc.status);
  const cancellable = new Set([
    SESSION_STATUSES.WAITING,
    SESSION_STATUSES.WAITING_FOR_STORES,
    SESSION_STATUSES.READY_FOR_PICKUP,
    SESSION_STATUSES.DRIVER_ASSIGNED,
  ]);
  if (!cancellable.has(current)) {
    const err = new Error("لا يمكن إلغاء هذه الجلسة في حالتها الحالية");
    err.status = 400;
    throw err;
  }

  doc.status = SESSION_STATUSES.CANCELLED;
  pushTimeline(doc, SESSION_STATUSES.CANCELLED, cleanString(reason, { field: "reason", max: 500 }) || "ألغى الزبون الطلب");
  await doc.save();

  await Order.updateMany(
    { _id: { $in: doc.orders || [] }, deliveryGroup: doc._id },
    { $unset: { deliveryGroup: 1 } },
  );

  return formatSessionDetails(doc);
}

module.exports = {
  confirmSession,
  getActiveSessionForCustomer,
  getSessionForCustomer,
  listSessionsForCustomer,
  calculateSessionFee,
  syncOrderInSessions,
  syncAfterStoreHandover,
  cancelSession,
  refreshStoreStopsFromOrders,
  getDashboardStats,
  listSessionsForCompany,
  getSessionForCompany,
  assignDriverToSession,
  rejectSession,
  markOutForDelivery,
  completeSession,
  formatSessionSummary,
  formatSessionDetails,
  buildStoreStops,
  fetchDeliveryOrders,
  deriveInitialSubmittedStatus,
  allStoresApproved,
};
