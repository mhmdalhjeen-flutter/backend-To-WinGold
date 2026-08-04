const notificationService = require("./notification.service");
const User = require("../models/user");
const { SESSION_STATUSES } = require("../constants/deliverySession.constants");
const { safeLog } = require("../utils/logSanitize.util");

function sessionData(session) {
  const id = session?._id || session?.id;
  return {
    deliverySessionId: id ? String(id) : "",
    url: id ? `/delivery/${id}` : "/delivery",
  };
}

async function notifyCustomer(userId, { type, title, body, session }) {
  if (!userId || !title) return;
  await notificationService.create({
    user: userId,
    type,
    title,
    body: body || "",
    data: sessionData(session),
  });
}

async function notifyStoreOwner(ownerId, { type, title, body, session, orderId, storeId }) {
  if (!ownerId || !title) return;
  await notificationService.create({
    user: ownerId,
    type,
    title,
    body: body || "",
    data: {
      ...sessionData(session),
      orderId: orderId ? String(orderId) : undefined,
      storeId: storeId ? String(storeId) : undefined,
    },
  });
}

async function notifyCompanyDrivers(companyId, { type, title, body, session }) {
  if (!companyId || !title) return;
  try {
    const drivers = await User.find({
      role: "driver",
      deliveryCompanyId: companyId,
    })
      .select("_id")
      .lean();

    if (!drivers.length) return;

    await notificationService.createMany(
      drivers.map((d) => ({
        user: d._id,
        type,
        title,
        body: body || "",
        data: sessionData(session),
      })),
    );
  } catch (err) {
    safeLog("warn", "delivery_notify_drivers_failed", { message: err.message, companyId: String(companyId) });
  }
}

async function onSessionCreated(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_session_created",
    title: "تم إنشاء طلب التوصيل",
    body: "جاري انتظار موافقة المتاجر على الطلبات المرفقة",
    session,
  });

  for (const stop of session.storeStops || []) {
    if (!stop.storeOwnerId) continue;
    await notifyStoreOwner(stop.storeOwnerId, {
      type: "delivery_order_included",
      title: "طلب ضمن رحلة توصيل",
      body: `تم إضافة الطلب ${stop.orderNumber || ""} إلى رحلة توصيل للزبون`.trim(),
      session,
      orderId: stop.order,
      storeId: stop.store,
    });
  }
}

async function onWaitingForStores(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_waiting_stores",
    title: "بانتظار موافقة المتاجر",
    body: "سيتم إبلاغ السائقين بعد موافقة جميع المتاجر",
    session,
  });
}

async function onReadyForPickup(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_ready_for_pickup",
    title: "الطلبات جاهزة للتوصيل",
    body: "تمت موافقة المتاجر — سيتم تعيين سائق قريباً",
    session,
  });

  await notifyCompanyDrivers(session.deliveryCompany, {
    type: "delivery_new_request",
    title: "طلب توصيل جديد",
    body: `رحلة جديدة — ${session.storeStops?.length || 0} طلبات`,
    session,
  });
}

async function onDriverAssigned(session, driverName = "") {
  await notifyCustomer(session.customer, {
    type: "delivery_driver_assigned",
    title: "تم تعيين سائق",
    body: driverName ? `السائق ${driverName} قبل رحلة التوصيل` : "تم قبول رحلة التوصيل من قبل سائق",
    session,
  });
}

async function onCollectingOrders(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_collecting_orders",
    title: "السائق يجمع الطلبات",
    body: "السائق يستلم الطلبات من المتاجر",
    session,
  });
}

async function onOnDelivery(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_on_the_way",
    title: "السائق في الطريق",
    body: "السائق في طريقه لتسليم طلباتك",
    session,
  });
}

async function onCompleted(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_completed",
    title: "تم التوصيل",
    body: "تم تسليم جميع الطلبات بنجاح",
    session,
  });
}

async function onStoreOrderUpdated(session, stop) {
  if (!stop?.storeOwnerId) return;
  await notifyStoreOwner(stop.storeOwnerId, {
    type: "delivery_store_update",
    title: "تحديث حالة طلب التوصيل",
    body: `الطلب ${stop.orderNumber || ""}: ${stop.orderStatusLabel || stop.orderStatus}`,
    session,
    orderId: stop.order,
    storeId: stop.store,
  });
}

async function dispatchStatusChange(previousStatus, session, extra = {}) {
  const status = session.status;
  if (status === previousStatus) return;

  switch (status) {
    case SESSION_STATUSES.WAITING_FOR_STORES:
      if (previousStatus === SESSION_STATUSES.WAITING) await onWaitingForStores(session);
      break;
    case SESSION_STATUSES.READY_FOR_PICKUP:
      await onReadyForPickup(session);
      break;
    case SESSION_STATUSES.DRIVER_ASSIGNED:
      await onDriverAssigned(session, extra.driverName);
      break;
    case SESSION_STATUSES.COLLECTING_ORDERS:
      if (previousStatus !== SESSION_STATUSES.COLLECTING_ORDERS) await onCollectingOrders(session);
      break;
    case SESSION_STATUSES.ON_DELIVERY:
      await onOnDelivery(session);
      break;
    case SESSION_STATUSES.COMPLETED:
      await onCompleted(session);
      break;
    default:
      break;
  }
}

module.exports = {
  onSessionCreated,
  onWaitingForStores,
  onReadyForPickup,
  onDriverAssigned,
  onCollectingOrders,
  onOnDelivery,
  onCompleted,
  onStoreOrderUpdated,
  dispatchStatusChange,
  notifyCompanyDrivers,
};
