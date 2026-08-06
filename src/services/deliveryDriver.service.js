const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const DeliverySession = require("../models/deliverySession");
const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
const Order = require("../models/order");
const Store = require("../models/store");
const User = require("../models/user");
const deliverySessionService = require("./deliverySession.service");
const {
  SESSION_STATUSES,
  OUT_FOR_DELIVERY_STATUSES,
  DELIVERED_SESSION_STATUSES,
  ASSIGNED_COMPANY_STATUSES,
  normalizeSessionStatus,
} = require("../constants/deliverySession.constants");
const { processOptionalImage } = require("../utils/imageProcess.util");
const { requireObjectId, cleanString } = require("../utils/inputSecurity.util");
const { normalizeLocalPhone, isValidLocalPhone } = require("../utils/phone.util");

const DRIVER_REG_TOKEN_SECRET = process.env.JWT_SECRET || "offers-tech-driver-reg";
const DRIVER_REG_TOKEN_TTL = "30m";

const ACTIVE_DRIVER_SESSION_STATUSES = new Set([
  SESSION_STATUSES.DRIVER_ASSIGNED,
  SESSION_STATUSES.OUT_FOR_DELIVERY,
  "collecting_orders",
  "on_the_way",
]);

const HISTORY_DRIVER_SESSION_STATUSES = new Set([
  SESSION_STATUSES.COMPLETED,
  "delivered",
]);

async function resolveDriverFromUser(user) {
  let driver = null;

  if (user?.deliveryDriverId) {
    driver = await DeliveryCompanyDriver.findById(user.deliveryDriverId);
  }

  // Fallback: auth middleware's thin req.user may omit deliveryDriverId —
  // resolve via DeliveryCompanyDriver.userId ↔ User._id.
  if (!driver) {
    const userId = user?._id || user?.id;
    if (userId) {
      driver = await DeliveryCompanyDriver.findOne({ userId });
    }
  }

  if (!driver) {
    const err = new Error("حساب السائق غير مربوط");
    err.status = 403;
    throw err;
  }
  if (!driver.isActive) {
    const err = new Error("حساب السائق معطّل — تواصل مع شركة التوصيل");
    err.status = 403;
    throw err;
  }
  return driver;
}

async function verifyDriverRegistrationPassword(registrationPassword) {
  const password = cleanString(registrationPassword, { field: "registrationPassword", max: 64, required: true });
  const companies = await DeliveryCompany.find({
    deletedAt: null,
    isActive: true,
    driverRegistrationPasswordHash: { $ne: null },
  }).select("+driverRegistrationPasswordHash name phone whatsapp");

  let matched = null;
  for (const company of companies) {
    if (company.driverRegistrationPasswordHash && await bcrypt.compare(password, company.driverRegistrationPasswordHash)) {
      matched = company;
      break;
    }
  }

  if (!matched) {
    const err = new Error("كلمة مرور التسجيل غير صحيحة");
    err.status = 403;
    throw err;
  }

  const registrationToken = jwt.sign(
    { companyId: String(matched._id), purpose: "driver_registration" },
    DRIVER_REG_TOKEN_SECRET,
    { expiresIn: DRIVER_REG_TOKEN_TTL },
  );

  return {
    companyId: matched._id,
    companyName: matched.name,
    registrationToken,
  };
}

