const express = require("express");
const authMiddleware = require("../middleware/auth.middleware");
const { requireStoreOwnerPage } = require("../middleware/storeOwnerPage.middleware");

const authRoutes = require("./auth.routes");
const userRoutes = require("./user.routes");
const adminRoutes = require("./admin/admin.routes");
const storeRoutes = require("./store.routes");
const offerRoutes = require("./offer.routes");
const productRoutes = require("./product.routes");
const promoRoutes = require("./promo.routes");
const drawRoutes = require("./draw.routes");
const chestRoutes = require("./chest.routes");
const honorRoutes = require("./honor.routes");
const treasureRoutes = require("./treasure.routes");
const activationRoutes = require("./activation.routes");
const cartRoutes = require("./cart.routes");
const cardTypeRoutes = require("./cardType.routes");
const codeOrderRoutes = require("./codeOrder.routes");
const chatRoutes = require("./chat.routes");
const orderRoutes = require("./order.routes");
const competitionRoutes = require("./competition.routes");
const categoryRoutes = require("./category.routes");
const regionRoutes = require("./region.routes");
const notificationRoutes = require("./notification.routes");
const settingsRoutes = require("./settings.routes");
const activityRoutes = require("./activity.routes");
const ratingRoutes = require("./rating.routes");
const bazaarRoutes = require("./bazaar.routes");
const achievementRoutes = require("./achievement.routes");
const deliveryCompanyRoutes = require("./deliveryCompany.routes");
const deliveryRoutes = require("./delivery.routes");
const reservationRoutes = require("./reservation.routes");
const { createPricingRouter } = require("./pricing.routes");

/**
 * Shared API route tree — mounted at /api (legacy) and /api/v1 (canonical).
 * No response-envelope wrapping here; legacy shape preserved until Phase 1.
 */
function createApiRouter() {
  const router = express.Router();

  router.use("/auth", authRoutes);
  router.use("/users", userRoutes);
  router.use("/admin", adminRoutes);
  router.use("/stores", storeRoutes);
  router.use("/offers", offerRoutes);
  router.use("/products", productRoutes);
  router.use("/promo", promoRoutes);
  router.use("/draws", drawRoutes);
  router.use("/chest", chestRoutes);
  router.use("/honor", honorRoutes);
  router.use("/treasure", treasureRoutes);
  router.use("/activation", activationRoutes);
  router.use("/card-types", cardTypeRoutes);
  router.use("/code-orders", codeOrderRoutes);
  router.use("/chats", chatRoutes);
  router.use("/cart", authMiddleware, requireStoreOwnerPage("cart"), cartRoutes);
  router.use(
    "/store-owner/cart",
    authMiddleware,
    requireStoreOwnerPage("cart"),
    cartRoutes
  );
  router.use("/orders", orderRoutes);
  router.use("/competitions", competitionRoutes);
  router.use("/categories", categoryRoutes);
  router.use("/regions", regionRoutes);
  router.use("/notifications", notificationRoutes);
  router.use("/settings", settingsRoutes);
  router.use("/activity", activityRoutes);
  router.use("/ratings", ratingRoutes);
  router.use("/bazaar", bazaarRoutes);
  router.use("/achievements", achievementRoutes);
  router.use("/delivery-companies", deliveryCompanyRoutes);
  router.use("/delivery", deliveryRoutes);
  router.use("/reservations", reservationRoutes);
  router.use("/pricing", createPricingRouter());

  return router;
}

module.exports = { createApiRouter };
