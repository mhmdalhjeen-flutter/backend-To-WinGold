const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const optionalAuth = require("../middleware/optionalAuth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const Offer = require("../models/offer");
const { deliverStoredImage } = require("../utils/mediaDelivery.util");
const { requireOwnedStoreResource } = require("../middleware/ownership.middleware");
const offerService = require("../services/offer.service");
const {
  createOffer,
  deleteOffer,
  toggleOfferActive,
  updateOffer,
  renewOffer,
} = require("../controllers/offer.controller");

router.get("/", optionalAuth, async (req, res) => {
  try {
    const offers = await offerService.listActiveOffers(req.query, req.user?.id);
    res.json(offers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/feed", optionalAuth, async (req, res) => {
  try {
    const feed = await offerService.listOfferFeed(req.query, req.user?.id);
    res.json(feed);
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "مؤشر التصفّح غير صحيح" });
    }
    res.status(500).json({ message: err.message });
  }
});

router.get("/reels", optionalAuth, async (req, res) => {
  try {
    const reels = await offerService.listCategoryReels(req.query, req.user?.id);
    res.json(reels);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/:id/view", optionalAuth, async (req, res) => {
  try {
    const clientId = req.headers["x-client-id"] || req.body?.clientId;
    const result = await offerService.recordMeaningfulView(req.params.id, {
      userId: req.user?.id,
      clientId,
    });
    res.json(result);
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف العرض غير صحيح" });
    }
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
});

router.post("/:id/share", optionalAuth, async (req, res) => {
  try {
    const result = await offerService.recordOfferShare(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف العرض غير صحيح" });
    }
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
});

router.get("/my", authMiddleware, roleMiddleware.businessOrAdmin, async (req, res) => {
  try {
    const offers = await offerService.getMyOffers(req.user.id, req.query);
    res.json({ offers });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
});

router.get("/dashboard", authMiddleware, roleMiddleware.business, async (req, res) => {
  try {
    const data = await offerService.getDashboardOffers(req.user, req.query);
    res.json(data);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
});

router.get("/:id/image", optionalAuth, async (req, res) => {
  try {
    const offer = await Offer.findById(req.params.id).select("image isActive").lean();
    if (!offer?.isActive) {
      return res.status(404).end();
    }
    return deliverStoredImage(res, offer.image);
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف العرض غير صحيح" });
    }
    return res.status(500).end();
  }
});

router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const clientId = req.headers["x-client-id"];
    const offer = await offerService.getOfferById(req.params.id, {
      incrementViews: req.query.countView === "true",
      userId: req.user?.id,
      clientId,
    });
    res.json({ offer });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف العرض غير صحيح" });
    }
    const status = err.status || 500;
    res.status(status).json({ message: err.message });
  }
});

router.post("/", authMiddleware, roleMiddleware.businessOrAdmin, createOffer);
router.delete("/:id", authMiddleware, roleMiddleware.businessOrAdmin, requireOwnedStoreResource(Offer, "id", "العرض غير موجود"), deleteOffer);
router.patch("/:id/toggle-active", authMiddleware, roleMiddleware.businessOrAdmin, requireOwnedStoreResource(Offer, "id", "العرض غير موجود"), toggleOfferActive);
router.put("/:id", authMiddleware, roleMiddleware.businessOrAdmin, requireOwnedStoreResource(Offer, "id", "العرض غير موجود"), updateOffer);
router.patch("/:id/renew", authMiddleware, roleMiddleware.businessOrAdmin, requireOwnedStoreResource(Offer, "id", "العرض غير موجود"), renewOffer);

module.exports = router;
