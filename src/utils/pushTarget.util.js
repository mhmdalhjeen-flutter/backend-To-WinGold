/**
 * Maps notification types to the PWA app that should receive Web Push.
 * Returns null when no customer/store PWA push target exists (e.g. delivery driver app).
 */

const STORE_PUSH_TYPES = new Set([
  "offer_expired",
  "offer_expiring",
  "offer_renewed",
  "delivery_order_included",
  "delivery_store_update",
]);

/** Roles/apps without a Web Push PWA client — skip push entirely for these types. */
const NO_WEB_PUSH_TYPES = new Set([
  "delivery_new_request",
  "delivery_assigned_to_you",
]);

function resolvePushTargetApp(type) {
  const normalized = typeof type === "string" ? type.trim() : "";
  if (!normalized) return "customer";
  if (NO_WEB_PUSH_TYPES.has(normalized)) return null;
  if (STORE_PUSH_TYPES.has(normalized)) return "store";
  if (normalized.startsWith("offer_")) return "store";
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

  switch (type) {
    case "order_confirmed":
    case "order_delivered":
    case "order_modification_resolved":
      return orderId ? `/orders/${orderId}` : "/orders";
    case "order_rejected":
    case "order_point_gift":
      return "/orders";
    case "order_modification_requested":
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
    default:
      if (orderId) return `/orders/${orderId}`;
      return "/notifications";
  }
}

module.exports = {
  resolvePushTargetApp,
  resolveCustomerPushUrl,
  STORE_PUSH_TYPES,
  NO_WEB_PUSH_TYPES,
};
