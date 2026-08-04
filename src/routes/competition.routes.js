const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const verifiedMiddleware = require("../middleware/verified.middleware");
const optionalAuth = require("../middleware/optionalAuth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const c = require("../controllers/competition.controller");

/* ===== الأدمن (قبل /:id لتجنّب أي تعارض) ===== */
router.get("/admin/all", authMiddleware, roleMiddleware(["admin"]), c.getAllAdmin);
router.get(
  "/admin/:id/participants/export",
  authMiddleware,
  roleMiddleware(["admin"]),
  c.exportParticipantsExcel
);
router.get(
  "/admin/:id/participants",
  authMiddleware,
  roleMiddleware(["admin"]),
  c.getParticipantsAdmin
);
router.delete(
  "/admin/:id/participants",
  authMiddleware,
  roleMiddleware(["admin"]),
  c.clearParticipants
);

/* ===== العميل / العام ===== */
router.get("/featured", authMiddleware, c.getFeatured);
router.get("/", optionalAuth, c.getAll);
router.get("/:id", optionalAuth, c.getById);
router.post("/:id/join", authMiddleware, verifiedMiddleware, c.joinCompetition);

/* ===== إدارة الأدمن ===== */
router.post("/", authMiddleware, roleMiddleware(["admin"]), c.createCompetition);
router.put("/:id", authMiddleware, roleMiddleware(["admin"]), c.updateCompetition);
router.delete("/:id", authMiddleware, roleMiddleware(["admin"]), c.deleteCompetition);
router.patch("/:id/feature", authMiddleware, roleMiddleware(["admin"]), c.setFeatured);

module.exports = router;
