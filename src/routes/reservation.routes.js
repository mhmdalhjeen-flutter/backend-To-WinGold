const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const {
  createReservation,
  getStoreReservations,
  getStorePendingCount,
  acceptReservation,
  rejectReservation,
} = require("../controllers/reservation.controller");

router.use(authMiddleware);

router.post("/", roleMiddleware.customer, createReservation);
router.get("/store", roleMiddleware.business, getStoreReservations);
router.get("/store/pending-count", roleMiddleware.business, getStorePendingCount);
router.patch("/:id/accept", roleMiddleware.business, acceptReservation);
router.patch("/:id/reject", roleMiddleware.business, rejectReservation);

module.exports = router;
