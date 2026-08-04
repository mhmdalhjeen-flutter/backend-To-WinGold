const express = require("express");
const router = express.Router();
const verifiedMiddleware = require("../middleware/verified.middleware");
const rateLimit = require("../middleware/rateLimit.middleware");
const cartService = require("../services/cart.service");
const auditService = require("../services/audit.service");
const { safeLog } = require("../utils/logSanitize.util");
const { cartCache } = require("../middleware/responseCache.middleware");

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "محاولات طلب كثيرة — يرجى الانتظار",
  keyFn: (req) => `checkout:${req.user?.id || req.ip}`,
});

function handleServiceError(res, err) {
  safeLog("error", "cart_service_error", { message: err.message });
  const status = err.status || 500;
  const body = { message: err.message || "حدث خطأ في الخادم" };
  if (err.noCards) body.noCards = true;
  return res.status(status).json(body);
}

router.get("/", cartCache, async (req, res) => {
  try {
    const cart = await cartService.getCartForUser(req.user.id);
    res.json(cart);
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.post("/add", verifiedMiddleware, async (req, res) => {
  try {
    const result = await cartService.addToCart(req.user, req.body);
    res.json({ message: "تمت إضافة العنصر إلى السلة.", ...result });
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.post("/containers/:storeId/confirm", verifiedMiddleware, checkoutLimiter, async (req, res) => {
  try {
    const result = await cartService.confirmStoreContainer(
      req.user.id,
      req.params.storeId,
      req.body,
      req.user.role
    );
    await auditService.logSensitiveOperation(req, {
      action: "تأكيد طلب متجر (container confirm)",
      details: `متجر ${req.params.storeId}`,
      metadata: { storeId: String(req.params.storeId), orderId: String(result.order?.id) },
    });
    res.json(result);
  } catch (err) {
    if (err.code === "DUPLICATE_ORDER") {
      await auditService.logSensitiveOperation(req, {
        action: "محاولة تأكيد طلب مكررة",
        details: err.message,
        success: false,
      });
    }
    handleServiceError(res, err);
  }
});

router.patch("/update", verifiedMiddleware, async (req, res) => {
  try {
    const cart = await cartService.updateCartItem(req.user.id, req.body);
    res.json({ message: "تم تحديث الكمية", ...cart });
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.delete("/remove", verifiedMiddleware, async (req, res) => {
  try {
    const cart = await cartService.removeFromCart(req.user.id, req.body);
    res.json({ message: "تم حذف العنصر من السلة", ...cart });
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.delete("/clear", verifiedMiddleware, async (req, res) => {
  try {
    const cart = await cartService.clearCart(req.user.id);
    res.json({ message: "تم تفريغ السلة", ...cart });
  } catch (err) {
    handleServiceError(res, err);
  }
});

router.post("/checkout", verifiedMiddleware, checkoutLimiter, async (req, res) => {
  try {
    const result = await cartService.checkout(req.user.id, req.user.role);
    await auditService.logSensitiveOperation(req, {
      action: "إتمام طلب (checkout)",
      details: `${result.ordersCount} طلب(ات) — إجمالي ${result.orders?.length || 0} متجر`,
      metadata: {
        ordersCount: result.ordersCount,
        orderIds: (result.orders || []).map((o) => String(o.id)),
      },
    });
    res.json({
      message: "تم إرسال طلبك — بانتظار تأكيد صاحب المحل",
      ...result,
    });
  } catch (err) {
    if (err.code === "DUPLICATE_ORDER") {
      await auditService.logSensitiveOperation(req, {
        action: "محاولة checkout مكررة",
        details: err.message,
        success: false,
      });
    }
    handleServiceError(res, err);
  }
});

module.exports = router;
