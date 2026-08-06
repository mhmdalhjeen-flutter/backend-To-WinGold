const { DELIVERY_METHODS } = require('../constants/marketplaceOrder.constants');
const {
  SESSION_STATUSES,
  normalizeSessionStatus,
} = require('../constants/deliverySession.constants');

const TIMELINE_STEP_DEFS = [
  { key: 'order_sent', label: 'تم إرسال الطلب' },
  { key: 'store_accepted', label: 'قبل المتجر الطلب' },
  { key: 'waiting_company', label: 'بانتظار شركة التوصيل' },
  { key: 'driver_assigned', label: 'تم تعيين السائق' },
  { key: 'driver_collected', label: 'استلم السائق الطلب' },
  { key: 'on_the_way', label: 'الطلب في الطريق' },
  { key: 'delivered', label: 'تم استلام الطلب بنجاح' },
];

const POST_PENDING_STATUSES = new Set([
  'store_accepted',
  'ready_for_delivery_pickup',
  'ready_for_driver_pickup',
  'delivery_handover_complete',
  'preparing',
  'delivered_to_driver',
  'delivered_to_customer',
  'confirmed',
  'delivered',
  'completed_off_platform',
]);

const DRIVER_ASSIGNED_ORDER_STATUSES = new Set([
  'ready_for_driver_pickup',
  'delivery_handover_complete',
  'delivered_to_driver',
  'delivered_to_customer',
  'delivered',
]);

const COLLECTED_ORDER_STATUSES = new Set([
  'delivery_handover_complete',
  'delivered_to_driver',
  'delivered_to_customer',
  'delivered',
]);

const DELIVERED_ORDER_STATUSES = new Set([
  'delivered_to_customer',
  'delivered',
  'completed_off_platform',
]);

function findTimelineAt(orderTimeline, status) {
  const entry = (orderTimeline || []).find((t) => t.status === status);
  return entry?.at || null;
}

function resolveCurrentStepKey(order, delivery) {
  const legacyStatus = order?.legacyStatus || order?.status || 'pending';
  const sessionStatus = delivery ? normalizeSessionStatus(delivery.status) : null;

  if (DELIVERED_ORDER_STATUSES.has(legacyStatus) || sessionStatus === SESSION_STATUSES.COMPLETED) {
    return 'delivered';
  }

  if (
    sessionStatus === SESSION_STATUSES.OUT_FOR_DELIVERY
    || COLLECTED_ORDER_STATUSES.has(legacyStatus)
  ) {
    return 'on_the_way';
  }

  if (
    sessionStatus === SESSION_STATUSES.DRIVER_ASSIGNED
    || DRIVER_ASSIGNED_ORDER_STATUSES.has(legacyStatus)
  ) {
    if (COLLECTED_ORDER_STATUSES.has(legacyStatus)) return 'driver_collected';
    return 'driver_assigned';
  }

  if (
    legacyStatus === 'ready_for_delivery_pickup'
    || sessionStatus === SESSION_STATUSES.READY_FOR_PICKUP
    || sessionStatus === SESSION_STATUSES.WAITING_FOR_STORES
  ) {
    return 'waiting_company';
  }

  if (POST_PENDING_STATUSES.has(legacyStatus)) {
    return 'store_accepted';
  }

  return 'order_sent';
}

