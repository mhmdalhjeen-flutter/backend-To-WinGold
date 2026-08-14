const mongoose = require("mongoose");
const Order = require("../models/order");
const Cart = require("../models/Cart");
const Store = require("../models/store");
const User = require("../models/user");
const notificationService = require("./notification.service");
const storeCardInventoryService = require("./storeCardInventory.service");
const membershipService = require("./storeMembership.service");
const { restoreStockForOrderItems, restoreItemsToStoreContainer } = require("./cart.service");
const { cleanString } = require("../utils/inputSecurity.util");
const { DELIVERY_METHODS, normalizePaymentMethod } = require("../constants/marketplaceOrder.constants");
const {
  ALLOWED_STATUSES,
  canTransition,
  isActiveStatus,
  isTerminalStatus,
  normalizeStatus,
} = require("../utils/orderStatus.util");
const DeliverySession = require("../models/deliverySession");
const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
const { normalizeLocalPhone } = require("../utils/phone.util");

const ORDER_LIST_SELECT =
  "orderNumber verificationCode containerId containerName customer store customerName customerPhone storeName items subtotal total totalAmount currency status customerNotes storeNotes deliveryMethod deliveryAddress deliveryNotes paymentMethod paymentProof paymentProofImage transferInformation transferName transferPhone transferNumber paymentNotes rejectionReason paymentStatus pointsAwarded rewardPointsAwarded consumedCardType cardDeducted deliveryGroup confirmedAt completedAt deleteAfter statusTimeline modificationRequest orderChangeHistory originalTotal additionalPaymentAmount additionalPayment paymentTransactions createdAt updatedAt";

const HISTORY_RETENTION_DAYS = 7;

function historyCutoffDate() {
  return new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

function pushTimelineUpdate(timeline, status, note = "") {
  const list = Array.isArray(timeline) ? [...timeline] : [];
  list.push({ status, at: new Date(), note });
  return list;
}

function isTransactionUnsupported(err) {
  return (
    err.message?.includes("Transaction numbers") ||
    err.code === 20 ||
    err.code === 251 ||
    err.code === 263
  );
}

async function restoreOrderItemsToCart(userId, orderItems, storeId, session) {
  await restoreItemsToStoreContainer(userId, orderItems, storeId, session);
}

async function getStorePendingCount(ownerId) {
  const store = await Store.findOne({ owner: ownerId }).select("_id");
  if (!store) {
    return { count: 0, pendingReview: 0, awaitingCustomerModification: 0 };
  }

  const [pendingReview, awaitingCustomerModification] = await Promise.all([
    Order.countDocuments({ store: store._id, status: "pending" }),
    Order.countDocuments({ store: store._id, status: "modification_requested" }),
  ]);

  return {
    /** Orders awaiting store review (legacy field name). */
    count: pendingReview,
    pendingReview,
    awaitingCustomerModification,
  };
}

async function getStoreOrders(ownerId) {
  const store = await Store.findOne({ owner: ownerId }).select("_id cards bypassCards");
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }

  const orders = await Order.find({
    store: store._id,
    status: {
      $in: ["pending", "modification_requested", "store_accepted", "ready_for_delivery_pickup", "ready_for_driver_pickup", "delivery_handover_complete", "confirmed", "preparing", "delivered_to_driver"],
    },
  })
    .select(ORDER_LIST_SELECT)
    .sort({ createdAt: -1 })
    .populate("customer", "name phone")
    .lean();

  return { orders, cards: store.cards, bypassCards: store.bypassCards };
}

async function getCustomerActiveOrders(customerId) {
  return Order.find({
    customer: customerId,
    status: {
      $in: ["pending", "modification_requested", "store_accepted", "ready_for_delivery_pickup", "ready_for_driver_pickup", "delivery_handover_complete", "confirmed", "preparing", "delivered_to_driver"],
    },
  })
    .select(ORDER_LIST_SELECT)
    .sort({ createdAt: -1 })
    .populate("store", "name phone owner whatsapp")
    .lean();
}

async function getCustomerOrders(customerId) {
  return getCustomerActiveOrders(customerId);
}

