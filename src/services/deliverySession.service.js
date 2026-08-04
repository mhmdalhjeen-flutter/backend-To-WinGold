const DeliverySession = require("../models/deliverySession");
const DeliveryCompany = require("../models/deliveryCompany");
const Order = require("../models/order");
const Store = require("../models/store");
const User = require("../models/user");
const { DELIVERY_METHODS } = require("../constants/marketplaceOrder.constants");
const {
  SESSION_STATUSES,
  SESSION_STATUS_LABELS,
  NEW_DRIVER_REQUEST_STATUSES,
  ACTIVE_DRIVER_STATUSES,
  COMPLETED_SESSION_STATUSES,
  CUSTOMER_ACTIVE_STATUSES,
  STORE_STOP_LABELS,
  COLLECTION_STATUS_LABELS,
  PAYMENT_STATUSES,
  normalizeSessionStatus,
  allStoresApproved,
  deriveInitialSubmittedStatus,
} = require("../constants/deliverySession.constants");
const deliveryPricingService = require("./deliveryPricing.service");
const deliveryNotificationService = require("./deliveryNotification.service");
const { requireObjectId, cleanString } = require("../utils/inputSecurity.util");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { safeLog } = require("../utils/logSanitize.util");

function pushTimeline(doc, status, note = "") {
  doc.statusTimeline = doc.statusTimeline || [];
  doc.statusTimeline.push({ status, at: new Date(), note });
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

function formatSessionSummary(session) {
  const plain = session.toObject ? session.toObject() : { ...session };
  const status = normalizeSessionStatus(plain.status);
  const storeCount = new Set((plain.storeStops || []).map((s) => String(s.store))).size;

  return {
    ...plain,
    status,
    statusLabel: SESSION_STATUS_LABELS[status] || status,
    storeCount,
    orderCount: plain.orders?.length || plain.storeStops?.length || 0,
    deliveryFee: plain.deliveryFee ?? plain.feeBreakdown?.totalFee ?? 0,
    paymentMethod: plain.payment?.method || plain.paymentMethod,
    paymentStatus: plain.payment?.status || plain.paymentStatus,
    paymentVerified: plain.payment?.verified ?? plain.paymentVerified,
    paymentProof: plain.payment?.receiptImage || plain.paymentProof,
    transferInformation: plain.payment?.transferDetails || plain.transferInformation,
  };
}

function formatSessionDetails(session) {
  const summary = formatSessionSummary(session);
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
    status: { $in: [...CUSTOMER_ACTIVE_STATUSES, "waiting_for_acceptance", "accepted", "on_the_way"] },
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
 */
async function confirmSession(customerId, body = {}) {
  const sessionId = body.sessionId
    ? cleanString(body.sessionId, { field: "sessionId", max: 120 })
    : "";

  if (sessionId) {
    const existing = await DeliverySession.findOne({ customer: customerId, sessionId });
    if (existing) return formatSessionDetails(existing);
  }

  const company = await resolveCompany(body.companyId);
  const orders = await fetchDeliveryOrders(customerId, body.orderIds || []);
  const customer = await User.findById(customerId).select("name phone whatsapp address preferences").lean();
  const storeStops = await buildStoreStops(orders);

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

  const initialStatus = deriveInitialSubmittedStatus(storeStops);

  const doc = await DeliverySession.create({
    sessionId,
    customer: customerId,
    deliveryCompany: company._id,
    orders: orders.map((o) => o._id),
    storeStops,
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

  const formatted = formatSessionDetails(doc);
  setImmediate(() => {
    deliveryNotificationService.onSessionCreated(formatted).catch(() => {});
    if (initialStatus === SESSION_STATUSES.READY_FOR_PICKUP) {
      deliveryNotificationService.onReadyForPickup(formatted).catch(() => {});
    }
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
  let changed = false;

  doc.storeStops = (doc.storeStops || []).map((stop) => {
    if (String(stop.order) !== String(oid)) return stop;
    if (stop.orderStatus === order.status) return stop;
    changed = true;
    return { ...stop, orderStatus: order.status };
  });

  if (!changed) return;

  if (
    previousStatus === SESSION_STATUSES.WAITING_FOR_STORES &&
    allStoresApproved(doc.storeStops)
  ) {
    doc.status = SESSION_STATUSES.READY_FOR_PICKUP;
    pushTimeline(doc, SESSION_STATUSES.READY_FOR_PICKUP, "جميع المتاجر وافقت على الطلبات");
  }

  doc.markModified("storeStops");
  await doc.save();

  const formatted = formatSessionDetails(doc);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
  });
}

async function assertDriverCompany(driver) {
  if (!driver?.deliveryCompanyId) {
    const err = new Error("حساب السائق غير مربوط بشركة توصيل");
    err.status = 403;
    throw err;
  }
  return driver.deliveryCompanyId;
}

async function getDashboardStats(driver) {
  const companyId = await assertDriverCompany(driver);
  const baseQuery = { deliveryCompany: companyId };

  const readyStatuses = [...NEW_DRIVER_REQUEST_STATUSES, "waiting_for_acceptance"];
  const activeStatuses = [...ACTIVE_DRIVER_STATUSES, "accepted", "collecting_orders", "on_the_way"];
  const completedStatuses = [SESSION_STATUSES.COMPLETED, "delivered"];

  const [newTrips, activeTrips, completedTrips, activeTripDocs] = await Promise.all([
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: readyStatuses } }),
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: activeStatuses } }),
    DeliverySession.countDocuments({ ...baseQuery, status: { $in: completedStatuses } }),
    DeliverySession.find({ ...baseQuery, status: { $in: activeStatuses } }).select("storeStops").lean(),
  ]);

  let pendingOrders = 0;
  activeTripDocs.forEach((trip) => {
    (trip.storeStops || []).forEach((stop) => {
      if (stop.collectionStatus === "pending") pendingOrders += 1;
    });
  });

  return { newTrips, activeTrips, completedTrips, pendingOrders };
}

