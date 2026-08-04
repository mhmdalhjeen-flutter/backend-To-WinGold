// routes/cardType.routes.js
const express    = require("express");
const router     = express.Router();
const auth       = require("../middleware/auth.middleware");
const role       = require("../middleware/role.middleware");
const ctrl       = require("../controllers/cardType.controller");

router.get("/",          auth, ctrl.getCardTypes);                          // أدمن + صاحب متجر
router.post("/",         auth, role(["admin"]), ctrl.createCardType);       // أدمن فقط
router.put("/:id",       auth, role(["admin"]), ctrl.updateCardType);
router.delete("/:id",    auth, role(["admin"]), ctrl.deleteCardType);

module.exports = router;