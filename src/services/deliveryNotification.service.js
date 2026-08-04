const notificationService = require("./notification.service");
const User = require("../models/user");
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

async function notifyCompanyUsers(companyId, { type, title, body, session }) {
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
        data: sessionData(session),
      })),
    );
  } catch (err) {
    safeLog("warn", "delivery_notify_company_failed", { message: err.message, companyId: String(companyId) });
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
    body: "سيتم إرسال الطلب لشركة التوصيل بعد موافقة جميع المتاجر",
    session,
  });
}

async function onReadyForPickup(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_ready_for_pickup",
    title: "الطلبات جاهزة للتوصيل",
    body: "تمت موافقة المتاجر — تم إرسال الطلب لشركة التوصيل",
    session,
  });

  await notifyCompanyUsers(session.deliveryCompany, {
    type: "delivery_new_request",
    title: "طلب توصيل جديد",
    body: `طلب جديد — ${session.storeStops?.length || 0} طلبات`,
    session,
  });
}

async function onAccepted(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_accepted",
    title: "تم قبول طلب التوصيل",
    body: "قبلت شركة التوصيل طلبك — سيتم التوصيل قريباً",
    session,
  });
}

async function onOutForDelivery(session, extra = {}) {
  const driverName = extra.driverName || session.driverName || session.assignedDriver?.name || "";
  const driverPhone = extra.driverPhone || session.driverPhone || session.assignedDriver?.phone || "";
  const body = driverName
    ? `السائق ${driverName}${driverPhone ? ` — ${driverPhone}` : ""} في طريقه إليك`
    : "طلبك في طريقه إليك";

  await notifyCustomer(session.customer, {
    type: "delivery_on_the_way",
    title: driverName ? "السائق في الطريق" : "الطلب قيد التوصيل",
    body,
    session: {
      ...session,
      driverName,
      driverPhone,
      driverWhatsapp: extra.driverWhatsapp || session.driverWhatsapp || session.assignedDriver?.whatsapp || driverPhone,
    },
  });
}

async function onCompleted(session) {
  await notifyCustomer(session.customer, {
    type: "delivery_completed",
    title: "تم التسليم",
    body: "تم تسليم طلبك بنجاح — شكراً لاستخدامك المنصة",
    session,
  });
}

async function onRejected(session, reason = "") {
  await notifyCustomer(session.customer, {
    type: "delivery_rejected",
    title: "تم رفض طلب التوصيل",
    body: reason || "رفضت شركة التوصيل الطلب — يمكنك اختيار شركة أخرى",
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

async function dispatchStatusChange(previousStatus, session, extra = {}) {
  const status = normalizeSessionStatus(session.status);
  const prev = normalizeSessionStatus(previousStatus);
  if (status === prev) return;

  switch (status) {
    case SESSION_STATUSES.WAITING_FOR_STORES:
      if (previousStatus === SESSION_STATUSES.WAITING) await onWaitingForStores(session);
      break;
    case SESSION_STATUSES.READY_FOR_PICKUP:
      await onReadyForPickup(session);
      break;
    case SESSION_STATUSES.ACCEPTED:
      await onAccepted(session);
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
    default:
      break;
  }
}

module.exports = {
  onSessionCreated,
  onWaitingForStores,
  onReadyForPickup,
  onAccepted,
  onOutForDelivery,
  onCompleted,
  onRejected,
  onStoreOrderUpdated,
  dispatchStatusChange,
  notifyCompanyUsers,
};
