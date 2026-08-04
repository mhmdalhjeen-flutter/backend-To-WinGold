const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth.middleware");
const c = require("../controllers/rating.controller");

router.post("/", auth, c.rate);
router.get("/mine", auth, c.getMine);
router.get("/:targetType/:targetId", c.getSummary);

module.exports = router;
