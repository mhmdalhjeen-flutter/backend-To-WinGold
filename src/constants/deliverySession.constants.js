/** Canonical delivery session statuses */
const SESSION_STATUSES = {
  WAITING: "waiting",
  WAITING_FOR_STORES: "waiting_for_stores",
  READY_FOR_PICKUP: "ready_for_pickup",
  DRIVER_ASSIGNED: "driver_assigned",
  COLLECTING_ORDERS: "collecting_orders",
  ON_DELIVERY: "on_delivery",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const SESSION_STATUS_VALUES = Object.values(SESSION_STATUSES);

/** Legacy trip statuses kept for backward-compatible reads */
const LEGACY_STATUS_ALIASES = {
  waiting_for_acceptance: SESSION_STATUSES.READY_FOR_PICKUP,
  accepted: SESSION_STATUSES.DRIVER_ASSIGNED,
  on_the_way: SESSION_STATUSES.ON_DELIVERY,
  delivered: SESSION_STATUSES.COMPLETED,
};

const SESSION_STATUS_LABELS = {
  [SESSION_STATUSES.WAITING]: "بانتظار التأكيد",
  [SESSION_STATUSES.WAITING_FOR_STORES]: "بانتظار موافقة المتاجر",
  [SESSION_STATUSES.READY_FOR_PICKUP]: "جاهز للاستلام",
  [SESSION_STATUSES.DRIVER_ASSIGNED]: "تم تعيين السائق",
  [SESSION_STATUSES.COLLECTING_ORDERS]: "جمع الطلبات",
  [SESSION_STATUSES.ON_DELIVERY]: "في الطريق للزبون",
  [SESSION_STATUSES.COMPLETED]: "مكتمل",
  [SESSION_STATUSES.CANCELLED]: "ملغى",
};

const DRIVER_VISIBLE_STATUSES = new Set([
  SESSION_STATUSES.READY_FOR_PICKUP,
  SESSION_STATUSES.DRIVER_ASSIGNED,
  SESSION_STATUSES.COLLECTING_ORDERS,
  SESSION_STATUSES.ON_DELIVERY,
  SESSION_STATUSES.COMPLETED,
  SESSION_STATUSES.CANCELLED,
]);

const NEW_DRIVER_REQUEST_STATUSES = new Set([SESSION_STATUSES.READY_FOR_PICKUP]);

const ACTIVE_DRIVER_STATUSES = new Set([
  SESSION_STATUSES.DRIVER_ASSIGNED,
  SESSION_STATUSES.COLLECTING_ORDERS,
  SESSION_STATUSES.ON_DELIVERY,
]);

const COMPLETED_SESSION_STATUSES = new Set([
  SESSION_STATUSES.COMPLETED,
  SESSION_STATUSES.CANCELLED,
]);

const CUSTOMER_ACTIVE_STATUSES = new Set([
  SESSION_STATUSES.WAITING,
  SESSION_STATUSES.WAITING_FOR_STORES,
  SESSION_STATUSES.READY_FOR_PICKUP,
  SESSION_STATUSES.DRIVER_ASSIGNED,
  SESSION_STATUSES.COLLECTING_ORDERS,
  SESSION_STATUSES.ON_DELIVERY,
]);

/** Store order statuses that count as approved for delivery readiness */
const STORE_APPROVED_STATUSES = new Set([
  "store_accepted",
  "confirmed",
  "preparing",
  "delivered_to_driver",
  "delivered_to_customer",
]);

/** Store order statuses where driver can collect */
const STORE_READY_FOR_COLLECTION_STATUSES = new Set([
  "preparing",
  "delivered_to_driver",
  "store_accepted",
  "confirmed",
]);

const STORE_STOP_LABELS = {
  pending: "بانتظار التأكيد",
  store_accepted: "تم قبول المتجر",
  preparing: "قيد التحضير",
  delivered_to_driver: "جاهز للاستلام",
  delivered_to_customer: "تم التسليم",
  confirmed: "مؤكّد",
  rejected: "مرفوض",
  cancelled: "ملغى",
  delivered: "تم التسليم",
  completed_off_platform: "اكتمل خارج المنصة",
};

const COLLECTION_STATUS_LABELS = {
  pending: "بانتظار الاستلام",
  collected: "تم الاستلام من المتجر",
};

const PAYMENT_STATUSES = {
  UNPAID: "unpaid",
  PENDING: "pending",
  PAID: "paid",
  VERIFIED: "verified",
};

function normalizeSessionStatus(status) {
  if (!status) return SESSION_STATUSES.WAITING;
  return LEGACY_STATUS_ALIASES[status] || status;
}

function isStoreApprovedForSession(orderStatus) {
  return STORE_APPROVED_STATUSES.has(orderStatus);
}

function allStoresApproved(stops = []) {
  if (!stops.length) return false;
  return stops.every((s) => isStoreApprovedForSession(s.orderStatus));
}

function deriveInitialSubmittedStatus(stops = []) {
  return allStoresApproved(stops)
    ? SESSION_STATUSES.READY_FOR_PICKUP
    : SESSION_STATUSES.WAITING_FOR_STORES;
}

module.exports = {
  SESSION_STATUSES,
  SESSION_STATUS_VALUES,
  LEGACY_STATUS_ALIASES,
  SESSION_STATUS_LABELS,
  DRIVER_VISIBLE_STATUSES,
  NEW_DRIVER_REQUEST_STATUSES,
  ACTIVE_DRIVER_STATUSES,
  COMPLETED_SESSION_STATUSES,
  CUSTOMER_ACTIVE_STATUSES,
  STORE_APPROVED_STATUSES,
  STORE_READY_FOR_COLLECTION_STATUSES,
  STORE_STOP_LABELS,
  COLLECTION_STATUS_LABELS,
  PAYMENT_STATUSES,
  normalizeSessionStatus,
  isStoreApprovedForSession,
  allStoresApproved,
  deriveInitialSubmittedStatus,
};
