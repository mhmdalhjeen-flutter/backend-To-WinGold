const express = require("express");
const router = express.Router();
const userController = require("../controllers/user.controller");
const userCenter = require("../controllers/user-center.controller");
const authMiddleware = require("../middleware/auth.middleware");
const verifiedMiddleware = require("../middleware/verified.middleware");
const { userMeCache } = require("../middleware/responseCache.middleware");

router.use(authMiddleware);

router.get("/points-leaderboard", userCenter.getPointsLeaderboard);
router.get("/me", userMeCache, userController.getMe);
router.get("/me/center", userCenter.getCenter);
router.get("/me/point-sources", userCenter.getPointSources);
router.get("/me/legal", userCenter.getLegal);
router.get("/me/admin-contact", userCenter.getAdminContact);
router.patch("/me/profile", userCenter.updateProfile);
router.patch("/update-profile", userController.updateProfile);
router.post("/me/phone/request", userCenter.requestPhoneChange);
router.post("/me/phone/verify", userCenter.verifyPhoneChange);
router.patch("/me/preferences", verifiedMiddleware, userCenter.updatePreferences);
router.post("/me/suggestions", verifiedMiddleware, userCenter.submitSuggestion);

router.post("/redeem-card", verifiedMiddleware, userController.redeemCard);

module.exports = router;
