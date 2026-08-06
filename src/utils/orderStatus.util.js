/**
 * Order status state machine.
 *
 * Two parallel fulfillment paths share this table:
 *
 * Legacy / store-managed (pickup, nearby, own driver):
 *   pending → store_accepted → preparing → delivered_to_driver → delivered_to_customer
 *   preparing is optional — store may hand to driver right after acceptance.
 *
 * Company delivery:
 *   pending → ready_for_delivery_pickup → ready_for_driver_pickup
 *          → delivery_handover_complete → delivered_to_customer
 *
 * Legacy aliases: confirmed ≡ store_accepted, delivered ≡ delivered_to_customer.
 * delivered_to_driver from ready_for_driver_pickup is accepted as an alias for
 * delivery_handover_complete (older store clients).
 */

const ACTIVE_STATUSES = new Set([
  'pending',
  'store_accepted',
  'ready_for_delivery_pickup',
  'ready_for_driver_pickup',
  'delivery_handover_complete',
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
  'ready_for_delivery_pickup',
  'ready_for_driver_pickup',
  'delivery_handover_complete',
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
  pending: new Set([
    'store_accepted',
    'ready_for_delivery_pickup',
    'confirmed',
    'rejected',
    'cancelled',
  ]),
  store_accepted: new Set([
    'preparing',
    'delivered_to_driver',
    'delivered_to_customer',
    'ready_for_delivery_pickup',
    'rejected',
    'cancelled',
    'completed_off_platform',
  ]),
  ready_for_delivery_pickup: new Set([
    'ready_for_driver_pickup',
    'preparing',
    'delivered_to_customer',
    'rejected',
    'cancelled',
    'completed_off_platform',
  ]),
  ready_for_driver_pickup: new Set([
    'delivery_handover_complete',
    'delivered_to_driver',
    'rejected',
    'cancelled',
  ]),
  delivery_handover_complete: new Set(['delivered_to_customer', 'cancelled']),
  confirmed: new Set([
    'preparing',
    'delivered_to_driver',
    'delivered_to_customer',
    'delivered',
    'rejected',
    'cancelled',
    'completed_off_platform',
  ]),
  preparing: new Set(['delivered_to_driver', 'delivered_to_customer', 'cancelled']),
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
  if (!fromStatus || !toStatus) return false;
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (from === to) return false;

  return Boolean(
    ALLOWED_TRANSITIONS[fromStatus]?.has(toStatus)
    || ALLOWED_TRANSITIONS[from]?.has(toStatus)
    || ALLOWED_TRANSITIONS[fromStatus]?.has(to)
    || ALLOWED_TRANSITIONS[from]?.has(to)
  );
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status) || ACTIVE_STATUSES.has(normalizeStatus(status));
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status) || TERMINAL_STATUSES.has(normalizeStatus(status));
}

const STATUS_LABELS = {
  pending: 'بانتظار التأكيد',
  store_accepted: 'تم قبول المتجر',
  ready_for_delivery_pickup: 'جاهز للتسليم — شركة التوصيل',
  ready_for_driver_pickup: 'جاهز لاستلام السائق',
  delivery_handover_complete: 'اكتمل تسليم الطلب للسائق',
  preparing: 'قيد التحضير',
  delivered_to_driver: 'تم التسليم للسائق',
  delivered_to_customer: 'تم استلام الطلب بنجاح',
  confirmed: 'مؤكّد',
  rejected: 'مرفوض',
  delivered: 'تم استلام الطلب بنجاح',
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
