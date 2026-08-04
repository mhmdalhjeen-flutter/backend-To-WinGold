const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const verifiedMiddleware = require("../middleware/verified.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const optionalAuth = require("../middleware/optionalAuth.middleware");
const c = require("../controllers/bazaar.controller");

router.get("/meta", optionalAuth, c.getMeta);
router.get("/regions", c.getRegions);
router.get("/", optionalAuth, c.browse);
router.get("/favorites", authMiddleware, roleMiddleware.customer, c.myFavorites);
router.get("/my", authMiddleware, roleMiddleware.customer, c.myListings);
router.get("/:id", optionalAuth, c.getOne);

router.post("/", authMiddleware, roleMiddleware.customer, verifiedMiddleware, c.create);
router.patch("/:id", authMiddleware, roleMiddleware.customer, c.update);
router.delete("/:id", authMiddleware, roleMiddleware.customer, c.remove);
router.post("/:id/renew", authMiddleware, roleMiddleware.customer, verifiedMiddleware, c.renew);
router.post("/:id/favorite", authMiddleware, roleMiddleware.customer, c.toggleFavorite);

module.exports = router;
