const express = require("express");
const router = express.Router();
const Store = require("../models/store");
const authMiddleware = require("../middleware/auth.middleware");
const optionalAuth = require("../middleware/optionalAuth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const { deliverStoredImage } = require("../utils/mediaDelivery.util");
const {
  createStore,
  getStoreById,
  getAllStores,
  browseStores,
  storesByRegions,
  pointsProgramStores,
  joinStore,
  leaveStore,
  followStore,
  getMyStoreCodeStats,
  getStoreMemberPrizes,
  getStoreCompetitionsEnabled,
  createMemberPrize,
  listMyMemberPrizes,
  suggestStore,
  getMyStore,
  updateMyStore,
  applyDefaultBranding,
  dismissBrandingWelcome,
} = require("../controllers/store.controller");
const {
  listMyPaymentMethods,
  createMyPaymentMethod,
  updateMyPaymentMethod,
  activateMyPaymentMethod,
  deleteMyPaymentMethod,
  getPaymentMethodTypes,
  getActiveStorePaymentMethods,
} = require("../controllers/storePaymentMethod.controller");
const {
  listMyItemCategories,
  createItemCategory,
  updateItemCategory,
  deleteItemCategory,
} = require("../controllers/storeItemCategory.controller");
const { requireStoreOwnerPage } = require("../middleware/storeOwnerPage.middleware");
const { requireStoreSubscription } = require("../middleware/storeSubscription.middleware");

router.post("/", authMiddleware, roleMiddleware.store, createStore);
router.get("/", getAllStores);
router.get("/browse", optionalAuth, browseStores);
router.get("/by-regions", storesByRegions);
router.get("/points", optionalAuth, pointsProgramStores);
router.get("/points-program", optionalAuth, pointsProgramStores);
router.get("/suggest", optionalAuth, suggestStore);
router.get("/settings/competitions-enabled", getStoreCompetitionsEnabled);
router.post(
  "/my/competition-request",
  authMiddleware,
  roleMiddleware.store,
  requireStoreSubscription,
  requireStoreOwnerPage("competitions"),
  async (req, res) => {
    res.status(201).json({
      message: "تم استلام طلب المسابقة — سيتم مراجعته من الإدارة",
    });
  }
);
router.get("/my/code-stats", authMiddleware, roleMiddleware.business, requireStoreSubscription, getMyStoreCodeStats);
router.get("/my", authMiddleware, roleMiddleware.business, getMyStore);
router.patch("/my", authMiddleware, roleMiddleware.business, requireStoreSubscription, updateMyStore);
router.get("/my/item-categories", authMiddleware, roleMiddleware.business, requireStoreSubscription, listMyItemCategories);
router.post("/my/item-categories", authMiddleware, roleMiddleware.business, requireStoreSubscription, createItemCategory);
router.patch("/my/item-categories/:id", authMiddleware, roleMiddleware.business, requireStoreSubscription, updateItemCategory);
router.delete("/my/item-categories/:id", authMiddleware, roleMiddleware.business, requireStoreSubscription, deleteItemCategory);
router.get("/my/payment-methods", authMiddleware, roleMiddleware.business, requireStoreSubscription, listMyPaymentMethods);
router.post("/my/payment-methods", authMiddleware, roleMiddleware.business, requireStoreSubscription, createMyPaymentMethod);
router.patch("/my/payment-methods/:id", authMiddleware, roleMiddleware.business, requireStoreSubscription, updateMyPaymentMethod);
router.patch("/my/payment-methods/:id/activate", authMiddleware, roleMiddleware.business, requireStoreSubscription, activateMyPaymentMethod);
router.delete("/my/payment-methods/:id", authMiddleware, roleMiddleware.business, requireStoreSubscription, deleteMyPaymentMethod);
router.get("/payment-method-types", getPaymentMethodTypes);
router.get("/:storeId/payment-methods/active", optionalAuth, getActiveStorePaymentMethods);
router.post("/my/apply-default-branding", authMiddleware, roleMiddleware.business, requireStoreSubscription, applyDefaultBranding);
router.post("/my/dismiss-branding-welcome", authMiddleware, roleMiddleware.business, requireStoreSubscription, dismissBrandingWelcome);
router.get("/my/member-prizes", authMiddleware, roleMiddleware.store, requireStoreSubscription, requireStoreOwnerPage("memberPrizes"), listMyMemberPrizes);
router.post("/my/member-prizes", authMiddleware, roleMiddleware.store, requireStoreSubscription, requireStoreOwnerPage("memberPrizes"), createMemberPrize);

router.get("/warehouses", authMiddleware, roleMiddleware.business, requireStoreOwnerPage("warehouses"), async (req, res) => {
  try {
    const { region, category } = req.query;
    const User = require("../models/user");
    const supplierIds = await User.find({ role: "supplier" }).distinct("_id");
    const query = { isActive: true, owner: { $in: supplierIds } };
    if (region) query.region = region;
    if (category) query.category = category;
    const stores = await Store.find(query)
      .populate("owner", "name role phone")
      .select("name logo region subRegion category description customersCount phone address ratingAvg");
    res.json({ count: stores.length, stores });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/:storeId/join", authMiddleware, joinStore);
router.post("/:storeId/leave", authMiddleware, leaveStore);
router.post("/:storeId/follow", authMiddleware, followStore);
router.get("/:storeId/member-prizes", optionalAuth, getStoreMemberPrizes);

router.get("/:id/logo", optionalAuth, async (req, res) => {
  try {
    const store = await Store.findById(req.params.id).select("logo").lean();
    if (!store) {
      return res.status(404).end();
    }
    return deliverStoredImage(res, store.logo);
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المتجر غير صحيح" });
    }
    return res.status(500).end();
  }
});

router.get("/:id/cover", optionalAuth, async (req, res) => {
  try {
    const store = await Store.findById(req.params.id).select("coverImage").lean();
    if (!store) {
      return res.status(404).end();
    }
    return deliverStoredImage(res, store.coverImage);
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف المتجر غير صحيح" });
    }
    return res.status(500).end();
  }
});

router.get("/:id", optionalAuth, getStoreById);

module.exports = router;
