const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const deliveryController = require("../controllers/delivery.controller");
const deliverySessionController = require("../controllers/deliverySession.controller");
const deliveryCompanyPortalController = require("../controllers/deliveryCompanyPortal.controller");
const User = require("../models/user");

const router = express.Router();

async function attachUserDoc(req, res, next) {
  try {
    if (req.user?.id && !req.userDoc) {
      req.userDoc = await User.findById(req.user.id)
        .select("name phone role deliveryCompanyId")
        .lean();
      if (req.userDoc) {
        req.userDoc._id = req.userDoc._id || req.user.id;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Customer delivery sessions ──
router.use("/sessions", authMiddleware);
router.get("/sessions/active", deliverySessionController.getActiveSession);
router.get("/sessions", deliverySessionController.listSessions);
router.get("/sessions/:sessionId", deliverySessionController.getSession);
router.post("/sessions/calculate-fee", deliverySessionController.calculateFee);
router.post("/sessions/confirm", deliverySessionController.confirmSession);
router.post("/sessions/:sessionId/cancel", deliverySessionController.cancelSession);

// Legacy alias
router.post("/trips", authMiddleware, deliveryController.createTrip);

// ── Delivery company portal ──
router.use("/company", authMiddleware, roleMiddleware(["delivery_company"]), attachUserDoc);
router.get("/company/dashboard/stats", deliveryCompanyPortalController.getDashboardStats);
router.get("/company/requests", deliveryCompanyPortalController.listRequests);
router.get("/company/requests/:requestId", deliveryCompanyPortalController.getRequest);
router.patch("/company/requests/:requestId/assign-driver", deliveryCompanyPortalController.assignDriver);
router.patch("/company/requests/:requestId/reject", deliveryCompanyPortalController.rejectRequest);
router.patch("/company/requests/:requestId/out-for-delivery", deliveryCompanyPortalController.markOutForDelivery);
router.patch("/company/requests/:requestId/complete", deliveryCompanyPortalController.completeRequest);
router.get("/company/profile", deliveryCompanyPortalController.getProfile);
router.put("/company/profile", deliveryCompanyPortalController.updateProfile);
router.get("/company/payment-settings", deliveryCompanyPortalController.getPaymentSettings);
router.patch("/company/payment-methods", deliveryCompanyPortalController.updatePaymentMethods);
router.get("/company/payment-accounts", deliveryCompanyPortalController.listPaymentAccounts);
router.post("/company/payment-accounts", deliveryCompanyPortalController.createPaymentAccount);
router.put("/company/payment-accounts/:accountId", deliveryCompanyPortalController.updatePaymentAccount);
router.delete("/company/payment-accounts/:accountId", deliveryCompanyPortalController.deletePaymentAccount);
router.get("/company/regions", deliveryCompanyPortalController.getRegions);
router.put("/company/regions", deliveryCompanyPortalController.updateRegions);
router.get("/company/pricing", deliveryCompanyPortalController.getPricing);
router.put("/company/pricing", deliveryCompanyPortalController.updatePricing);
router.get("/company/drivers", deliveryCompanyPortalController.listDrivers);
router.post("/company/drivers", deliveryCompanyPortalController.createDriver);
router.get("/company/drivers/:driverId", deliveryCompanyPortalController.getDriver);
router.put("/company/drivers/:driverId", deliveryCompanyPortalController.updateDriver);
router.delete("/company/drivers/:driverId", deliveryCompanyPortalController.deleteDriver);

module.exports = router;