async function registerDriver({ registrationToken, name, phone, password, confirmPassword }) {
  if (!registrationToken) {
    const err = new Error("رمز التسجيل مطلوب — أعد التحقق من كلمة مرور الشركة");
    err.status = 400;
    throw err;
  }
  if (password !== confirmPassword) {
    const err = new Error("كلمتا المرور غير متطابقتين");
    err.status = 400;
    throw err;
  }
  if (!password || password.length < 6) {
    const err = new Error("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
    err.status = 400;
    throw err;
  }

  let payload;
  try {
    payload = jwt.verify(registrationToken, DRIVER_REG_TOKEN_SECRET);
  } catch (_) {
    const err = new Error("انتهت صلاحية التسجيل — أعد إدخال كلمة مرور الشركة");
    err.status = 400;
    throw err;
  }
  if (payload.purpose !== "driver_registration" || !payload.companyId) {
    const err = new Error("رمز تسجيل غير صالح");
    err.status = 400;
    throw err;
  }

  const companyId = requireObjectId(payload.companyId, "companyId");
  const company = await DeliveryCompany.findOne({ _id: companyId, deletedAt: null, isActive: true });
  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  const normalizedPhone = normalizeLocalPhone(cleanString(phone, { field: "phone", max: 32, required: true }));
  if (!normalizedPhone || !isValidLocalPhone(normalizedPhone)) {
    const err = new Error("رقم الهاتف غير صالح");
    err.status = 400;
    throw err;
  }

  const existingUser = await User.findOne({ phone: normalizedPhone });
  if (existingUser) {
    const err = new Error("رقم الهاتف مسجّل مسبقاً");
    err.status = 400;
    throw err;
  }

  const driverName = cleanString(name, { field: "name", max: 120, required: true });
  const hashed = await bcrypt.hash(password, 10);

  // Link an existing company contact record (same phone, no login) instead of
  // creating a duplicate — otherwise the company can assign the contact row
  // while the logged-in driver is tied to a different DeliveryCompanyDriver._id.
  let driver = await DeliveryCompanyDriver.findOne({
    deliveryCompany: company._id,
    phone: normalizedPhone,
    $or: [{ userId: null }, { userId: { $exists: false } }],
  });

  const user = await User.create({
    name: driverName,
    phone: normalizedPhone,
    password: hashed,
    role: "delivery_driver",
    deliveryCompanyId: company._id,
    portalActivated: true,
    phoneVerified: true,
    isVerified: true,
  });

  if (driver) {
    driver.name = driverName;
    driver.whatsapp = driver.whatsapp || normalizedPhone;
    driver.userId = user._id;
    driver.isActive = true;
    await driver.save();
  } else {
    driver = await DeliveryCompanyDriver.create({
      deliveryCompany: company._id,
      name: driverName,
      phone: normalizedPhone,
      whatsapp: normalizedPhone,
      userId: user._id,
      isActive: true,
    });
  }

  user.deliveryDriverId = driver._id;
  await user.save();

  return { user, driver, companyName: company.name };
}

async function loadOrdersForSession(session) {
  const orderIds = (session.orders || []).map((o) => o._id || o);
  if (!orderIds.length) return [];

  const orders = await Order.find({ _id: { $in: orderIds } })
    .select("orderNumber verificationCode items status store storeName customerName customerPhone deliveryAddress")
    .lean();

  const storeIds = [...new Set(orders.map((o) => String(o.store)))];
  const stores = await Store.find({ _id: { $in: storeIds } })
    .select("name phone whatsapp address")
    .lean();
  const storeById = Object.fromEntries(stores.map((s) => [String(s._id), s]));

  return orders.map((order) => {
    const store = storeById[String(order.store)] || {};
    return {
      id: order._id,
      orderNumber: order.orderNumber,
      verificationCode: order.verificationCode,
      status: order.status,
      storeName: order.storeName || store.name || "",
      storePhone: store.phone || "",
      storeWhatsapp: store.whatsapp || store.phone || "",
      storeAddress: store.address || "",
      items: (order.items || []).map((item) => ({
        name: item.productName || item.name,
        quantity: item.purchaseMethod === "price" ? 1 : (item.quantity || 1),
        purchaseMethod: item.purchaseMethod || "quantity",
        image: item.productImage || item.image || "",
        // Prices intentionally omitted for delivery staff
      })),
    };
  });
}

const HANDOVER_COMPLETE_ORDER_STATUSES = new Set([
  "delivery_handover_complete",
  "delivered_to_driver",
  "delivered_to_customer",
  "delivered",
]);

function formatDriverAssignment(session, company, orders = []) {
  const plain = session.toObject ? session.toObject() : { ...session };
  const status = normalizeSessionStatus(plain.status);
  const sessionOutForDelivery =
    OUT_FOR_DELIVERY_STATUSES.has(status) || status === SESSION_STATUSES.OUT_FOR_DELIVERY;
  const ordersHandedOver = orders.length > 0
    && orders.every((o) => HANDOVER_COMPLETE_ORDER_STATUSES.has(o.status));
  const stopsHandedOver = (plain.storeStops || []).length > 0
    && (plain.storeStops || []).every((s) =>
      s.collectionStatus === "collected"
      || HANDOVER_COMPLETE_ORDER_STATUSES.has(s.orderStatus)
    );
  // Unlock deliver action once the store has handed over — even if session
  // status briefly lagged behind the order status.
  const canConfirmDelivery = sessionOutForDelivery || ordersHandedOver || stopsHandedOver;

  return {
    id: plain._id,
    _id: plain._id,
    referenceNumber: plain.orderNumber || `#${String(plain._id).slice(-6)}`,
    status: canConfirmDelivery && !sessionOutForDelivery
      ? SESSION_STATUSES.OUT_FOR_DELIVERY
      : status,
    statusLabel: canConfirmDelivery ? "قيد التوصيل" : "معيّن لسائق",
    customerName: plain.customerName || "",
    customerPhone: plain.customerPhone || "",
    customerWhatsapp: plain.customerWhatsapp || plain.customerPhone || "",
    customerId: plain.customer?._id || plain.customer || null,
    deliveryAddress: plain.deliveryAddress || "",
    deliveryArea: plain.deliveryArea || "",
    deliveryFee: plain.deliveryFee ?? 0,
    currency: plain.currency || "ILS",
    paymentMethod: plain.payment?.method || plain.paymentMethod || "",
    companyName: company?.name || "",
    companyPhone: company?.phone || "",
    companyWhatsapp: company?.whatsapp || company?.phone || "",
    storeStops: plain.storeStops || [],
    orders: orders,
    stores: orders.map((o) => ({
      orderId: o.id,
      name: o.storeName,
      phone: o.storePhone,
      whatsapp: o.storeWhatsapp,
      address: o.storeAddress,
      orderNumber: o.orderNumber,
      verificationCode: o.verificationCode,
      items: o.items,
    })),
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    canConfirmDelivery,
  };
}

async function resolveAssignmentDriverIds(driver) {
  const companyDrivers = await DeliveryCompanyDriver.find({
    deliveryCompany: driver.deliveryCompany,
  })
    .select("_id phone")
    .lean();

  const myPhone = normalizeLocalPhone(driver.phone);
  const siblingIds = companyDrivers
    .filter((d) => normalizeLocalPhone(d.phone) === myPhone)
    .map((d) => d._id);

  return siblingIds.length ? siblingIds : [driver._id];
}

async function listActiveAssignments(user) {
  const driver = await resolveDriverFromUser(user);
  // Include sibling contact rows with the same phone (company-created then
  // self-registered) so assignments saved against either _id are visible.
  const driverIds = await resolveAssignmentDriverIds(driver);

  const sessions = await DeliverySession.find({
    deliveryCompany: driver.deliveryCompany,
    "assignedDriver.driverId": { $in: driverIds },
    status: { $in: [...ACTIVE_DRIVER_SESSION_STATUSES] },
  })
    .sort({ updatedAt: -1 })
    .limit(50);

  const company = await DeliveryCompany.findById(driver.deliveryCompany).select("name phone whatsapp").lean();

  const result = [];
  for (const session of sessions) {
    // Heal DRIVER_ASSIGNED → OUT_FOR_DELIVERY when store already handed over.
    await deliverySessionService.reconcileSessionFromOrders(session._id).catch(() => null);
    const fresh = await DeliverySession.findById(session._id);
    if (!fresh) continue;
    const refreshed = await deliverySessionService.refreshStoreStopsFromOrders(fresh);
    const orders = await loadOrdersForSession(refreshed);
    result.push(formatDriverAssignment(refreshed, company, orders));
  }
  return result;
}

async function listDeliveryHistory(user, { limit = 50 } = {}) {
  const driver = await resolveDriverFromUser(user);
  const driverIds = await resolveAssignmentDriverIds(driver);

  const sessions = await DeliverySession.find({
    deliveryCompany: driver.deliveryCompany,
    "assignedDriver.driverId": { $in: driverIds },
    status: { $in: [...HISTORY_DRIVER_SESSION_STATUSES] },
  })
    .sort({ driverDeliveredAt: -1, updatedAt: -1 })
    .limit(Math.min(limit, 100))
    .lean();

  const company = await DeliveryCompany.findById(driver.deliveryCompany).select("name phone whatsapp").lean();

  return sessions.map((s) => formatDriverAssignment(s, company, []));
}

async function getAssignmentDetail(user, sessionId) {
  const driver = await resolveDriverFromUser(user);
  const id = requireObjectId(sessionId, "sessionId");
  const driverIds = await resolveAssignmentDriverIds(driver);

  const session = await DeliverySession.findOne({
    _id: id,
    deliveryCompany: driver.deliveryCompany,
    "assignedDriver.driverId": { $in: driverIds },
  });

  if (!session) {
    const err = new Error("الطلب غير موجود أو غير معيّن لك");
    err.status = 404;
    throw err;
  }

  await deliverySessionService.reconcileSessionFromOrders(session._id).catch(() => null);
  const fresh = await DeliverySession.findById(session._id);
  const refreshed = await deliverySessionService.refreshStoreStopsFromOrders(fresh || session);
  const company = await DeliveryCompany.findById(driver.deliveryCompany).select("name phone whatsapp").lean();
  const orders = await loadOrdersForSession(refreshed);
  return formatDriverAssignment(refreshed, company, orders);
}

async function completeDelivery(user, sessionId, body = {}) {
  const driver = await resolveDriverFromUser(user);
  const id = requireObjectId(sessionId, "sessionId");
  const clientSyncId = cleanString(body.clientSyncId, { field: "clientSyncId", max: 120 }) || "";
  const driverIds = await resolveAssignmentDriverIds(driver);

  const session = await DeliverySession.findOne({
    _id: id,
    deliveryCompany: driver.deliveryCompany,
    "assignedDriver.driverId": { $in: driverIds },
  });

  if (!session) {
    const err = new Error("الطلب غير موجود أو غير معيّن لك");
    err.status = 404;
    throw err;
  }

  // Heal lagged handoff before enforcing out_for_delivery gate.
  await deliverySessionService.reconcileSessionFromOrders(session._id).catch(() => null);
  const healed = await DeliverySession.findById(session._id);
  if (healed) {
    session.status = healed.status;
    session.storeStops = healed.storeStops;
    session.statusTimeline = healed.statusTimeline;
  }

  const current = normalizeSessionStatus(session.status);
  if (DELIVERED_SESSION_STATUSES.has(current)) {
    return formatDriverAssignment(
      session,
      await DeliveryCompany.findById(driver.deliveryCompany).select("name phone whatsapp").lean(),
      await loadOrdersForSession(session),
    );
  }

  if (clientSyncId && session.driverCompletionSyncId === clientSyncId) {
    return formatDriverAssignment(session, null, await loadOrdersForSession(session));
  }

  const ordersForGate = await loadOrdersForSession(session);
  const ordersHandedOver = ordersForGate.length > 0
    && ordersForGate.every((o) => HANDOVER_COMPLETE_ORDER_STATUSES.has(o.status));
  const allowed = new Set([...OUT_FOR_DELIVERY_STATUSES, SESSION_STATUSES.OUT_FOR_DELIVERY]);
  if (!allowed.has(current) && !allowed.has(session.status) && !ordersHandedOver) {
    const err = new Error("لا يمكن تأكيد التسليم قبل استلام الطلب من المتجر");
    err.status = 400;
    throw err;
  }

  // Persist out_for_delivery if we are completing from a lagged driver_assigned session.
  if (!allowed.has(current) && ordersHandedOver) {
    session.status = SESSION_STATUSES.OUT_FOR_DELIVERY;
    session.statusTimeline = session.statusTimeline || [];
    session.statusTimeline.push({
      status: SESSION_STATUSES.OUT_FOR_DELIVERY,
      at: new Date(),
      note: "استلم السائق الطلب من المتجر",
    });
  }

  const proofImage = body.deliveryProof
    ? await processOptionalImage(body.deliveryProof, { maxWidth: 1600, enforceCloudinaryHttps: true })
    : "";
  if (!proofImage && !session.driverDeliveryProof) {
    const err = new Error("صورة إثبات التسليم مطلوبة");
    err.status = 400;
    throw err;
  }
  const note = cleanString(body.deliveryNote, { field: "deliveryNote", max: 1000 }) || "";
  const company = await DeliveryCompany.findById(driver.deliveryCompany).select("name phone whatsapp").lean();
  const ordersForSnap = ordersForGate.length ? ordersForGate : await loadOrdersForSession(session);
  const verificationCodes = [
    ...new Set(
      [
        ...(session.storeStops || []).map((s) => s.verificationCode),
        ...ordersForSnap.map((o) => o.verificationCode),
      ].filter(Boolean),
    ),
  ];
  const orderNumbers = [
    ...new Set(
      [
        ...(session.storeStops || []).map((s) => s.orderNumber),
        ...ordersForSnap.map((o) => o.orderNumber),
      ].filter(Boolean),
    ),
  ];
  const deliveredAt = new Date();
  const finalPhoto = proofImage || session.driverDeliveryProof || "";

  session.driverDeliveryProof = finalPhoto;
  session.driverDeliveryNote = note;
  session.driverDeliveredAt = deliveredAt;
  if (clientSyncId) session.driverCompletionSyncId = clientSyncId;
  session.deliveryProofSnapshot = {
    photo: finalPhoto,
    note,
    deliveredAt,
    driverId: driver._id,
    driverName: driver.name || session.assignedDriver?.name || "",
    driverPhone: driver.phone || session.assignedDriver?.phone || "",
    companyId: company?._id || driver.deliveryCompany,
    companyName: company?.name || "",
    verificationCode: verificationCodes[0] || "",
    verificationCodes,
    orderIds: (session.orders || []).map((o) => o._id || o),
    orderNumbers,
    customerName: session.customerName || "",
    customerPhone: session.customerPhone || "",
  };
  session.status = SESSION_STATUSES.COMPLETED;
  session.statusTimeline = session.statusTimeline || [];
  session.statusTimeline.push({
    status: SESSION_STATUSES.COMPLETED,
    at: deliveredAt,
    note: note || "تم استلام الطلب بنجاح",
  });
  await session.save();

  const now = deliveredAt;
  const deleteAfter = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const orderIds = (session.orders || []).map((o) => o._id || o);
  if (orderIds.length) {
    await Order.updateMany(
      {
        _id: { $in: orderIds },
        status: {
          $nin: ["delivered_to_customer", "delivered", "rejected", "cancelled", "completed_off_platform"],
        },
      },
      {
        $set: {
          status: "delivered_to_customer",
          completedAt: now,
          deleteAfter,
        },
        $push: {
          statusTimeline: {
            status: "delivered_to_customer",
            at: now,
            note: note || "تم استلام الطلب بنجاح",
          },
        },
      },
    );
  }

  const formatted = deliverySessionService.formatSessionDetails(session, company);

  setImmediate(() => {
    const deliveryNotificationService = require("./deliveryNotification.service");
    deliveryNotificationService.dispatchStatusChange(
      SESSION_STATUSES.OUT_FOR_DELIVERY,
      formatted,
    ).catch(() => {});
  });

  return formatDriverAssignment(session, company, ordersForSnap);
}

async function syncOfflineCompletions(user, items = []) {
  const results = [];
  for (const item of items) {
    try {
      const assignment = await completeDelivery(user, item.sessionId, {
        deliveryProof: item.deliveryProof,
        deliveryNote: item.deliveryNote,
        clientSyncId: item.clientSyncId,
      });
      results.push({ sessionId: item.sessionId, clientSyncId: item.clientSyncId, success: true, assignment });
    } catch (err) {
      results.push({
        sessionId: item.sessionId,
        clientSyncId: item.clientSyncId,
        success: false,
        message: err.message,
      });
    }
  }
  return results;
}

async function setDriverRegistrationPassword(user, { password, confirmPassword } = {}) {
  const company = await DeliveryCompany.findOne({
    _id: user.deliveryCompanyId,
    deletedAt: null,
  }).select("+driverRegistrationPasswordHash");

  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  if (!password || password.length < 4) {
    const err = new Error("كلمة مرور التسجيل يجب أن تكون 4 أحرف على الأقل");
    err.status = 400;
    throw err;
  }
  if (password !== confirmPassword) {
    const err = new Error("كلمتا المرور غير متطابقتين");
    err.status = 400;
    throw err;
  }

  company.driverRegistrationPasswordHash = await bcrypt.hash(password, 10);
  await company.save();
  return { hasDriverRegistrationPassword: true };
}

async function getDriverRegistrationPasswordStatus(user) {
  const company = await DeliveryCompany.findOne({
    _id: user.deliveryCompanyId,
    deletedAt: null,
  }).select("+driverRegistrationPasswordHash");

  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }

  return {
    hasDriverRegistrationPassword: Boolean(company.driverRegistrationPasswordHash),
  };
}

module.exports = {
  verifyDriverRegistrationPassword,
  registerDriver,
  resolveDriverFromUser,
  listActiveAssignments,
  listDeliveryHistory,
  getAssignmentDetail,
  completeDelivery,
  syncOfflineCompletions,
  setDriverRegistrationPassword,
  getDriverRegistrationPasswordStatus,
};
