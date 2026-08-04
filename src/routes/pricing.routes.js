const express = require("express");
const offerService = require("../services/offer.service");

/**
 * Legacy pricing preview — same SSOT as /api/v1/pricing/offer-preview
 * POST /api/pricing/offer-preview
 */
function createPricingRouter() {
  const router = express.Router();
  router.post("/offer-preview", (req, res) => {
    res.json(offerService.previewPricing(req.body));
  });
  return router;
}

module.exports = { createPricingRouter };
