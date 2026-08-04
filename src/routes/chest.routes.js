const express = require("express");
const router = express.Router();
const { openDailyChest } = require("../controllers/chest.controller");
const authMiddleware = require("../middleware/auth.middleware");

// فتح صندوق الكنز اليومي - محمي بتسجيل الدخول
router.post("/open", authMiddleware, openDailyChest);

module.exports = router;