async function getCustomerOrderHistory(customerId) {
  const cutoff = historyCutoffDate();
  return Order.find({
    customer: customerId,
    status: {
      $in: [
        "delivered_to_customer",
        "delivered",
        "rejected",
        "cancelled",
        "completed_off_platform",
      ],
    },
    $or: [{ deleteAfter: { $gt: new Date() } }, { completedAt: { $gte: cutoff } }, { updatedAt: { $gte: cutoff } }],
  })
    .select(ORDER_LIST_SELECT)
    .sort({ createdAt: -1 })
    .populate("store", "name phone owner whatsapp")
    .lean();
}

function buildHistoryQuery(filters = {}) {
  const q = {};
  const cutoff = historyCutoffDate();

  if (filters.status) {
    q.status = filters.status;
  } else {
    q.status = {
      $in: [
        "delivered_to_customer",
        "delivered",
        "rejected",
        "cancelled",
        "completed_off_platform",
        "store_accepted",
        "confirmed",
        "preparing",
        "delivered_to_driver",
        "pending",
      ],
    };
  }

  if (filters.from || filters.to) {
    q.createdAt = {};
    if (filters.from) q.createdAt.$gte = new Date(filters.from);
    if (filters.to) q.createdAt.$lte = new Date(filters.to);
  }

  if (filters.storeId) q.store = filters.storeId;
  if (filters.customerId) q.customer = filters.customerId;

  if (filters.activeOnly) {
    q.status = {
      $in: ["pending", "store_accepted", "ready_for_delivery_pickup", "ready_for_driver_pickup", "delivery_handover_complete", "confirmed", "preparing", "delivered_to_driver"],
    };
  } else if (filters.historyOnly !== false && !filters.status) {
    q.$or = [
      { deleteAfter: { $gt: new Date() } },
      { completedAt: { $gte: cutoff } },
      { updatedAt: { $gte: cutoff }, status: { $in: ["delivered_to_customer", "delivered", "rejected", "cancelled", "completed_off_platform"] } },
    ];
  }

  if (filters.q) {
    const regex = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$and = q.$and || [];
    q.$and.push({
      $or: [
        { orderNumber: regex },
        { verificationCode: regex },
        { containerName: regex },
        { customerName: regex },
        { customerPhone: regex },
        { storeName: regex },
      ],
    });
  }

  return q;
}

async function getStoreOrderHistory(ownerId, filters = {}) {
  const store = await Store.findOne({ owner: ownerId }).select("_id name");
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }

  const q = buildHistoryQuery({ ...filters, storeId: store._id, historyOnly: true });

  const orders = await Order.find(q)
    .select(ORDER_LIST_SELECT)
    .sort({ createdAt: -1 })
    .populate("customer", "name phone")
    .limit(Math.min(parseInt(filters.limit, 10) || 100, 500))
    .lean();

  return { orders, storeName: store.name };
}

async function getStoreInvoices(ownerId, filters = {}) {
  const store = await Store.findOne({ owner: ownerId }).select("_id name");
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }

  const q = {
    store: store._id,
    status: { $nin: ["cancelled", "rejected"] },
  };

  if (filters.status) q.status = filters.status;

  if (filters.from || filters.to) {
    q.createdAt = {};
    if (filters.from) q.createdAt.$gte = new Date(filters.from);
    if (filters.to) q.createdAt.$lte = new Date(filters.to);
  }

  if (filters.q) {
    const regex = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    q.$and = q.$and || [];
    q.$and.push({
      $or: [
        { orderNumber: regex },
        { verificationCode: regex },
        { containerName: regex },
      ],
    });
  }

  const orders = await Order.find(q)
    .select(ORDER_LIST_SELECT)
    .sort({ createdAt: -1 })
    .populate("customer", "name phone email")
    .limit(Math.min(parseInt(filters.limit, 10) || 200, 500))
    .lean();

  return { orders, storeName: store.name, count: orders.length };
}

async function getAdminOrderHistory(filters = {}) {
  const q = buildHistoryQuery({ ...filters, historyOnly: false });

  const orders = await Order.find(q)
    .select(ORDER_LIST_SELECT)
    .sort({ createdAt: -1 })
    .populate("customer", "name phone")
    .populate("store", "name phone region")
    .limit(Math.min(parseInt(filters.limit, 10) || 200, 1000))
    .lean();

  return { orders, count: orders.length };
}

