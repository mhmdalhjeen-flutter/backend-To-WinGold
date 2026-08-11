const notificationService = require("./notification.service");
const User = require("../models/user");
const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
const { SESSION_STATUSES, normalizeSessionStatus } = require("../constants/deliverySession.constants");
const { safeLog } = require("../utils/logSanitize.util");

function sessionData(session) {
  const id = session?._id || session?.id;
  const assigned = session?.assignedDriver || {};
  return {
    deliverySessionId: id ? String(id) : "",
    url: id ? `/requests/${id}` : "/requests",
    driverName: assigned.name || session?.driverName || "",
    driverPhone: assigned.phone || session?.driverPhone || "",
    driverWhatsapp: assigned.whatsapp || session?.driverWhatsapp || assigned.phone || session?.driverPhone || "",
    companyName: session?.companyName || "",
    companyPhone: session?.companyPhone || "",
    companyWhatsapp: session?.companyWhatsapp || session?.companyPhone || "",
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

async function notifyCompanyUsers(companyId, { type, title, body, session, data: extraData = {} }) {
  if (!companyId || !title) return;
  try {
    const users = await User.find({
      role: "delivery_company",
      deliveryCompanyId: companyId,
    })
      .select("_id")
      .lean();

    if (!users.length) return;

    await notificationService.createMany(
      users.map((u) => ({
        user: u._id,
        type,
        title,
        body: body || "",
        data: {
          ...sessionData(session),
          ...extraData,
          pushApp: "delivery",
        },
      })),
    );
  } catch (err) {
    safeLog("warn", "delivery_notify_company_failed", { message: err.message, companyId: String(companyId) });
  }
}

async function notifyDriver(driverRef, { type, title, body, session }) {
  if (!title) return;
  try {
    let userId = null;
    if (driverRef?.userId) {
      userId = driverRef.userId;
    } else if (driverRef?.driverId || driverRef?._id) {
      const driver = await DeliveryCompanyDriver.findById(driverRef.driverId || driverRef._id)
        .select("userId")
        .lean();
      userId = driver?.userId || null;
    }

    if (!userId) return;

    await notificationService.create({
      user: userId,
      type,
      title,
      body: body || "",
      data: {
        ...sessionData(session),
        url: `/driver/delivery/${session?._id || session?.id || ""}`,
        pushApp: "delivery",
      },
    });
  } catch (err) {
    safeLog("warn", "delivery_notify_driver_failed", { message: err.message });
  }
}

async function onSessionCreated(session) {
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

  // Company sees the request immediately under Waiting for Store Approval
  await notifyCompanyUsers(session.deliveryCompany, {
    type: "delivery_waiting_stores",
    title: "طلب جديد — بانتظار تأكيد المتجر",
    body: `طلب توصيل جديد بانتظار موافقة المتجر — ${session.storeStops?.length || 0} طلبات`,
    session,
  });
}

async function onWaitingForStores(session) {
  await notifyCompanyUsers(session.deliveryCompany, {
    type: "delivery_waiting_stores",
    title: "طلب بانتظار تأكيد المتجر",
    body: `طلب توصيل بانتظار موافقة المتاجر — ${session.storeStops?.length || 0} طلبات`,
    session,
  });
}

async function onReadyForPickup(session) {
  await notifyCompanyUsers(session.deliveryCompany, {
    type: "delivery_new_request",
    title: "جاهز لتعيين سائق",
    body: `تم قبول المتجر — عيّن سائقاً للطلب — ${session.storeStops?.length || 0} طلبات`,
    session,
  });
}

async function onDriverAssigned(session, extra = {}) {
  const driverName = extra.driverName || session.driverName || session.assignedDriver?.name || "";
  const driverPhone = extra.driverPhone || session.driverPhone || session.assignedDriver?.phone || "";
  const driverWhatsapp = extra.driverWhatsapp || session.driverWhatsapp || session.assignedDriver?.whatsapp || driverPhone;
  const companyName = session.companyName || "";

  const enrichedSession = {
    ...session,
    driverName,
    driverPhone,
    driverWhatsapp,
    companyName,
    companyPhone: session.companyPhone || "",
    companyWhatsapp: session.companyWhatsapp || session.companyPhone || "",
  };

  await notifyDriver(session.assignedDriver || { driverId: extra.driverId }, {
    type: "delivery_assigned_to_you",
    title: "تم تعيينك لطلب توصيل",
    body: `لديك طلب توصيل جديد${session.customerName ? ` — ${session.customerName}` : ""}`,
    session: enrichedSession,
  });
}

async function onOutForDelivery(session, extra = {}) {
  const driverName = extra.driverName || session.driverName || session.assignedDriver?.name || "";
  const driverPhone = extra.driverPhone || session.driverPhone || session.assignedDriver?.phone || "";
  const driverWhatsapp = extra.driverWhatsapp || session.driverWhatsapp || session.assignedDriver?.whatsapp || driverPhone;

  const enrichedSession = {
    ...session,
    driverName,
    driverPhone,
    driverWhatsapp,
  };

  await notifyCustomer(session.customer, {
    type: "delivery_on_the_way",
    title: "تم استلام طلبك للتوصيل",
    body: driverName
      ? `استلم ${driverName} طلبك من المتجر — في طريقه إليك`
      : "استلمت شركة التوصيل طلبك من المتجر — في الطريق إليك",
    session: enrichedSession,
  });

  await notifyDriver(session.assignedDriver, {
    type: "delivery_out_for_delivery",
    title: "ابدأ التوصيل",
    body: "تم تسليم الطلب لك من المتجر — توجّه إلى الزبون",
    session: enrichedSession,
  });
}

async function onCompleted(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_completed",
    title: "تم استلام الطلب بنجاح",
    body: "تم استلام طلبك بنجاح — شكراً لاستخدامك المنصة",
    session,
  });
}