async function listSessionsForDriver(driver, { status, history = false } = {}) {
  const companyId = await assertDriverCompany(driver);
  const query = { deliveryCompany: companyId };

  if (history) {
    query.status = { $in: [...COMPLETED_SESSION_STATUSES, SESSION_STATUSES.CANCELLED, "delivered", "cancelled"] };
  } else if (status) {
    query.status = status;
  } else {
    query.status = {
      $nin: [...COMPLETED_SESSION_STATUSES, SESSION_STATUSES.CANCELLED, "delivered", "cancelled", SESSION_STATUSES.WAITING, SESSION_STATUSES.WAITING_FOR_STORES],
    };
  }

  const sessions = await DeliverySession.find(query).sort({ createdAt: -1 }).limit(history ? 100 : 50).lean();
  return sessions.map(formatSessionSummary);
}

async function getSessionForDriver(driver, sessionId) {
  const companyId = await assertDriverCompany(driver);
  const id = requireObjectId(sessionId, "sessionId");
  const session = await DeliverySession.findOne({ _id: id, deliveryCompany: companyId }).lean();
  if (!session) {
    const err = new Error("رحلة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }
  return formatSessionDetails(await refreshStoreStopsFromOrders(session));
}

async function acceptSession(driver, sessionId) {
  const preview = await getSessionForDriver(driver, sessionId);
  const normalized = normalizeSessionStatus(preview.status);
  const acceptable = new Set([SESSION_STATUSES.READY_FOR_PICKUP, "waiting_for_acceptance"]);
  if (!acceptable.has(normalized) && !acceptable.has(preview.status)) {
    const err = new Error("لا يمكن قبول هذه الرحلة");
    err.status = 400;
    throw err;
  }

  const doc = await DeliverySession.findById(preview._id);
  const previousStatus = normalizeSessionStatus(doc.status);
  doc.driver = driver._id || driver.id;
  doc.status = SESSION_STATUSES.DRIVER_ASSIGNED;
  pushTimeline(doc, SESSION_STATUSES.DRIVER_ASSIGNED, "قبل السائق الرحلة");
  await doc.save();

  const formatted = formatSessionDetails(doc);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted, {
      driverName: driver.name || "",
    }).catch(() => {});
  });
  return formatted;
}

