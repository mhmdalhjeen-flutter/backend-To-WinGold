const Store = require("../models/store");
const cartService = require("./cart.service");
const orderService = require("./order.service");
const { formatOrderResponse, formatOrderList } = require("../utils/orderPresentation.util");
const {
  ORDER_STATUSES,
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

  return {
    message: result.message,
    verificationCode: result.verificationCode,
    order: formatOrderResponse(order),
  };
}

async function getCustomerOrders(customerId) {
  const orders = await orderService.getCustomerOrders(customerId);
  return formatOrderList(orders);
}

async function getCustomerOrderHistory(customerId) {
  const orders = await orderService.getCustomerOrderHistory(customerId);
  return formatOrderList(orders);
}

async function getCustomerOrderDetail(user, orderId) {
  const order = await orderService.getOrderDetail(user, orderId);
  return formatOrderResponse(order);
}

async function getStoreOrders(ownerId) {
  const data = await orderService.getStoreOrders(ownerId);
  return {
    ...data,
    orders: formatOrderList(data.orders),
  };
}

async function getStoreOrderDetail(user, orderId) {
  const order = await orderService.getOrderDetail(user, orderId);
  return formatOrderResponse(order);
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
};