async function getAdminOrderById(orderId) {
  const order = await Order.findById(orderId)
    .select(ORDER_LIST_SELECT)
    .populate("customer", "name phone email")
    .populate("store", "name phone region whatsapp owner")
    .lean();

  if (!order) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  return order;
}

function orderAccessDenied(message = "غير مصرح") {
  const err = new Error(message);
  err.status = 403;
  return err;
}

function orderCustomerId(order) {
  return order.customer?._id?.toString?.() || order.customer?.toString?.() || "";
}

function orderStoreId(order) {
  return order.store?._id?.toString?.() || order.store?.toString?.() || "";
}

async function resolveDriverAssignmentIdsForUser(userId) {
  const user = await User.findById(userId).select("deliveryDriverId").lean();
  let driver = null;
  if (user?.deliveryDriverId) {
    driver = await DeliveryCompanyDriver.findById(user.deliveryDriverId)
      .select("_id deliveryCompany phone")
      .lean();
  }
  if (!driver) {
    driver = await DeliveryCompanyDriver.findOne({ userId })
      .select("_id deliveryCompany phone")
      .lean();
  }
  if (!driver) return null;

  const companyDrivers = await DeliveryCompanyDriver.find({ deliveryCompany: driver.deliveryCompany })
    .select("_id phone")
    .lean();
  const myPhone = normalizeLocalPhone(driver.phone);
  const siblingIds = companyDrivers
    .filter((row) => normalizeLocalPhone(row.phone) === myPhone)
    .map((row) => row._id);
  return siblingIds.length ? siblingIds : [driver._id];
}

async function assertOrderDetailAccess(requester, order) {
  const role = requester.role;
  const userId = requester.id?.toString?.() || String(requester._id);

  if (role === "admin") {
    return;
  }

  if (role === "customer") {
    if (orderCustomerId(order) !== userId) {
      throw orderAccessDenied();
    }
    return;
  }

  if (role === "store" || role === "supplier") {
    const store = await Store.findOne({ owner: userId }).select("_id");
    if (!store || orderStoreId(order) !== store._id.toString()) {
      throw orderAccessDenied();
    }
    return;
  }

  if (role === "delivery_company") {
    const user = await User.findById(userId).select("deliveryCompanyId").lean();
    const companyId = user?.deliveryCompanyId;
    if (!companyId) {
      throw orderAccessDenied();
    }
    const session = await DeliverySession.findOne({
      orders: order._id,
      deliveryCompany: companyId,
    })
      .select("_id")
      .lean();
    if (!session) {
      throw orderAccessDenied();
    }
    return;
  }

  if (role === "delivery_driver") {
    const driverIds = await resolveDriverAssignmentIdsForUser(userId);
    if (!driverIds?.length) {
      throw orderAccessDenied();
    }
    const session = await DeliverySession.findOne({
      orders: order._id,
      "assignedDriver.driverId": { $in: driverIds },
    })
      .select("_id")
      .lean();
    if (!session) {
      throw orderAccessDenied();
    }
    return;
  }

  throw orderAccessDenied();
}

async function getOrderDetail(requester, orderId) {
  const order = await Order.findById(orderId)
    .select(ORDER_LIST_SELECT)
    .populate("customer", "name phone email")
    .populate("store", "name phone region owner")
    .lean();

  if (!order) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  await assertOrderDetailAccess(requester, order);

  return order;
}

async function applyConfirmFinancialEffects(order, store, session) {
  const opts = session ? { session } : {};
  let cardDeducted = false;
  let rewardPointsAwarded = 0;
  let consumedCardType = null;

  if (!store.bypassCards) {
    const consumed = await storeCardInventoryService.consumeStoreCard(store._id, session);
    cardDeducted = true;
    rewardPointsAwarded = consumed.pointsValue;
    consumedCardType = consumed.cardType;
    store.cards = consumed.remainingCards;
  }

  if (rewardPointsAwarded > 0) {
    await User.findByIdAndUpdate(order.customer, { $inc: { points: rewardPointsAwarded } }, opts);
  }

  return { cardDeducted, rewardPointsAwarded, consumedCardType };
}

