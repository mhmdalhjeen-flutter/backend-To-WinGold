const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const deliveryController = require("../controllers/delivery.controller");
const deliverySessionController = require("../controllers/deliverySession.controller");
const deliveryDriverController = require("../controllers/deliveryDriver.controller");
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

// ── Driver operations ──
router.use("/driver", authMiddleware, roleMiddleware(["driver"]), attachUserDoc);
router.get("/driver/dashboard/stats", deliveryDriverController.getDashboardStats);
router.get("/driver/trips", deliveryDriverController.listTrips);
router.get("/driver/trips/:tripId", deliveryDriverController.getTrip);
router.patch("/driver/trips/:tripId/accept", deliveryDriverController.acceptTrip);
router.patch("/driver/trips/:tripId/stops/:orderId/collect", deliveryDriverController.collectStop);
router.patch("/driver/trips/:tripId/verify-payment", deliveryDriverController.verifyPayment);
router.patch("/driver/trips/:tripId/start", deliveryDriverController.startDelivery);
router.patch("/driver/trips/:tripId/complete", deliveryDriverController.completeTrip);

module.exports = router;
