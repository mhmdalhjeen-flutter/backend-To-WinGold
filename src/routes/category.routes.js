const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const c = require("../controllers/category.controller");

// عام
router.get("/", c.getAll);
router.get("/tree", c.getTree);

// أدمن
router.post("/", authMiddleware, roleMiddleware(["admin"]), c.create);
router.put("/:id", authMiddleware, roleMiddleware(["admin"]), c.update);
router.delete("/:id", authMiddleware, roleMiddleware(["admin"]), c.remove);

module.exports = router;
