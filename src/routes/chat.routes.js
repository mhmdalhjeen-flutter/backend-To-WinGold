const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/auth.middleware");
const rateLimit = require("../middleware/rateLimit.middleware");
const ctrl    = require("../controllers/chat.controller");
const { chatUnreadCache } = require("../middleware/responseCache.middleware");

const chatSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "رسائل كثيرة — يرجى التمهل قليلاً",
  keyFn: (req) => `chat-send:${req.user?.id || req.ip}:${req.params.convId || "new"}`,
});

router.use(auth);

router.post  ("/",              ctrl.getOrCreateConversation);
router.get   ("/unread-count",  chatUnreadCache, ctrl.getUnreadCount);
router.get   ("/",              ctrl.getMyConversations);
router.get   ("/:convId",       ctrl.getMessages);
router.post  ("/:convId",       chatSendLimiter, ctrl.sendMessage);

module.exports = router;
