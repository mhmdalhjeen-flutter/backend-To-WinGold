const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const c = require("../controllers/achievement.controller");

router.get("/", c.listPublic);
router.get("/my", auth, c.myProgress);
router.post("/:id/seen", auth, c.markSeen);

module.exports = router;
