const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const c = require("../controllers/activity.controller");

router.use(authMiddleware);

// نشاط
router.post("/", c.logActivity);
router.get("/me", c.getMyActivity);

// توصيات
router.get("/recommendations", c.getRecommendations);

// مفضّلة
router.get("/favorites", c.getFavorites);
router.post("/favorites/:offerId/toggle", c.toggleFavorite);

module.exports = router;
