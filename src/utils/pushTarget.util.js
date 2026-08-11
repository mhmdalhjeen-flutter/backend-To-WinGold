/**
 * Maps notification types to the PWA app that should receive Web Push.
 * When the same type targets different apps (e.g. delivery_waiting_stores),
 * callers must set data.pushApp explicitly.
 */

const VALID_PUSH_APPS = new Set(["customer", "store", "admin", "delivery"]);

/** Customer Web Push / in-app events — keep in sync with customer PWA allowlist. */
const CUSTOMER_PUSH_TYPES = new Set([
  "store_new_product",
  "store_new_offer",
  "order_confirmed",
  "order_modification_requested",
  "payment_method_change_requested",
  "payment_data_review_requested",
  /** Delivery company/driver collected the order from the store. */
  "delivery_on_the_way",
  /** Delivery handover completed (driver or store). */
  "delivery_completed",
  "order_delivered",
  "chat_message",
]);

const STORE_PUSH_TYPES = new Set([
  "offer_expired",
  "offer_expiring",
  "offer_renewed",
  "delivery_order_included",
  "delivery_store_update",
  "chat_message",
]);

/** Delivery portal (company + driver) — only when pushApp is not set on shared types. */
const DELIVERY_COMPANY_PUSH_TYPES = new Set([
  "delivery_waiting_stores",
  "delivery_new_request",
  "delivery_billing_required",
  "delivery_billing_submitted",
  "delivery_billing_verified",
  "delivery_billing_rejected",
  "delivery_billing_exempted",
  "chat_message",
]);

const DELIVERY_DRIVER_PUSH_TYPES = new Set([
  "delivery_assigned_to_you",
  "delivery_out_for_delivery",
  "chat_message",
]);

const DELIVERY_PUSH_TYPES = new Set([
  ...DELIVERY_COMPANY_PUSH_TYPES,
  ...DELIVERY_DRIVER_PUSH_TYPES,
]);

function isCustomerPushAllowed(type) {
  const normalized = typeof type === "string" ? type.trim() : "";
  return CUSTOMER_PUSH_TYPES.has(normalized);
}

function isDeliveryPushAllowed(type, role) {
  const normalized = typeof type === "string" ? type.trim() : "";
  if (role === "delivery_company") return DELIVERY_COMPANY_PUSH_TYPES.has(normalized);
  if (role === "delivery_driver") return DELIVERY_DRIVER_PUSH_TYPES.has(normalized);
  return DELIVERY_PUSH_TYPES.has(normalized);
}

function resolvePushTargetApp(type, data = {}) {
  const pushApp = typeof data.pushApp === "string" ? data.pushApp.trim() : "";
  if (VALID_PUSH_APPS.has(pushApp)) return pushApp;

  const normalized = typeof type === "string" ? type.trim() : "";
  if (!normalized) return "customer";
  if (STORE_PUSH_TYPES.has(normalized)) return "store";
  if (normalized.startsWith("offer_")) return "store";
  if (DELIVERY_PUSH_TYPES.has(normalized)) return "delivery";
  if (normalized.startsWith("delivery_")) return "customer";
  return "customer";
}

function resolveCustomerPushUrl(type, data = {}) {
  if (typeof data.url === "string" && data.url.startsWith("/")) {
    return data.url;
  }

  const orderId = data.orderId != null ? String(data.orderId) : "";
  const offerId = data.offerId != null ? String(data.offerId) : "";
  const competitionId = data.competitionId != null ? String(data.competitionId) : "";
  const listingId = data.listingId != null ? String(data.listingId) : "";
  const deliverySessionId = data.deliverySessionId != null ? String(data.deliverySessionId) : "";

  switch (type) {
    case "order_confirmed":
    case "order_delivered":
    case "order_modification_resolved":
      return orderId ? `/orders/${orderId}` : "/orders";
    case "order_rejected":
    case "order_point_gift":
      return "/orders";
    case "order_modification_requested":
    case "payment_method_change_requested":
    case "payment_data_review_requested":
      return orderId ? `/orders/${orderId}/modify` : "/orders";
    case "offer_expired":
    case "offer_expiring":
    case "offer_renewed":
      return offerId ? `/offer/${offerId}` : "/";
    case "competition_draw":
      return competitionId ? `/competitions/${competitionId}` : "/competitions";
    case "bazaar_listing_approved":
    case "bazaar_listing_rejected":
    case "bazaar_listing_expired":
    case "bazaar_renewal_prompt":
      return listingId ? `/marketplace/${listingId}` : "/marketplace";
    case "referral_batch":
      return "/center";
    case "store_new_product": {
      const productId = data.productId != null ? String(data.productId) : "";
      const storeId = data.storeId != null ? String(data.storeId) : "";
      if (productId) return `/product/${productId}`;
      if (storeId) return `/store/${storeId}`;
      return "/notifications";
    }
    case "store_new_offer": {
      const offerId = data.offerId != null ? String(data.offerId) : "";
      const storeId = data.storeId != null ? String(data.storeId) : "";
      if (offerId) return `/offer/${offerId}`;
      if (storeId) return `/store/${storeId}`;
      return "/notifications";
    }
    case "delivery_session_created":
    case "delivery_waiting_stores":
    case "delivery_ready_for_pickup":
    case "delivery_driver_assigned":
    case "delivery_on_the_way":
    case "delivery_completed":
    case "delivery_rejected":
    case "delivery_cancelled":
      return deliverySessionId ? `/delivery/confirm?session=${deliverySessionId}` : "/orders";
    case "chat_message": {
      const conversationId = data.conversationId != null ? String(data.conversationId) : "";
      if (conversationId) return `/chat/${conversationId}`;
      return "/chat";
    }
    default:
      if (orderId) return `/orders/${orderId}`;
      return "/notifications";
  }
}

