const express = require("express");
const { createApiRouter } = require("../registerApiRoutes");
const metaRoutes = require("./meta.routes");

/**
 * Canonical v1 router: meta/health/pricing-preview (envelope) + full API tree.
 */
function createV1Router() {
  const router = express.Router();

  router.use(metaRoutes);
  router.use(createApiRouter());

  return router;
}

module.exports = { createV1Router };
