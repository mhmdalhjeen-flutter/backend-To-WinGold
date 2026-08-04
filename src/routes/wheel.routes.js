const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const verifiedMiddleware = require("../middleware/verified.middleware");
const c = require("../controllers/wheel.controller");

router.get("/config", authMiddleware, c.getConfig);
router.post("/spin", authMiddleware, verifiedMiddleware, c.spin);
router.get("/my-wins", authMiddleware, c.getMyWins);

module.exports = router;
