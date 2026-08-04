const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const verifiedMiddleware = require("../middleware/verified.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const rateLimit = require("../middleware/rateLimit.middleware");
const { requireBodyStoreOwnership } = require("../middleware/ownership.middleware");

const {
    createPromoCode,
    redeemCode,
    redeemActivationCode,
    getCodeStats
} = require("../controllers/promo-code.controller");

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: "محاولات استخدام أكواد كثيرة — يرجى الانتظار",
  keyFn: (req) => `promo-redeem:${req.user?.id || req.ip}`,
});

router.post(
  "/create",
  authMiddleware,
  roleMiddleware.businessOrAdmin,
  requireBodyStoreOwnership,
  createPromoCode
);

router.post("/redeem", authMiddleware, verifiedMiddleware, redeemLimiter, redeemCode);
router.post("/redeem-activation", authMiddleware, verifiedMiddleware, redeemLimiter, redeemActivationCode);

router.get("/stats", authMiddleware, roleMiddleware.businessOrAdmin, getCodeStats);

module.exports = router;
