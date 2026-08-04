// routes/codeOrder.routes.js
const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/auth.middleware");
const role    = require("../middleware/role.middleware");
const { requireStoreSubscription } = require("../middleware/storeSubscription.middleware");
const ctrl    = require("../controllers/codeOrder.controller");

router.post("/",                   auth, role(["store", "supplier"]), requireStoreSubscription, ctrl.createCodeOrder);
router.get("/my",                  auth, role(["store", "supplier"]), requireStoreSubscription, ctrl.getMyOrders);
router.delete("/my/:id",           auth, role(["store", "supplier"]), requireStoreSubscription, ctrl.deleteMyOrder);
router.get("/admin/all",           auth, role(["admin"]),             ctrl.getAllOrders);
router.post("/admin/configure/:id",auth, role(["admin"]),             ctrl.configureOrder);
router.post("/admin/receive/:id", auth, role(["admin"]), ctrl.markAsReceived);
router.get("/admin/export/:id", auth, role(["admin"]), ctrl.exportOrderCodes);
router.post("/admin/direct-generate", auth, role(["admin"]), ctrl.generateDirectStoreCodes);
router.post("/admin/direct-export", auth, role(["admin"]), ctrl.exportDirectPhysicalCodes);

module.exports = router;