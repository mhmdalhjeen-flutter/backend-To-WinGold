/** Canonical delivery methods for marketplace orders. */
const DELIVERY_METHODS = {
  NEARBY_STORE: 'nearby_store',
  PICKUP: 'pickup',
  DELIVERY: 'delivery',
};

const DELIVERY_METHOD_VALUES = Object.values(DELIVERY_METHODS);

/** Legacy checkout values → canonical storage values. */
const DELIVERY_METHOD_ALIASES = {
  nearby: DELIVERY_METHODS.NEARBY_STORE,
  nearby_store: DELIVERY_METHODS.NEARBY_STORE,
  pickup: DELIVERY_METHODS.PICKUP,
  delivery: DELIVERY_METHODS.DELIVERY,
};

/** Canonical payment methods for marketplace orders. */
const PAYMENT_METHODS = {
  CASH_ON_DELIVERY: 'cash_on_delivery',
  SELLER_AGREEMENT: 'seller_agreement',
  BANK: 'bank',
  PALPAY: 'palpay',
  JAWWAL_PAY: 'jawwal_pay',
};

const PAYMENT_METHOD_VALUES = Object.values(PAYMENT_METHODS);

const PAYMENT_METHOD_ALIASES = {
  cash_on_delivery: PAYMENT_METHODS.CASH_ON_DELIVERY,
  seller_agreement: PAYMENT_METHODS.SELLER_AGREEMENT,
  bank: PAYMENT_METHODS.BANK,
  bank_palestine: PAYMENT_METHODS.BANK,
  palpay: PAYMENT_METHODS.PALPAY,
  jawwal_pay: PAYMENT_METHODS.JAWWAL_PAY,
  cash: PAYMENT_METHODS.CASH_ON_DELIVERY,
  transfer: PAYMENT_METHODS.BANK,
};

/**
 * Canonical order statuses exposed by the marketplace order API.
 * Internally mapped to legacy statuses for backward compatibility.
 */
const ORDER_STATUSES = {
  PENDING_REVIEW: 'pending_review',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  COMPLETED: 'completed',
};

const ORDER_STATUS_VALUES = Object.values(ORDER_STATUSES);

/** Legacy DB status → canonical API status. */
const LEGACY_TO_CANONICAL_STATUS = {
  pending: ORDER_STATUSES.PENDING_REVIEW,
  store_accepted: ORDER_STATUSES.CONFIRMED,
  confirmed: ORDER_STATUSES.CONFIRMED,
  preparing: ORDER_STATUSES.CONFIRMED,
  delivered_to_driver: ORDER_STATUSES.CONFIRMED,
  delivered_to_customer: ORDER_STATUSES.COMPLETED,
  delivered: ORDER_STATUSES.COMPLETED,
  completed_off_platform: ORDER_STATUSES.COMPLETED,
  rejected: ORDER_STATUSES.REJECTED,
  cancelled: ORDER_STATUSES.REJECTED,
};

/** Canonical API status → legacy DB status for writes. */
const CANONICAL_TO_LEGACY_STATUS = {
  [ORDER_STATUSES.PENDING_REVIEW]: 'pending',
  [ORDER_STATUSES.CONFIRMED]: 'store_accepted',
  [ORDER_STATUSES.REJECTED]: 'rejected',
  [ORDER_STATUSES.COMPLETED]: 'delivered_to_customer',
};

function normalizeDeliveryMethod(value) {
  if (!value) return '';
  const key = String(value).trim().toLowerCase();
  return DELIVERY_METHOD_ALIASES[key] || (DELIVERY_METHOD_VALUES.includes(key) ? key : '');
}

function normalizePaymentMethod(value) {
  if (!value) return '';
  const key = String(value).trim().toLowerCase();
  return PAYMENT_METHOD_ALIASES[key] || (PAYMENT_METHOD_VALUES.includes(key) ? key : '');
}

function toCanonicalStatus(legacyStatus) {
  return LEGACY_TO_CANONICAL_STATUS[legacyStatus] || legacyStatus;
}

function toLegacyStatus(canonicalStatus) {
  return CANONICAL_TO_LEGACY_STATUS[canonicalStatus] || canonicalStatus;
}

module.exports = {
  DELIVERY_METHODS,
  DELIVERY_METHOD_VALUES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  ORDER_STATUSES,
  ORDER_STATUS_VALUES,
  normalizeDeliveryMethod,
  normalizePaymentMethod,
  toCanonicalStatus,
  toLegacyStatus,
};
