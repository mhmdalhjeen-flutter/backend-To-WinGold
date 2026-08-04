const express = require("express");
const router = express.Router();
const drawController = require("../controllers/draw.controller");
const authMiddleware = require("../middleware/auth.middleware");
const verifiedMiddleware = require("../middleware/verified.middleware");

router.use(authMiddleware);

router.get("/open", drawController.getOpenDraws);
router.post("/join", verifiedMiddleware, drawController.joinDraw);
router.get("/my-draws", drawController.getMyDraws);

module.exports = router;