function resolveStorePushUrl(type, data = {}) {
  if (typeof data.url === "string" && data.url.startsWith("/")) {
    return data.url;
  }

  const orderId = data.orderId != null ? String(data.orderId) : "";
  const offerId = data.offerId != null ? String(data.offerId) : "";

  switch (type) {
    case "order_modification_resolved":
    case "order_rejected":
    case "delivery_order_included":
    case "delivery_store_update":
      return orderId ? `/store/orders/${orderId}` : "/store/orders";
    case "offer_expired":
    case "offer_expiring":
    case "offer_renewed":
      return offerId ? `/store/item-details/${offerId}` : "/store/offers";
    case "push_test":
      return "/store/notifications";
    case "chat_message": {
      const conversationId = data.conversationId != null ? String(data.conversationId) : "";
      if (conversationId) return `/store/chat/${conversationId}`;
      return "/store/chats";
    }
    default:
      if (orderId) return `/store/orders/${orderId}`;
      return "/store/notifications";
  }
}

function resolveDeliveryPushUrl(type, data = {}) {
  if (typeof data.url === "string" && data.url.startsWith("/")) {
    return data.url;
  }

  const deliverySessionId = data.deliverySessionId != null ? String(data.deliverySessionId) : "";

  switch (type) {
    case "delivery_assigned_to_you":
    case "delivery_out_for_delivery":
      if (deliverySessionId) return `/driver/delivery/${deliverySessionId}`;
      return "/driver";
    case "delivery_new_request":
    case "delivery_waiting_stores":
    case "delivery_completed":
    case "delivery_cancelled":
    case "delivery_rejected":
      if (deliverySessionId) return `/requests/${deliverySessionId}`;
      return "/requests";
    case "delivery_billing_required":
    case "delivery_billing_submitted":
    case "delivery_billing_verified":
    case "delivery_billing_rejected":
    case "delivery_billing_exempted":
      return "/settings/billing";
    case "push_test":
      return "/notifications";
    case "chat_message": {
      const senderId = data.senderId != null ? String(data.senderId) : "";
      const recipientRole = data.recipientRole != null ? String(data.recipientRole) : "";
      if (recipientRole === "delivery_driver") {
        if (senderId) return `/driver/chat/${senderId}`;
        return "/driver";
      }
      if (senderId) return `/chat/${senderId}`;
      return "/chats";
    }
    default:
      if (deliverySessionId) return `/requests/${deliverySessionId}`;
      return "/notifications";
  }
}

function resolveAdminPushUrl(type, data = {}) {
  if (typeof data.url === "string" && data.url.startsWith("/")) {
    return data.url;
  }

  switch (type) {
    case "bazaar_listing_approved":
    case "bazaar_listing_rejected":
      return "/bazaar-approvals";
    case "push_test":
      return "/dashboard";
    default:
      return "/dashboard";
  }
}

function resolvePushUrl(targetApp, type, data = {}) {
  switch (targetApp) {
    case "store":
      return resolveStorePushUrl(type, data);
    case "delivery":
      return resolveDeliveryPushUrl(type, data);
    case "admin":
      return resolveAdminPushUrl(type, data);
    default:
      return resolveCustomerPushUrl(type, data);
  }
}

module.exports = {
  VALID_PUSH_APPS,
  CUSTOMER_PUSH_TYPES,
  isCustomerPushAllowed,
  isDeliveryPushAllowed,
  DELIVERY_COMPANY_PUSH_TYPES,
  DELIVERY_DRIVER_PUSH_TYPES,
  resolvePushTargetApp,
  resolveCustomerPushUrl,
  resolveStorePushUrl,
  resolveDeliveryPushUrl,
  resolveAdminPushUrl,
  resolvePushUrl,
  STORE_PUSH_TYPES,
  DELIVERY_PUSH_TYPES,
};
