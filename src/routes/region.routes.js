const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const c = require("../controllers/region.controller");

// عام
router.get("/", c.getAll);

// أدمن
router.post("/", authMiddleware, roleMiddleware(["admin"]), c.create);
router.put("/:id", authMiddleware, roleMiddleware(["admin"]), c.update);
router.patch("/reorder", authMiddleware, roleMiddleware(["admin"]), c.reorder);
router.delete("/:id", authMiddleware, roleMiddleware(["admin"]), c.remove);

module.exports = router;
