const express = require("express");
const router = express.Router();
const honorController = require("../controllers/honor-board.controller");
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");

// مسار عام للجميع لرؤية لوحة الشرف
router.get("/active", honorController.getActiveHonorItems);

// مسارات الأدمن فقط للإدارة
router.post("/add", authMiddleware, roleMiddleware(["admin"]), honorController.addToHonorBoard);
router.get("/admin/all", authMiddleware, roleMiddleware(["admin"]), honorController.getAllAdmin);
router.put("/:id", authMiddleware, roleMiddleware(["admin"]), honorController.updateHonorItem);
router.patch("/toggle/:id", authMiddleware, roleMiddleware(["admin"]), honorController.toggleStatus);
router.delete("/:id", authMiddleware, roleMiddleware(["admin"]), honorController.deleteHonorItem);

module.exports = router;