async function revertConfirmFinancialEffects(order, store, session, cardDeducted, rewardPointsAwarded, consumedCardType) {
  const opts = session ? { session } : {};
  const points = Number(rewardPointsAwarded) || 0;
  if (points > 0) {
    await User.findByIdAndUpdate(order.customer, { $inc: { points: -points } }, opts);
  }
  if (cardDeducted) {
    const updatedStore = await storeCardInventoryService.restoreStoreCard(
      store._id,
      { cardType: consumedCardType, pointsValue: points || 1 },
      session
    );
    if (updatedStore) store.cards = updatedStore.cards;
  }
}

async function notifyOrderPointGift(order, store, pointsAwarded) {
  const points = Number(pointsAwarded) || 0;
  if (points <= 0) return;

  try {
    await notificationService.create({
      user: order.customer,
      type: "order_point_gift",
      title: points === 1 ? "نقطة جديدة!" : "نقاط جديدة!",
      body: `تمت إضافة ${points} ${points === 1 ? "نقطة" : "نقاط"} لك من قبل ${store.name}`,
      data: {
        orderId: order._id,
        storeId: store._id,
        storeName: store.name,
        points: pointsAwarded,
      },
    });
  } catch (_) {
    /* non-critical */
  }
}

async function applyRevertConfirmSideEffects(order, store, session) {
  const points = Number(order.rewardPointsAwarded) || (order.pointsAwarded ? 1 : 0);
  if (points > 0) {
    const opts = session ? { session } : {};
    await User.findByIdAndUpdate(order.customer, { $inc: { points: -points } }, opts);
  }
  if (order.cardDeducted) {
    const updatedStore = await storeCardInventoryService.restoreStoreCard(
      store._id,
      { cardType: order.consumedCardType || null, pointsValue: points || 1 },
      session
    );
    if (updatedStore) store.cards = updatedStore.cards;
  }
}

function resolveAcceptStatus(requestedStatus) {
  return requestedStatus === "confirmed" ? "store_accepted" : requestedStatus;
}