function buildCustomerOrderTimeline(order, delivery) {
  const currentKey = resolveCurrentStepKey(order, delivery);
  const orderTimeline = order?.statusTimeline || [];
  const sessionTimeline = delivery?.statusTimeline || [];
  const currentIdx = TIMELINE_STEP_DEFS.findIndex((s) => s.key === currentKey);

  const steps = TIMELINE_STEP_DEFS.map((step, idx) => {
    let at = null;
    if (step.key === 'order_sent') at = order?.createdAt;
    if (step.key === 'store_accepted') {
      at = findTimelineAt(orderTimeline, 'ready_for_delivery_pickup')
        || findTimelineAt(orderTimeline, 'store_accepted')
        || order?.confirmedAt;
    }
    if (step.key === 'waiting_company') {
      at = findTimelineAt(sessionTimeline, SESSION_STATUSES.WAITING_FOR_STORES)
        || findTimelineAt(sessionTimeline, SESSION_STATUSES.READY_FOR_PICKUP);
    }
    if (step.key === 'driver_assigned') {
      at = findTimelineAt(sessionTimeline, SESSION_STATUSES.DRIVER_ASSIGNED)
        || findTimelineAt(orderTimeline, 'ready_for_driver_pickup')
        || delivery?.assignedDriver?.assignedAt;
    }
    if (step.key === 'driver_collected') {
      at = findTimelineAt(orderTimeline, 'delivery_handover_complete')
        || findTimelineAt(orderTimeline, 'delivered_to_driver');
    }
    if (step.key === 'on_the_way') {
      at = findTimelineAt(sessionTimeline, SESSION_STATUSES.OUT_FOR_DELIVERY);
    }
    if (step.key === 'delivered') {
      at = order?.completedAt
        || findTimelineAt(orderTimeline, 'delivered_to_customer')
        || findTimelineAt(sessionTimeline, SESSION_STATUSES.COMPLETED);
    }

    const completed = idx <= currentIdx;
    const active = idx === currentIdx;

    return {
      key: step.key,
      label: step.label,
      completed,
      active,
      at,
    };
  });

  return {
    steps,
    currentStep: currentKey,
    currentStepLabel: TIMELINE_STEP_DEFS.find((s) => s.key === currentKey)?.label || '',
  };
}

function getCustomerDeliveryStatusMessage(order, delivery) {
  if (!order || order.deliveryMethod !== DELIVERY_METHODS.DELIVERY) return null;

  const legacyStatus = order.legacyStatus || order.status;
  const sessionStatus = delivery ? normalizeSessionStatus(delivery.status) : null;
  const assigned = delivery?.assignedDriver || null;

  const carrier = {
    driverName: assigned?.name || delivery?.driverName || '',
    driverPhone: assigned?.phone || delivery?.driverPhone || '',
    driverWhatsapp: assigned?.whatsapp || delivery?.driverWhatsapp || assigned?.phone || '',
    companyName: delivery?.companyName || '',
    companyPhone: delivery?.companyPhone || '',
    companyWhatsapp: delivery?.companyWhatsapp || delivery?.companyPhone || '',
  };

  if (
    sessionStatus === SESSION_STATUSES.OUT_FOR_DELIVERY
    || legacyStatus === 'delivery_handover_complete'
    || legacyStatus === 'delivered_to_driver'
  ) {
    return {
      title: 'الطلب في الطريق',
      body: carrier.driverName
        ? `${carrier.driverName} يقوم بتوصيل طلبك الآن`
        : 'الطلب في الطريق إليك',
      ...carrier,
    };
  }

  if (sessionStatus === SESSION_STATUSES.DRIVER_ASSIGNED || legacyStatus === 'ready_for_driver_pickup') {
    return {
      title: 'تم تعيين سائق وسيتوجه إلى المتجر قريباً',
      body: carrier.driverName
        ? `السائق ${carrier.driverName} متوجه إلى المتجر لاستلام طلبك`
        : 'تم تعيين سائق وسيتوجه إلى المتجر قريباً',
      ...carrier,
    };
  }

  if (sessionStatus === SESSION_STATUSES.READY_FOR_PICKUP || legacyStatus === 'ready_for_delivery_pickup') {
    return {
      title: 'تم قبول الطلب — بانتظار شركة التوصيل',
      body: 'بانتظار تعيين سائق من شركة التوصيل',
      ...carrier,
    };
  }

  if (sessionStatus === SESSION_STATUSES.WAITING_FOR_STORES || legacyStatus === 'pending') {
    return {
      title: legacyStatus === 'pending' ? 'بانتظار تأكيد المتجر' : 'بانتظار شركة التوصيل',
      body: legacyStatus === 'pending'
        ? 'تم إرسال طلبك إلى المتجر'
        : 'بانتظار موافقة شركة التوصيل',
      ...carrier,
    };
  }

  if (DELIVERED_ORDER_STATUSES.has(legacyStatus) || sessionStatus === SESSION_STATUSES.COMPLETED) {
    return {
      title: 'تم استلام الطلب بنجاح',
      body: 'تم استلام طلبك بنجاح',
      ...carrier,
    };
  }

  return null;
}

module.exports = {
  TIMELINE_STEP_DEFS,
  buildCustomerOrderTimeline,
  getCustomerDeliveryStatusMessage,
  resolveCurrentStepKey,
};
