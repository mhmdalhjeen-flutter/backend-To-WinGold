const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const c = require("../controllers/notification.controller");
const {
  notificationsListCache,
  notificationsUnreadCache,
} = require("../middleware/responseCache.middleware");

router.get("/push/public-key", c.getPushPublicKey);

router.use(authMiddleware);

router.post("/push/subscribe", c.subscribePush);
router.post("/push/unsubscribe", c.unsubscribePush);

router.get("/", notificationsListCache, c.getMine);
router.get("/unread-count", notificationsUnreadCache, c.unreadCount);
router.patch("/read-all", c.markAllRead);
router.patch("/:id/read", c.markRead);

module.exports = router;
