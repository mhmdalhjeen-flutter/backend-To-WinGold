const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const deliveryController = require("../controllers/delivery.controller");
const deliverySessionController = require("../controllers/deliverySession.controller");
const deliveryCompanyPortalController = require("../controllers/deliveryCompanyPortal.controller");
const deliveryCompanyBillingController = require("../controllers/deliveryCompanyBilling.controller");
const deliveryDriverController = require("../controllers/deliveryDriver.controller");
const { requireDeliveryBillingAccess } = require("../middleware/deliveryBilling.middleware");
const User = require("../models/user");

const router = express.Router();

async function attachUserDoc(req, res, next) {
  try {
    if (req.user?.id && !req.userDoc) {
      req.userDoc = await User.findById(req.user.id)
        .select("name phone role deliveryCompanyId deliveryDriverId")
        .lean();
      if (req.userDoc) {
        req.userDoc._id = req.userDoc._id || req.user.id;
        // Mirror delivery refs onto req.user so services that expect them work.
        req.user.deliveryCompanyId = req.userDoc.deliveryCompanyId || null;
        req.user.deliveryDriverId = req.userDoc.deliveryDriverId || null;
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
router.use("/company", authMiddleware, roleMiddleware(["delivery_company"]), attachUserDoc, requireDeliveryBillingAccess);
router.get("/company/billing", deliveryCompanyBillingController.getMyBillingStatus);
router.get("/company/billing/payment-methods", deliveryCompanyBillingController.getBillingPaymentMethods);
router.post("/company/billing/payment", deliveryCompanyBillingController.submitBillingPayment);
router.get("/company/billing/history", deliveryCompanyBillingController.getBillingHistory);
router.get("/company/dashboard/stats", deliveryCompanyPortalController.getDashboardStats);
router.get("/company/pending-handovers", deliveryCompanyPortalController.listPendingHandovers);
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
router.get("/company/driver-registration-password", deliveryCompanyPortalController.getDriverRegistrationPasswordStatus);
router.put("/company/driver-registration-password", deliveryCompanyPortalController.setDriverRegistrationPassword);
router.get("/company/proofs", deliveryCompanyPortalController.listProofs);
router.get("/company/proofs/filter-options", deliveryCompanyPortalController.listProofFilterOptions);
router.get("/company/proofs/:proofId", deliveryCompanyPortalController.getProof);

// ── Driver portal ──
router.use("/driver", authMiddleware, roleMiddleware(["delivery_driver"]), attachUserDoc);
router.get("/driver/assignments", deliveryDriverController.listAssignments);
router.get("/driver/assignments/history", deliveryDriverController.listHistory);
router.get("/driver/pending-confirmations", deliveryDriverController.listPendingConfirmations);
router.get("/driver/assignments/:assignmentId", deliveryDriverController.getAssignment);
router.patch("/driver/assignments/:assignmentId/complete", deliveryDriverController.completeDelivery);
router.post("/driver/assignments/sync", deliveryDriverController.syncOffline);

module.exports = router;