async function updateOrderStatusCore(ownerId, orderId, status, session, options = {}) {
  if (!ALLOWED_STATUSES.includes(status)) {
    const err = new Error("حالة غير صحيحة");
    err.status = 400;
    throw err;
  }

  const storeOpts = session ? { session } : {};
  const store = await Store.findOne({ owner: ownerId }).select("_id name cards bypassCards");
  if (!store) {
    const err = new Error("غير مصرح");
    err.status = 403;
    throw err;
  }

  let orderQuery = Order.findOne({ _id: orderId, store: store._id });
  if (session) orderQuery = orderQuery.session(session);
  const orderPreview = await orderQuery;
  if (!orderPreview) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  const previousStatus = orderPreview.status;
  const targetStatus =
    status === "confirmed" ? "store_accepted" : status === "delivered" ? "delivered_to_customer" : status;

  if (!canTransition(previousStatus, targetStatus) && !canTransition(previousStatus, status)) {
    const err = new Error(`لا يمكن تغيير الحالة من "${previousStatus}" إلى "${status}"`);
    err.status = 400;
    throw err;
  }

  const updateOpts = { new: true };
  if (session) updateOpts.session = session;

  const acceptStatuses = new Set(["store_accepted", "confirmed"]);
  if (acceptStatuses.has(status) && previousStatus === "pending") {
    const { cardDeducted, rewardPointsAwarded, consumedCardType } = await applyConfirmFinancialEffects(
      orderPreview,
      store,
      session
    );
    const now = new Date();
    const isDeliveryOrder = orderPreview.deliveryMethod === DELIVERY_METHODS.DELIVERY;
    const acceptedStatus = isDeliveryOrder ? "ready_for_delivery_pickup" : "store_accepted";

    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: "pending" },
      {
        $set: {
          status: acceptedStatus,
          cardDeducted,
          pointsAwarded: rewardPointsAwarded > 0,
          rewardPointsAwarded,
          consumedCardType: consumedCardType || null,
          confirmedAt: now,
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, acceptedStatus),
        },
      },
      updateOpts
    );
    if (!order) {
      await revertConfirmFinancialEffects(
        orderPreview,
        store,
        session,
        cardDeducted,
        rewardPointsAwarded,
        consumedCardType
      );
      const err = new Error("تم تحديث الطلب بالفعل أو لم يعد في حالة انتظار");
      err.status = 409;
      throw err;
    }

    if (rewardPointsAwarded > 0) {
      await notifyOrderPointGift(order, store, rewardPointsAwarded);
      try {
        await membershipService.upgradeToMember(order.customer, store._id);
      } catch (_) {
        /* non-critical — membership upgrade should not block order confirm */
      }
    }

    const confirmTitle = isDeliveryOrder ? "تم قبول طلبك" : "تم تأكيد طلبك من المتجر";
    const confirmBody = isDeliveryOrder
      ? `قام ${store.name || "المتجر"} بقبول طلبك — بانتظار شركة التوصيل`
      : `قام ${store.name || "المتجر"} بتأكيد طلبك رقم ${order.orderNumber || ""}`.trim();

    try {
      await notificationService.create({
        user: order.customer,
        type: "order_confirmed",
        title: confirmTitle,
        body: confirmBody,
        data: {
          orderId: order._id.toString(),
          storeId: store._id.toString(),
          deliveryMethod: order.deliveryMethod || "",
        },
      });
    } catch (_) {
      /* non-critical */
    }
    const refreshedStore = await Store.findById(store._id).select("cards bypassCards");

    const pointsMessage = rewardPointsAwarded > 0
      ? ` وإهداء ${rewardPointsAwarded} ${rewardPointsAwarded === 1 ? "نقطة" : "نقاط"} للزبون`
      : "";

    return {
      message: `تم قبول الطلب${pointsMessage}`,
      order,
      cards: refreshedStore?.cards ?? store.cards,
      bypassCards: refreshedStore?.bypassCards ?? store.bypassCards,
    };
  }

  if (targetStatus === "ready_for_delivery_pickup" && ["store_accepted", "confirmed"].includes(previousStatus)) {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: previousStatus },
      {
        $set: {
          status: "ready_for_delivery_pickup",
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "ready_for_delivery_pickup"),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }
    return {
      message: "الطلب جاهز للتسليم لشركة التوصيل",
      order,
      cards: store.cards,
      bypassCards: store.bypassCards,
    };
  }

  if (targetStatus === "preparing" && ["store_accepted", "ready_for_delivery_pickup", "confirmed"].includes(previousStatus)) {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: previousStatus },
      {
        $set: {
          status: "preparing",
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "preparing"),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }
    return { message: "الطلب قيد التحضير", order, cards: store.cards, bypassCards: store.bypassCards };
  }

  // Company-delivery path: older clients may send delivered_to_driver when the
  // store hands the parcel over — treat it as delivery_handover_complete.
  if (
    (targetStatus === "delivered_to_driver" || targetStatus === "delivery_handover_complete")
    && previousStatus === "ready_for_driver_pickup"
  ) {
    if (!orderPreview.deliveryGroup) {
      const err = new Error("لا يوجد طلب توصيل مرتبط بهذا الطلب");
      err.status = 400;
      throw err;
    }

    const DeliverySession = require("../models/deliverySession");
    const sessionDoc = await DeliverySession.findById(orderPreview.deliveryGroup).select("assignedDriver status");
    if (!sessionDoc?.assignedDriver?.driverId) {
      const err = new Error("لم يُعيَّن سائق بعد — انتظر تعيين السائق من شركة التوصيل");
      err.status = 400;
      throw err;
    }

    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: "ready_for_driver_pickup" },
      {
        $set: {
          status: "delivery_handover_complete",
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "delivery_handover_complete"),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }

    await ensureStoreHandoverBillingRecorded(order._id, {
      previousStatus: "ready_for_driver_pickup",
      storeId: store._id,
      confirmedBy: ownerId,
    });

    // Session advance + notifications: updateOrderStatus → syncDeliverySessionAfterOrderUpdate
    // (syncAfterStoreHandover). Do not also fire syncOrderInSessions — it races and can
    // overwrite out_for_delivery back to driver_assigned.

    return {
      message: "تم تسليم الطلب للسائق — اكتملت مسؤولية المتجر",
      order,
      cards: store.cards,
      bypassCards: store.bypassCards,
    };
  }

  const handToDriverFrom = new Set(["preparing", "store_accepted", "confirmed"]);
  if (targetStatus === "delivered_to_driver" && handToDriverFrom.has(previousStatus)) {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: previousStatus },
      {
        $set: {
          status: "delivered_to_driver",
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "delivered_to_driver"),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }

    return { message: "تم تسليم الطلب للسائق", order, cards: store.cards, bypassCards: store.bypassCards };
  }

  if (
    (targetStatus === "delivered_to_customer" || status === "delivered") &&
    [
      "delivered_to_driver",
      "delivery_handover_complete",
      "preparing",
      "store_accepted",
      "ready_for_delivery_pickup",
      "confirmed",
    ].includes(previousStatus)
  ) {
    const now = new Date();
    const deleteAfter = new Date(now.getTime() + HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: previousStatus },
      {
        $set: {
          status: "delivered_to_customer",
          completedAt: now,
          deleteAfter,
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "delivered_to_customer"),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("لا يمكن تسليم الطلب في حالته الحالية");
      err.status = 400;
      throw err;
    }

    try {
      await notificationService.create({
        user: order.customer,
        type: "order_delivered",
        title: "تم استلام طلبك",
        body: `قام ${store.name || "المتجر"} بتسليم طلبك رقم ${order.orderNumber || ""}`.trim(),
        data: {
          orderId: order._id.toString(),
          storeId: store._id.toString(),
          deliveryMethod: order.deliveryMethod || "",
        },
      });
    } catch (_) {
      /* non-critical */
    }

    return {
      message: "تم تسليم الطلب للزبون",
      order,
      archived: true,
      cards: store.cards,
      bypassCards: store.bypassCards,
    };
  }

  if (status === "rejected" && previousStatus === "pending") {
    const reason = cleanString(options.rejectionReason, { field: "rejectionReason", max: 500 }) || "";
    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: "pending" },
      {
        $set: {
          status: "rejected",
          rejectionReason: reason,
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "rejected", reason),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }

    await restoreOrderItemsToCart(order.customer, order.items, order.store, session);

    try {
      await notificationService.create({
        user: order.customer,
        type: "order_rejected",
        title: "تم رفض طلبك من المتجر",
        body: reason || `قام ${store.name || "المتجر"} برفض طلبك`,
        data: { orderId: order._id.toString(), rejectionReason: reason },
      });
    } catch (_) {
      /* non-critical */
    }

    return {
      message: "تم رفض الطلب",
      order,
      deleted: true,
      cards: store.cards,
      bypassCards: store.bypassCards,
    };
  }

  if (["rejected", "cancelled"].includes(status) && ["store_accepted", "ready_for_delivery_pickup", "ready_for_driver_pickup", "confirmed", "preparing"].includes(previousStatus)) {
    const orderBefore = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: previousStatus },
      {
        $set: {
          status,
          cardDeducted: false,
          pointsAwarded: false,
          rewardPointsAwarded: 0,
          consumedCardType: null,
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, status),
        },
      },
      { new: false, ...(session ? { session } : {}) }
    );
    if (!orderBefore) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }

    await applyRevertConfirmSideEffects(orderBefore, store, session);
    const order = await Order.findById(orderId);
    const refreshedStore = await Store.findById(store._id).select("cards bypassCards");

    return {
      message: "تم تحديث الحالة",
      order,
      cards: refreshedStore?.cards ?? store.cards,
      bypassCards: refreshedStore?.bypassCards ?? store.bypassCards,
    };
  }

  if (status === "cancelled" && previousStatus === "pending") {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: "pending" },
      {
        $set: {
          status: "cancelled",
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "cancelled"),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }

    await restoreOrderItemsToCart(order.customer, order.items, order.store, session);

    return {
      message: "تم تحديث الحالة",
      order,
      cards: store.cards,
      bypassCards: store.bypassCards,
    };
  }

  if (status === "completed_off_platform" && ["store_accepted", "ready_for_delivery_pickup", "confirmed"].includes(previousStatus)) {
    const now = new Date();
    const deleteAfter = new Date(now.getTime() + HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const order = await Order.findOneAndUpdate(
      { _id: orderId, store: store._id, status: previousStatus },
      {
        $set: {
          status: "completed_off_platform",
          completedAt: now,
          deleteAfter,
          statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "completed_off_platform"),
        },
      },
      updateOpts
    );
    if (!order) {
      const err = new Error("تم تحديث الطلب بالفعل");
      err.status = 409;
      throw err;
    }

    return {
      message: "تم تحديث الحالة",
      order,
      cards: store.cards,
      bypassCards: store.bypassCards,
    };
  }

  const err = new Error(`لا يمكن تغيير الحالة من "${previousStatus}" إلى "${status}"`);
  err.status = 400;
  throw err;
}

