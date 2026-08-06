const Store = require("../models/store");
const cartService = require("./cart.service");
const orderService = require("./order.service");
const deliverySessionService = require("./deliverySession.service");
const {
  formatOrderResponse,
  enrichOrdersWithDeliverySession,
  enrichSingleOrder,
  getStoreStatusLabel,
} = require("../utils/orderPresentation.util");
const {
  ORDER_STATUSES,
  DELIVERY_METHODS,
  toLegacyStatus,
} = require("../constants/marketplaceOrder.constants");
const { assertNoMongoOperators, requireObjectId, cleanString } = require("../utils/inputSecurity.util");

/**
 * Marketplace order layer — wraps existing cart/order services.
 * Does not modify points/rewards logic; confirm/reject delegate to order.service.
 */

async function createOrder(user, body = {}) {
  assertNoMongoOperators(body, "order");
  const storeId = requireObjectId(body.storeId, "storeId");

  const store = await Store.findById(storeId).select("_id name isActive").lean();
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  const userRole = user.role || "customer";
  const result = await cartService.confirmStoreContainer(user.id, storeId, body, userRole);
  const order = await orderService.getOrderDetail(user, result.order.id);
  const formattedOrder = formatOrderResponse(order);

  let deliverySession = null;
  if (
    formattedOrder.deliveryMethod === DELIVERY_METHODS.DELIVERY &&
    body.companyId
  ) {
    try {
      deliverySession = await deliverySessionService.confirmSession(user.id, {
        companyId: body.companyId,
        orderIds: [formattedOrder.id],
        deliveryFee: body.deliveryFee,
        deliveryArea: body.deliveryArea,
        paymentMethod: body.paymentMethod,
        paymentProof: body.paymentProof || body.paymentProofImage,
        paymentNotes: body.paymentNotes,
        transferInformation: body.transferInformation,
        sessionId: body.deliverySessionId,
      });
    } catch (err) {
      err.deliverySessionFailed = true;
      throw err;
    }
  }

  return {
    message: result.message,
    verificationCode: result.verificationCode,
    order: formattedOrder,
    deliverySession,
  };
}

async function getCustomerOrders(customerId) {
  const orders = await orderService.getCustomerOrders(customerId);
  return enrichOrdersWithDeliverySession(orders);
}

async function getCustomerOrderHistory(customerId) {
  const orders = await orderService.getCustomerOrderHistory(customerId);
  return enrichOrdersWithDeliverySession(orders);
}

async function getCustomerOrderDetail(user, orderId) {
  const order = await orderService.getOrderDetail(user, orderId);
  return enrichSingleOrder(order);
}

async function getStoreOrders(ownerId) {
  const data = await orderService.getStoreOrders(ownerId);
  const enriched = await enrichOrdersWithDeliverySession(data.orders);

  return {
    ...data,
    orders: enriched.map((order) => {
      const hasDriver = Boolean(
        order.deliverySession?.assignedDriver?.driverId
        || order.deliverySession?.assignedDriver?.name
        || order.deliveryDriverName
      );
      return {
        ...order,
        canHandToDriver: order.legacyStatus === "ready_for_driver_pickup" && hasDriver,
        storeStatusLabel: getStoreStatusLabel(order.legacyStatus),
      };
    }),
  };
}

async function getStoreOrderDetail(user, orderId) {
  const order = await orderService.getOrderDetail(user, orderId);
  return enrichSingleOrder(order, { forStore: true });
}

async function handOrderToDriver(ownerId, orderId) {
  const result = await orderService.handOrderToDriver(ownerId, orderId);
  if (result.order) {
    const user = { id: ownerId, role: "store" };
    const order = await orderService.getOrderDetail(user, orderId);
    return {
      ...result,
      order: await enrichSingleOrder(order, { forStore: true }),
    };
  }
  return result;
}

async function confirmOrder(ownerId, orderId) {
  const legacyStatus = toLegacyStatus(ORDER_STATUSES.CONFIRMED);
  const result = await orderService.updateOrderStatus(ownerId, orderId, legacyStatus);
  if (result.order) {
    return {
      ...result,
      order: formatOrderResponse(result.order),
    };
  }
  return result;
}

async function rejectOrder(ownerId, orderId, body = {}) {
  assertNoMongoOperators(body, "order");
  const rejectionReason = cleanString(body.rejectionReason, { field: "rejectionReason", max: 500 }) || "";
  const legacyStatus = toLegacyStatus(ORDER_STATUSES.REJECTED);
  const result = await orderService.updateOrderStatus(ownerId, orderId, legacyStatus, {
    rejectionReason,
  });
  if (result.order) {
    return {
      ...result,
      order: formatOrderResponse(result.order),
    };
  }
  return result;
}

async function cancelOrder(customerId, orderId) {
  const order = await orderService.cancelOrderByCustomer(customerId, orderId);
  return formatOrderResponse(order);
}

module.exports = {
  createOrder,
  getCustomerOrders,
  getCustomerOrderHistory,
  getCustomerOrderDetail,
  getStoreOrders,
  getStoreOrderDetail,
  confirmOrder,
  rejectOrder,
  cancelOrder,
  handOrderToDriver,
};
