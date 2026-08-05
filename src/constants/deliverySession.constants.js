/** Canonical delivery session statuses — company-centric workflow */
const SESSION_STATUSES = {
  WAITING: "waiting",
  WAITING_FOR_STORES: "waiting_for_stores",
  READY_FOR_PICKUP: "ready_for_pickup",
  DRIVER_ASSIGNED: "driver_assigned",
  ACCEPTED: "accepted",
  OUT_FOR_DELIVERY: "out_for_delivery",
  COMPLETED: "completed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
};

const SESSION_STATUS_VALUES = Object.values(SESSION_STATUSES);

/** Legacy driver-era statuses kept for backward-compatible reads */
const LEGACY_STATUS_ALIASES = {
  waiting_for_acceptance: SESSION_STATUSES.READY_FOR_PICKUP,
  collecting_orders: SESSION_STATUSES.OUT_FOR_DELIVERY,
  on_delivery: SESSION_STATUSES.OUT_FOR_DELIVERY,
  on_the_way: SESSION_STATUSES.OUT_FOR_DELIVERY,
  delivered: SESSION_STATUSES.COMPLETED,
};

const SESSION_STATUS_LABELS = {
  [SESSION_STATUSES.WAITING]: "بانتظار التأكيد",
  [SESSION_STATUSES.WAITING_FOR_STORES]: "بانتظار تأكيد المتجر",
  [SESSION_STATUSES.READY_FOR_PICKUP]: "بانتظار شركة التوصيل",
  [SESSION_STATUSES.DRIVER_ASSIGNED]: "معيّن لسائق",
  [SESSION_STATUSES.ACCEPTED]: "مقبول من الشركة",
  [SESSION_STATUSES.OUT_FOR_DELIVERY]: "قيد التوصيل",
  [SESSION_STATUSES.COMPLETED]: "تم التسليم",
  [SESSION_STATUSES.REJECTED]: "مرفوض",
  [SESSION_STATUSES.CANCELLED]: "ملغى",
};

/** Customer-facing labels for Orders page and notifications */
const CUSTOMER_STATUS_LABELS = {
  [SESSION_STATUSES.WAITING]: "بانتظار التأكيد",
  [SESSION_STATUSES.WAITING_FOR_STORES]: "بانتظار تأكيد المتجر",
  [SESSION_STATUSES.READY_FOR_PICKUP]: "تم قبول الطلب — بانتظار شركة التوصيل",
  [SESSION_STATUSES.DRIVER_ASSIGNED]: "تم تعيين سائق وسيتوجه إلى المتجر قريباً",
  [SESSION_STATUSES.ACCEPTED]: "مقبول",
  [SESSION_STATUSES.OUT_FOR_DELIVERY]: "طلبك في الطريق",
  [SESSION_STATUSES.COMPLETED]: "تم التسليم",
  [SESSION_STATUSES.REJECTED]: "مرفوض",
  [SESSION_STATUSES.CANCELLED]: "ملغى",
};

/** Company portal labels */
const COMPANY_STATUS_LABELS = {
  ...SESSION_STATUS_LABELS,
  [SESSION_STATUSES.READY_FOR_PICKUP]: "جاهز للاستلام",
  [SESSION_STATUSES.DRIVER_ASSIGNED]: "معيّن لسائق",
  [SESSION_STATUSES.OUT_FOR_DELIVERY]: "قيد التوصيل",
};

const COMPANY_VISIBLE_STATUSES = new Set([
  SESSION_STATUSES.READY_FOR_PICKUP,
  SESSION_STATUSES.DRIVER_ASSIGNED,
  SESSION_STATUSES.ACCEPTED,
  SESSION_STATUSES.OUT_FOR_DELIVERY,
  SESSION_STATUSES.COMPLETED,
  SESSION_STATUSES.REJECTED,
  SESSION_STATUSES.CANCELLED,
]);

const NEW_COMPANY_REQUEST_STATUSES = new Set([SESSION_STATUSES.READY_FOR_PICKUP, "waiting_for_acceptance"]);

const ACCEPTED_COMPANY_STATUSES = new Set([SESSION_STATUSES.ACCEPTED]);