/** Record store → delivery-company handover for billing; retry once on transient failure. */
async function ensureStoreHandoverBillingRecorded(orderId, handoverOptions = {}) {
  const deliveryCompanyHandoverService = require("./deliveryCompanyHandover.service");
  const { safeLog } = require("../utils/logSanitize.util");
  let lastResult = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      lastResult = await deliveryCompanyHandoverService.recordStoreHandoverToDeliveryCompany(
        orderId,
        handoverOptions,
      );
      if (
        lastResult?.recorded
        || lastResult?.billingApplied
        || lastResult?.billingRecovered
        || lastResult?.reason === "already_recorded"
      ) {
        return lastResult;
      }
      if (["invalid_previous_status", "not_handover_status", "no_delivery_company"].includes(lastResult?.reason)) {
        return lastResult;
      }
    } catch (err) {
      safeLog("warn", "delivery_company_handover_count_failed", {
        orderId: String(orderId),
        attempt,
        message: err?.message,
      });
    }
  }

  if (lastResult && !lastResult.billingApplied && !lastResult.billingRecovered) {
    safeLog("warn", "delivery_company_handover_billing_unresolved", {
      orderId: String(orderId),
      reason: lastResult?.reason || "unknown",
    });
  }
  return lastResult;
}

/** Sync delivery session after order status commit — routes handoff vs generic sync. */
async function syncDeliverySessionAfterOrderUpdate(order) {
  if (!order?._id) return;
  const deliverySessionService = require("./deliverySession.service");
  const status = order.status;
  const isHandover =
    status === "delivery_handover_complete" || status === "delivered_to_driver";

  try {
    if (isHandover) {
      await deliverySessionService.syncAfterStoreHandover(order);
    } else {
      await deliverySessionService.syncOrderInSessions(order._id);
    }
  } catch (err) {
    const { safeLog } = require("../utils/logSanitize.util");
    safeLog("error", isHandover ? "delivery_handover_sync_failed" : "delivery_session_sync_failed", {
      orderId: String(order._id),
      status,
      message: err?.message,
    });
  }
}

