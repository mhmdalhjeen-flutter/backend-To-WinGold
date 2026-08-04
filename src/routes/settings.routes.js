const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const c = require("../controllers/settings.controller");

router.get("/public", c.getPublic);
router.get("/store-owner-pages", authMiddleware, roleMiddleware.store, c.getStoreOwnerPages);

module.exports = router;