const ASSIGNED_COMPANY_STATUSES = new Set([SESSION_STATUSES.DRIVER_ASSIGNED]);

const OUT_FOR_DELIVERY_STATUSES = new Set([
  SESSION_STATUSES.OUT_FOR_DELIVERY,
  "collecting_orders",
  "on_delivery",
  "on_the_way",
]);

const DELIVERED_SESSION_STATUSES = new Set([SESSION_STATUSES.COMPLETED, "delivered"]);

const REJECTED_SESSION_STATUSES = new Set([SESSION_STATUSES.REJECTED]);

const TERMINAL_SESSION_STATUSES = new Set([
  SESSION_STATUSES.COMPLETED,
  SESSION_STATUSES.REJECTED,
  SESSION_STATUSES.CANCELLED,
  "delivered",
]);

const CUSTOMER_ACTIVE_STATUSES = new Set([
  SESSION_STATUSES.WAITING,
  SESSION_STATUSES.WAITING_FOR_STORES,
  SESSION_STATUSES.READY_FOR_PICKUP,
  SESSION_STATUSES.DRIVER_ASSIGNED,
  SESSION_STATUSES.ACCEPTED,
  SESSION_STATUSES.OUT_FOR_DELIVERY,
]);

/** Store order statuses that count as approved for delivery readiness */
const STORE_APPROVED_STATUSES = new Set([
  "store_accepted",
  "ready_for_delivery_pickup",
  "ready_for_driver_pickup",
  "delivery_handover_complete",
  "confirmed",
  "preparing",
  "delivered_to_driver",
  "delivered_to_customer",
]);

/** Store order statuses where driver can collect */
const STORE_READY_FOR_COLLECTION_STATUSES = new Set([
  "ready_for_driver_pickup",
  "delivery_handover_complete",
  "preparing",
  "delivered_to_driver",
  "store_accepted",
  "ready_for_delivery_pickup",
  "confirmed",
]);

const STORE_STOP_LABELS = {
  pending: "بانتظار التأكيد",
  store_accepted: "تم قبول المتجر",
  ready_for_delivery_pickup: "جاهز للتسليم — شركة التوصيل",
  ready_for_driver_pickup: "جاهز لاستلام السائق",
  delivery_handover_complete: "اكتمل تسليم الطلب للسائق",
  preparing: "قيد التحضير",
  delivered_to_driver: "تم التسليم للسائق",
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

const SENT_ORDER_STATUSES = OUT_FOR_DELIVERY_STATUSES;

function allStopsCollected(stops = []) {
  if (!stops.length) return false;
  return stops.every((s) => s.collectionStatus === "collected");
}

function getCustomerStatusLabel(status) {
  const normalized = normalizeSessionStatus(status);
  return CUSTOMER_STATUS_LABELS[normalized] || SESSION_STATUS_LABELS[normalized] || normalized;
}

function getCompanyStatusLabel(status) {
  const normalized = normalizeSessionStatus(status);
  return COMPANY_STATUS_LABELS[normalized] || SESSION_STATUS_LABELS[normalized] || normalized;
}

module.exports = {
  SESSION_STATUSES,
  SESSION_STATUS_VALUES,
  LEGACY_STATUS_ALIASES,
  SESSION_STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  COMPANY_STATUS_LABELS,
  COMPANY_VISIBLE_STATUSES,
  NEW_COMPANY_REQUEST_STATUSES,
  ACCEPTED_COMPANY_STATUSES,
  ASSIGNED_COMPANY_STATUSES,
  OUT_FOR_DELIVERY_STATUSES,
  SENT_ORDER_STATUSES,
  DELIVERED_SESSION_STATUSES,
  REJECTED_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  CUSTOMER_ACTIVE_STATUSES,
  STORE_APPROVED_STATUSES,
  STORE_READY_FOR_COLLECTION_STATUSES,
  STORE_STOP_LABELS,
  COLLECTION_STATUS_LABELS,
  PAYMENT_STATUSES,
  normalizeSessionStatus,
  getCustomerStatusLabel,
  getCompanyStatusLabel,
  isStoreApprovedForSession,
  allStoresApproved,
  deriveInitialSubmittedStatus,
  allStopsCollected,
};
