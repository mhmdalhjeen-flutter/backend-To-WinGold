const express = require("express");
const { sendSuccess } = require("../../utils/response.util");
const offerService = require("../../services/offer.service");
const { getHealthCheckResponse } = require("../../utils/serverHealth.util");

const router = express.Router();

router.get("/", (req, res) => {
  sendSuccess(res, {
    name: "Offers Tech API",
    version: "v1",
    status: "ok",
    docs: "Use /api/v1/* for versioned endpoints. Legacy /api/* remains supported.",
  });
});

router.get("/health", async (req, res) => {
  sendSuccess(res, await getHealthCheckResponse());
});

router.post("/pricing/offer-preview", (req, res) => {
  sendSuccess(res, offerService.previewPricing(req.body));
});

module.exports = router;
