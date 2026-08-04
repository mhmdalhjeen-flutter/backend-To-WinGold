const ACTIVE_STATUSES = new Set([
  'pending',
  'store_accepted',
  'confirmed',
  'preparing',
  'delivered_to_driver',
]);

const TERMINAL_STATUSES = new Set([
  'delivered_to_customer',
  'delivered',
  'rejected',
  'cancelled',
  'completed_off_platform',
]);

const ALLOWED_STATUSES = [
  'pending',
  'store_accepted',
  'preparing',
  'delivered_to_driver',
  'delivered_to_customer',
  'confirmed',
  'rejected',
  'delivered',
  'cancelled',
  'completed_off_platform',
];

const ALLOWED_TRANSITIONS = {
  pending: new Set(['store_accepted', 'confirmed', 'rejected', 'cancelled']),
  store_accepted: new Set(['preparing', 'rejected', 'cancelled']),
  confirmed: new Set(['preparing', 'rejected', 'cancelled', 'delivered', 'completed_off_platform']),
  preparing: new Set(['delivered_to_driver', 'cancelled']),
  delivered_to_driver: new Set(['delivered_to_customer']),
  delivered_to_customer: new Set([]),
  delivered: new Set([]),
  rejected: new Set([]),
  cancelled: new Set([]),
  completed_off_platform: new Set([]),
};

function normalizeStatus(status) {
  if (status === 'confirmed') return 'store_accepted';
  if (status === 'delivered') return 'delivered_to_customer';
  return status;
}

function canTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[fromStatus]?.has(toStatus)
    || ALLOWED_TRANSITIONS[from]?.has(toStatus)
    || ALLOWED_TRANSITIONS[fromStatus]?.has(to)
    || false;
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

const STATUS_LABELS = {
  pending: 'بانتظار التأكيد',
  store_accepted: 'تم قبول المتجر',
  preparing: 'قيد التحضير',
  delivered_to_driver: 'تم التسليم للسائق',
  delivered_to_customer: 'تم التسليم للزبون',
  confirmed: 'مؤكّد',
  rejected: 'مرفوض',
  delivered: 'تم التسليم',
  cancelled: 'ملغى',
  completed_off_platform: 'اكتمل خارج المنصة',
};

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_STATUSES,
  ALLOWED_TRANSITIONS,
  STATUS_LABELS,
  normalizeStatus,
  canTransition,
  isActiveStatus,
  isTerminalStatus,
};