async function collectStoreStop(driver, sessionId, orderId) {
  const doc = await DeliverySession.findById(requireObjectId(sessionId, "sessionId"));
  await assertDriverCompany(driver);
  if (!doc || String(doc.deliveryCompany) !== String(driver.deliveryCompanyId)) {
    const err = new Error("رحلة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  const allowed = new Set([
    SESSION_STATUSES.DRIVER_ASSIGNED,
    SESSION_STATUSES.COLLECTING_ORDERS,
    "accepted",
  ]);
  if (!allowed.has(normalizeSessionStatus(doc.status)) && !allowed.has(doc.status)) {
    const err = new Error("لا يمكن استلام الطلبات في هذه المرحلة");
    err.status = 400;
    throw err;
  }

  const oid = String(requireObjectId(orderId, "orderId"));
  const stop = (doc.storeStops || []).find((s) => String(s.order) === oid);
  if (!stop) {
    const err = new Error("الطلب غير موجود في الرحلة");
    err.status = 404;
    throw err;
  }
  if (stop.collectionStatus === "collected") return formatSessionDetails(doc);

  const previousStatus = normalizeSessionStatus(doc.status);
  stop.collectionStatus = "collected";
  stop.collectedAt = new Date();
  doc.status = SESSION_STATUSES.COLLECTING_ORDERS;
  pushTimeline(doc, SESSION_STATUSES.COLLECTING_ORDERS, `تم استلام طلب من ${stop.storeName || "متجر"}`);
  doc.markModified("storeStops");
  await doc.save();

  const formatted = formatSessionDetails(doc);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
  });
  return formatted;
}

async function verifySessionPayment(driver, sessionId) {
  const doc = await DeliverySession.findById(requireObjectId(sessionId, "sessionId"));
  await assertDriverCompany(driver);
  if (!doc || String(doc.deliveryCompany) !== String(driver.deliveryCompanyId)) {
    const err = new Error("رحلة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  doc.payment = doc.payment || {};
  doc.payment.verified = true;
  doc.payment.verifiedAt = new Date();
  doc.payment.status = PAYMENT_STATUSES.VERIFIED;
  doc.paymentVerified = true;
  doc.paymentVerifiedAt = doc.payment.verifiedAt;
  doc.paymentStatus = PAYMENT_STATUSES.VERIFIED;
  await doc.save();
  return formatSessionDetails(doc);
}

async function startDelivery(driver, sessionId) {
  const doc = await DeliverySession.findById(requireObjectId(sessionId, "sessionId"));
  await assertDriverCompany(driver);
  if (!doc || String(doc.deliveryCompany) !== String(driver.deliveryCompanyId)) {
    const err = new Error("رحلة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  const allCollected = (doc.storeStops || []).every((s) => s.collectionStatus === "collected");
  if (!allCollected) {
    const err = new Error("يجب استلام جميع الطلبات من المتاجر أولاً");
    err.status = 400;
    throw err;
  }

  const previousStatus = normalizeSessionStatus(doc.status);
  doc.status = SESSION_STATUSES.ON_DELIVERY;
  pushTimeline(doc, SESSION_STATUSES.ON_DELIVERY, "بدء التوصيل للزبون");
  await doc.save();

  const formatted = formatSessionDetails(doc);
  setImmediate(() => {
    deliveryNotificationService.dispatchStatusChange(previousStatus, formatted).catch(() => {});
  });
  return formatted;
}

async function completeSession(driver, sessionId) {
  const doc = await DeliverySession.findById(requireObjectId(sessionId, "sessionId"));
  await assertDriverCompany(driver);
  if (!doc || String(doc.deliveryCompany) !== String(driver.deliveryCompanyId)) {
    const err = new Error("رحلة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  const current = normalizeSessionStatus(doc.status);
  if (current !== SESSION_STATUSES.ON_DELIVERY && doc.status !== "on_the_way") {
    const err = new Error("يجب بدء التوصيل قبل الإكمال");
    err.status = 400;
    throw err;
  }

  const previousStatus = current;
  doc.status = SESSION_STATUSES.COMPLETED;
  pushTimeline(doc, SESSION_STATUSES.COMPLETED, "تم تسليم الطلبات للزبون");
  await doc.save();

  const formatted = formatSessionDetails(doc);
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
  cancelSession,
  getDashboardStats,
  listSessionsForDriver,
  getSessionForDriver,
  acceptSession,
  collectStoreStop,
  verifySessionPayment,
  startDelivery,
  completeSession,
  formatSessionSummary,
  formatSessionDetails,
  buildStoreStops,
  fetchDeliveryOrders,
  deriveInitialSubmittedStatus,
  allStoresApproved,
};
