const StoreMembership = require("../models/storeMembership");
const User = require("../models/user");
const Notification = require("../models/notification");
const notificationService = require("./notification.service");
const { safeLog } = require("../utils/logSanitize.util");

const BATCH_SIZE = 200;

/**
 * Customers subscribed to a store:
 * - User.followedStores (network / notification bell)
 * - StoreMembership.status === "member" (code-based membership)
 * Excludes pending-only memberships and non-customer roles.
 */
async function getStoreSubscriberUserIds(storeId) {
  const storeObjectId = storeId?._id || storeId;
  if (!storeObjectId) return [];

  const [followedUsers, members] = await Promise.all([
    User.find({ followedStores: storeObjectId, role: "customer" })
      .select("_id")
      .lean(),
    StoreMembership.find({ store: storeObjectId, status: "member" })
      .select("user")
      .lean(),
  ]);

  const ids = new Set();
  followedUsers.forEach((u) => ids.add(String(u._id)));
  members.forEach((m) => ids.add(String(m.user)));
  return [...ids];
}

async function hasSourceNotification(type, sourceField, sourceId) {
  if (!sourceId) return false;
  const existing = await Notification.findOne({
    type,
    [`data.${sourceField}`]: String(sourceId),
  })
    .select("_id")
    .lean();
  return Boolean(existing);
}

function buildProductNotificationContent(store, product) {
  const storeName = store?.name || "المتجر";
  const productName = product?.name || "منتج جديد";
  const storeId = String(store?._id || product?.store || "");
  const productId = String(product?._id || "");
  return {
    title: `منتج جديد من ${storeName}`,
    body: `أضاف ${storeName} منتجًا جديدًا: ${productName}`,
    data: {
      type: "store_new_product",
      storeId,
      productId,
      url: productId ? `/product/${productId}` : storeId ? `/store/${storeId}` : "/notifications",
    },
  };
}

function buildOfferNotificationContent(store, offer) {
  const storeName = store?.name || "المتجر";
  const offerTitle = offer?.title || "عرض جديد";
  const storeId = String(store?._id || offer?.store || "");
  const offerId = String(offer?._id || "");
  return {
    title: `عرض جديد من ${storeName}`,
    body: `أضاف ${storeName} عرضًا جديدًا: ${offerTitle}`,
    data: {
      type: "store_new_offer",
      storeId,
      offerId,
      url: offerId ? `/offer/${offerId}` : storeId ? `/store/${storeId}` : "/notifications",
    },
  };
}

async function notifySubscribersInBatches(type, userIds, { title, body, data }) {
  if (!userIds.length) {
    return { sent: 0, skipped: userIds.length };
  }

  let sent = 0;
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    const items = batch.map((userId) => ({
      user: userId,
      type,
      title,
      body,
      data,
    }));
    const created = await notificationService.createMany(items);
    sent += created.length;
  }
  return { sent, skipped: 0 };
}

/**
 * Notify store subscribers about a newly published customer-visible product.
 */
async function notifyStoreNewProduct(store, product) {
  if (!store?._id || !product?._id) return { sent: 0, reason: "missing_entity" };
  if (!product.isActive) return { sent: 0, reason: "not_active" };
  if (product.isWholesale) return { sent: 0, reason: "wholesale" };

  const already = await hasSourceNotification("store_new_product", "productId", product._id);
  if (already) return { sent: 0, reason: "already_notified" };

  const userIds = await getStoreSubscriberUserIds(store._id);
  if (!userIds.length) return { sent: 0, reason: "no_subscribers" };

  const { title, body, data } = buildProductNotificationContent(store, product);
  try {
    const result = await notifySubscribersInBatches("store_new_product", userIds, { title, body, data });
    safeLog("info", "store_subscriber_product_notify", {
      storeId: String(store._id),
      productId: String(product._id),
      recipients: userIds.length,
      sent: result.sent,
    });
    return { ...result, recipients: userIds.length };
  } catch (err) {
    safeLog("warn", "store_subscriber_product_notify_failed", {
      message: err.message,
      storeId: String(store._id),
      productId: String(product._id),
    });
    return { sent: 0, reason: "failed" };
  }
}

/**
 * Notify store subscribers about a newly published offer.
 */
async function notifyStoreNewOffer(store, offer) {
  if (!store?._id || !offer?._id) return { sent: 0, reason: "missing_entity" };
  if (!offer.isActive) return { sent: 0, reason: "not_active" };

  const already = await hasSourceNotification("store_new_offer", "offerId", offer._id);
  if (already) return { sent: 0, reason: "already_notified" };

  const userIds = await getStoreSubscriberUserIds(store._id);
  if (!userIds.length) return { sent: 0, reason: "no_subscribers" };

  const { title, body, data } = buildOfferNotificationContent(store, offer);
  try {
    const result = await notifySubscribersInBatches("store_new_offer", userIds, { title, body, data });
    safeLog("info", "store_subscriber_offer_notify", {
      storeId: String(store._id),
      offerId: String(offer._id),
      recipients: userIds.length,
      sent: result.sent,
    });
    return { ...result, recipients: userIds.length };
  } catch (err) {
    safeLog("warn", "store_subscriber_offer_notify_failed", {
      message: err.message,
      storeId: String(store._id),
      offerId: String(offer._id),
    });
    return { sent: 0, reason: "failed" };
  }
}

module.exports = {
  getStoreSubscriberUserIds,
  notifyStoreNewProduct,
  notifyStoreNewOffer,
  buildProductNotificationContent,
  buildOfferNotificationContent,
  hasSourceNotification,
};
