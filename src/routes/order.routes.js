const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const orderService = require("../services/order.service");
const marketplaceOrderController = require("../controllers/marketplaceOrder.controller");
const auditService = require("../services/audit.service");
const { requireObjectId, assertNoMongoOperators } = require("../utils/inputSecurity.util");

router.use(authMiddleware);

/** Marketplace order APIs (canonical responses, one order per store). */
router.post("/", roleMiddleware.customer, marketplaceOrderController.createOrder);

function handleServiceError(res, err) {
  const status = err.status || 500;
  const body = { message: err.message || "حدث خطأ في الخادم" };
  if (err.noCards) body.noCards = true;
  return res.status(status).json(body);
}

function parseHistoryFilters(query) {
  return {
    q: query.q || query.search || "",
    status: query.status || "",
    from: query.from || query.dateFrom || "",
    to: query.to || query.dateTo || "",
    storeId: query.storeId || "",
    customerId: query.customerId || "",
    limit: query.limit || "",
    activeOnly: query.activeOnly === "true",
    historyOnly: query.historyOnly !== "false",
  };
}

router.get("/store/pending-count", roleMiddleware.business, async (req, res) => {
  try {
    const stats = await orderService.getStorePendingCount(req.user.id);
    res.json(stats);
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.get("/store", roleMiddleware.business, marketplaceOrderController.getStoreOrders);

router.get("/store/history", roleMiddleware.business, async (req, res) => {
  try {
    const data = await orderService.getStoreOrderHistory(req.user.id, parseHistoryFilters(req.query));
    res.json(data);
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.get("/store/invoices", roleMiddleware.business, async (req, res) => {
  try {
    const data = await orderService.getStoreInvoices(req.user.id, parseHistoryFilters(req.query));
    res.json(data);
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.get("/my", roleMiddleware.customer, marketplaceOrderController.getCustomerOrders);

router.get("/my/history", roleMiddleware.customer, marketplaceOrderController.getCustomerOrderHistory);

router.get("/admin/history", roleMiddleware.admin, async (req, res) => {
  try {
    const data = await orderService.getAdminOrderHistory(parseHistoryFilters(req.query));
    res.json(data);
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.get("/:id", marketplaceOrderController.getOrderDetail);

router.patch("/:id/confirm", roleMiddleware.business, marketplaceOrderController.confirmOrder);

router.patch("/:id/reject", roleMiddleware.business, marketplaceOrderController.rejectOrder);

router.patch("/:id/hand-to-driver", roleMiddleware.business, marketplaceOrderController.handOrderToDriver);

router.post("/:id/request-modification", roleMiddleware.business, marketplaceOrderController.requestModification);

router.post("/:id/resolve-modification", roleMiddleware.customer, marketplaceOrderController.resolveModification);

router.post("/:id/preview-replacement", roleMiddleware.customer, marketplaceOrderController.previewReplacement);

router.patch("/:id/status", roleMiddleware.business, async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "order");
    const orderId = requireObjectId(req.params.id, "id");
    const result = await orderService.updateOrderStatus(
      req.user.id,
      orderId,
      req.body.status,
      { rejectionReason: req.body.rejectionReason }
    );
    if (["store_accepted", "ready_for_delivery_pickup", "ready_for_driver_pickup", "delivery_handover_complete", "confirmed", "rejected", "cancelled", "preparing", "delivered_to_driver", "delivered_to_customer", "delivered"].includes(req.body.status)) {
      await auditService.logSensitiveOperation(req, {
        action: `تحديث حالة طلب — ${req.body.status}`,
        details: `طلب ${orderId}`,
        metadata: { orderId: String(orderId), status: req.body.status },
      });
    }
    if (result.deleted) {
      return res.json({ message: result.message, deleted: true });
    }
    res.json(result);
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.patch("/:id/store-notes", roleMiddleware.business, async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "order");
    const orderId = requireObjectId(req.params.id, "id");
    const order = await orderService.updateOrderStoreNotes(
      req.user.id,
      orderId,
      req.body.storeNotes
    );
    res.json({ message: "تم حفظ ملاحظات المتجر", order });
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.patch("/admin/bypass/:storeId", roleMiddleware.admin, async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "order");
    const storeId = requireObjectId(req.params.storeId, "storeId");
    if (typeof req.body.bypass !== "boolean") {
      return res.status(400).json({ message: "يجب إرسال bypass: true أو false" });
    }
    const result = await orderService.setStoreBypassCards(
      req.user.id,
      storeId,
      req.body.bypass
    );
    res.json(result);
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.patch("/:id/cancel", roleMiddleware.customer, marketplaceOrderController.cancelOrder);

module.exports = router;