async function updateOrderStatus(ownerId, orderId, status, options = {}) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await updateOrderStatusCore(ownerId, orderId, status, session, options);
    await session.commitTransaction();
    if (result?.order?._id) {
      await syncDeliverySessionAfterOrderUpdate(result.order);
    }
    return result;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (isTransactionUnsupported(err)) {
      const result = await updateOrderStatusCore(ownerId, orderId, status, null, options);
      if (result?.order?._id) {
        await syncDeliverySessionAfterOrderUpdate(result.order);
      }
      return result;
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function updateOrderStoreNotes(ownerId, orderId, storeNotes) {
  const store = await Store.findOne({ owner: ownerId }).select("_id");
  if (!store) {
    const err = new Error("غير مصرح");
    err.status = 403;
    throw err;
  }

  const notes = cleanString(storeNotes, { field: "storeNotes", max: 1000 }) || "";
  const order = await Order.findOneAndUpdate(
    { _id: orderId, store: store._id },
    { $set: { storeNotes: notes } },
    { new: true }
  ).select(ORDER_LIST_SELECT);

  if (!order) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  return order;
}

async function setStoreBypassCards(adminId, storeId, bypass) {
  if (typeof bypass !== "boolean") {
    const err = new Error("يجب إرسال bypass: true أو false");
    err.status = 400;
    throw err;
  }

  const store = await Store.findByIdAndUpdate(
    storeId,
    { bypassCards: bypass },
    { new: true }
  ).select("name bypassCards cards");

  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  return {
    message: bypass
      ? `✅ تم السماح لمتجر "${store.name}" بالعمل بدون كروت`
      : `🔒 تم إلغاء الاستثناء لمتجر "${store.name}"`,
    store,
  };
}

async function cancelOrderByCustomer(customerId, orderId) {
  const preview = await Order.findOne({ _id: orderId, customer: customerId }).select("status paymentMethod");
  if (!preview) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  const digitalMethods = new Set(["bank", "palpay", "jawwal_pay"]);
  if (digitalMethods.has(normalizePaymentMethod(preview.paymentMethod))) {
    const err = new Error("لا يمكن إلغاء الطلب بعد الدفع الإلكتروني");
    err.status = 400;
    throw err;
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const order = await Order.findOneAndUpdate(
      { _id: orderId, customer: customerId, status: { $in: ["pending", "modification_requested"] } },
      {
        $set: {
          status: "cancelled",
          statusTimeline: [{ status: "cancelled", at: new Date() }],
        },
      },
      { new: true, session }
    );

    if (!order) {
      await session.abortTransaction().catch(() => {});
      const existing = await Order.findOne({ _id: orderId, customer: customerId });
      if (!existing) {
        const err = new Error("الطلب غير موجود");
        err.status = 404;
        throw err;
      }
      const err = new Error("لا يمكن إلغاء هذا الطلب في حالته الحالية");
      err.status = 400;
      throw err;
    }

    await restoreStockForOrderItems(order.items, session);
    await session.commitTransaction();
    return order;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (isTransactionUnsupported(err)) {
      return cancelOrderByCustomerFallback(customerId, orderId);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function cancelOrderByCustomerFallback(customerId, orderId) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, customer: customerId, status: { $in: ["pending", "modification_requested"] } },
    { $set: { status: "cancelled" } },
    { new: true }
  );

  if (!order) {
    const existing = await Order.findOne({ _id: orderId, customer: customerId });
    if (!existing) {
      const err = new Error("الطلب غير موجود");
      err.status = 404;
      throw err;
    }
    const err = new Error("لا يمكن إلغاء هذا الطلب في حالته الحالية");
    err.status = 400;
    throw err;
  }

  await restoreStockForOrderItems(order.items, null);
  return order;
}

async function handOrderToDriver(ownerId, orderId) {
  const store = await Store.findOne({ owner: ownerId }).select("_id name");
  if (!store) {
    const err = new Error("غير مصرح");
    err.status = 403;
    throw err;
  }

  const orderPreview = await Order.findOne({ _id: orderId, store: store._id });
  if (!orderPreview) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  if (orderPreview.status !== "ready_for_driver_pickup") {
    const err = new Error("لا يمكن تسليم الطلب للسائق في حالته الحالية");
    err.status = 400;
    throw err;
  }

  if (!orderPreview.deliveryGroup) {
    const err = new Error("لا يوجد طلب توصيل مرتبط بهذا الطلب");
    err.status = 400;
    throw err;
  }

  const DeliverySession = require("../models/deliverySession");
  const session = await DeliverySession.findById(orderPreview.deliveryGroup).select("assignedDriver status");
  if (!session?.assignedDriver?.driverId) {
    const err = new Error("لم يُعيَّن سائق بعد — انتظر تعيين السائق من شركة التوصيل");
    err.status = 400;
    throw err;
  }

  const order = await Order.findOneAndUpdate(
    { _id: orderId, store: store._id, status: "ready_for_driver_pickup" },
    {
      $set: {
        status: "delivery_handover_complete",
        statusTimeline: pushTimelineUpdate(orderPreview.statusTimeline, "delivery_handover_complete"),
      },
    },
    { new: true }
  );

  if (!order) {
    const err = new Error("تم تحديث الطلب بالفعل");
    err.status = 409;
    throw err;
  }

  await ensureStoreHandoverBillingRecorded(order._id, {
    previousStatus: "ready_for_driver_pickup",
    storeId: store._id,
    confirmedBy: ownerId,
  });

  await syncDeliverySessionAfterOrderUpdate(order);

  return {
    message: "تم تسليم الطلب للسائق — اكتملت مسؤولية المتجر",
    order,
    storeName: store.name,
  };
}

module.exports = {
  restoreOrderItemsToCart,
  getStorePendingCount,
  getStoreOrders,
  getCustomerOrders,
  getCustomerActiveOrders,
  getCustomerOrderHistory,
  getStoreOrderHistory,
  getStoreInvoices,
  getAdminOrderHistory,
  getAdminOrderById,
  getOrderDetail,
  updateOrderStatus,
  updateOrderStoreNotes,
  setStoreBypassCards,
  cancelOrderByCustomer,
  handOrderToDriver,
  HISTORY_RETENTION_DAYS,
};