async function onRejected(session, reason = "") {
  await notifyCompanyUsers(session.deliveryCompany, {
    type: "delivery_rejected",
    title: "تم رفض طلب التوصيل",
    body: reason || "تم رفض طلب التوصيل",
    session: {
      ...session,
      rejectionReason: reason || session.rejectionReason,
    },
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

async function onCancelled(session, reason = "") {
  await notifyCompanyUsers(session.deliveryCompany, {
    type: "delivery_cancelled",
    title: "تم إلغاء طلب التوصيل",
    body: reason || "تم إلغاء طلب التوصيل بسبب رفض أحد المتاجر",
    session,
  });
}

async function dispatchStatusChange(previousStatus, session, extra = {}) {
  const status = normalizeSessionStatus(session.status);
  const prev = normalizeSessionStatus(previousStatus);
  if (status === prev) return;

  switch (status) {
    case SESSION_STATUSES.WAITING_FOR_STORES:
      if (prev === SESSION_STATUSES.WAITING) await onWaitingForStores(session);
      break;
    case SESSION_STATUSES.READY_FOR_PICKUP:
      await onReadyForPickup(session);
      break;
    case SESSION_STATUSES.DRIVER_ASSIGNED:
      await onDriverAssigned(session, extra);
      break;
    case SESSION_STATUSES.ACCEPTED:
      await onDriverAssigned(session, extra);
      break;
    case SESSION_STATUSES.OUT_FOR_DELIVERY:
      await onOutForDelivery(session, extra);
      break;
    case SESSION_STATUSES.COMPLETED:
      await onCompleted(session);
      break;
    case SESSION_STATUSES.REJECTED:
      await onRejected(session, extra.rejectReason);
      break;
    case SESSION_STATUSES.CANCELLED:
      await onCancelled(session, extra.cancelReason);
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
  onOutForDelivery,
  onCompleted,
  onRejected,
  onStoreOrderUpdated,
  onCancelled,
  dispatchStatusChange,
  notifyCompanyUsers,
  notifyDriver,
};
