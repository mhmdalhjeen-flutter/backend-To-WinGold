const marketplaceOrderService = require("../services/marketplaceOrder.service");
const auditService = require("../services/audit.service");
const { requireObjectId, assertNoMongoOperators } = require("../utils/inputSecurity.util");

function handleError(res, err) {
  const status = err.status || 500;
  const body = { message: err.message || "حدث خطأ في الخادم" };
  if (err.noCards) body.noCards = true;
  return res.status(status).json(body);
}

exports.createOrder = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "order");
    const result = await marketplaceOrderService.createOrder(req.user, req.body);
    await auditService.logSensitiveOperation(req, {
      action: "إنشاء طلب متجر",
      details: `متجر ${req.body.storeId}`,
      metadata: { storeId: String(req.body.storeId), orderId: String(result.order?.id || "") },
    });
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.getCustomerOrders = async (req, res) => {
  try {
    const orders = await marketplaceOrderService.getCustomerOrders(req.user.id);
    res.json({ orders });
  } catch (err) {
    handleError(res, err);
  }
};

exports.getCustomerOrderHistory = async (req, res) => {
  try {
    const orders = await marketplaceOrderService.getCustomerOrderHistory(req.user.id);
    res.json({ orders });
  } catch (err) {
    handleError(res, err);
  }
};

exports.getOrderDetail = async (req, res) => {
  try {
    const orderId = requireObjectId(req.params.id, "id");
    const order = await marketplaceOrderService.getCustomerOrderDetail(req.user, orderId);
    res.json({ order });
  } catch (err) {
    handleError(res, err);
  }
};

exports.getStoreOrders = async (req, res) => {
  try {
    const data = await marketplaceOrderService.getStoreOrders(req.user.id);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
};

exports.getStoreOrderDetail = async (req, res) => {
  try {
    const orderId = requireObjectId(req.params.id, "id");
    const order = await marketplaceOrderService.getStoreOrderDetail(req.user, orderId);
    res.json({ order });
  } catch (err) {
    handleError(res, err);
  }
};

exports.confirmOrder = async (req, res) => {
  try {
    const orderId = requireObjectId(req.params.id, "id");
    const result = await marketplaceOrderService.confirmOrder(req.user.id, orderId);
    await auditService.logSensitiveOperation(req, {
      action: "تأكيد طلب متجر",
      details: `طلب ${orderId}`,
      metadata: { orderId: String(orderId), status: "confirmed" },
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.rejectOrder = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "order");
    const orderId = requireObjectId(req.params.id, "id");
    const result = await marketplaceOrderService.rejectOrder(req.user.id, orderId, req.body);
    await auditService.logSensitiveOperation(req, {
      action: "رفض طلب متجر",
      details: `طلب ${orderId}`,
      metadata: { orderId: String(orderId), status: "rejected" },
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
};

exports.cancelOrder = async (req, res) => {
  try {
    const orderId = requireObjectId(req.params.id, "id");
    const order = await marketplaceOrderService.cancelOrder(req.user.id, orderId);
    await auditService.logSensitiveOperation(req, {
      action: "إلغاء طلب من الزبون",
      details: `طلب ${orderId}`,
      metadata: { orderId: String(orderId) },
    });
    res.json({ message: "تم إلغاء الطلب", order });
  } catch (err) {
    handleError(res, err);
  }
};
