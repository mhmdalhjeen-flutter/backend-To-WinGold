const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const roleMiddleware = require("../middleware/role.middleware");
const sensitiveAuth = require("../middleware/sensitiveAuth.middleware");
const c = require("../controllers/wheel.controller");
const sensitive = require("../controllers/admin-sensitive.controller");

router.get("/sensitive/status", authMiddleware, roleMiddleware(["admin"]), sensitive.getStatus);
router.post("/sensitive/setup", authMiddleware, roleMiddleware(["admin"]), sensitive.setupPassword);
router.post("/sensitive/change", authMiddleware, roleMiddleware(["admin"]), sensitive.changePassword);
router.post("/sensitive/verify", authMiddleware, roleMiddleware(["admin"]), sensitive.verifyPassword);
router.post("/sensitive/revoke", authMiddleware, roleMiddleware(["admin"]), sensitive.revokeSensitiveSession);

const wheelAdmin = express.Router();
wheelAdmin.use(authMiddleware, roleMiddleware(["admin"]));

wheelAdmin.get("/wins", c.adminListWins);
wheelAdmin.patch("/wins/:id", c.adminUpdateWin);
wheelAdmin.get("/spins", c.adminListSpins);

const wheelSensitive = express.Router();
wheelSensitive.use(authMiddleware, roleMiddleware(["admin"]), sensitiveAuth);
wheelSensitive.get("/prizes", c.adminListPrizes);
wheelSensitive.post("/prizes", c.adminCreatePrize);
wheelSensitive.put("/prizes/:id", c.adminUpdatePrize);
wheelSensitive.delete("/prizes/:id", c.adminDeletePrize);
wheelSensitive.get("/preview", c.adminPreview);

router.use("/wheel", wheelAdmin);
router.use("/wheel", wheelSensitive);

module.exports = router;
