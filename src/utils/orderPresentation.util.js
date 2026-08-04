const { toCanonicalStatus } = require('../constants/marketplaceOrder.constants');
const DeliverySession = require('../models/deliverySession');
const {
  normalizeSessionStatus,
  getCustomerStatusLabel,
} = require('../constants/deliverySession.constants');

function summarizeDeliverySession(session) {
  if (!session) return null;
  const plain = typeof session.toObject === 'function' ? session.toObject() : { ...session };
  const status = normalizeSessionStatus(plain.status);
  const assigned = plain.assignedDriver || null;
  const timeline = plain.statusTimeline || [];
  const lastTimeline = timeline[timeline.length - 1];

  return {
    id: plain._id,
    status,
    statusLabel: getCustomerStatusLabel(status),
    driverName: assigned?.name || '',
    driverPhone: assigned?.phone || '',
    driverWhatsapp: assigned?.whatsapp || assigned?.phone || '',
    rejectionReason: plain.rejectionReason || (status === 'rejected' ? lastTimeline?.note || '' : ''),
    lastUpdatedAt: lastTimeline?.at || plain.updatedAt || plain.createdAt,
  };
}

async function enrichOrdersWithDeliverySession(orders) {
  const formatted = (orders || []).map(formatOrderResponse);
  const groupIds = [...new Set(
    formatted.map((o) => o.deliveryGroupId).filter(Boolean).map(String),
  )];
  if (!groupIds.length) return formatted;

  const sessions = await DeliverySession.find({ _id: { $in: groupIds } })
    .select('status statusTimeline assignedDriver rejectionReason updatedAt createdAt')
    .lean();
  const byId = Object.fromEntries(sessions.map((s) => [String(s._id), summarizeDeliverySession(s)]));

  return formatted.map((order) => {
    const delivery = order.deliveryGroupId ? byId[String(order.deliveryGroupId)] : null;
    return {
      ...order,
      deliverySession: delivery,
      deliveryStatus: delivery?.status || null,
      deliveryStatusLabel: delivery?.statusLabel || null,
      deliveryDriverName: delivery?.driverName || '',
      deliveryDriverPhone: delivery?.driverPhone || '',
      deliveryDriverWhatsapp: delivery?.driverWhatsapp || '',
    };
  });
}

function mapOrderItem(item) {
  const purchaseMethod = item.purchaseMethod || 'quantity';
  const price = item.price ?? 0;
  const quantity = item.quantity ?? 0;
  const requestedAmount = item.requestedAmount;
  const subtotal = item.subtotal ?? (
    purchaseMethod === 'price'
      ? Math.round((requestedAmount ?? price) * 100) / 100
      : Math.round(price * quantity * 100) / 100
  );

  return {
    productId: item.productId || item.item,
    itemType: item.itemType,
    productName: item.productName || item.name,
    productImage: item.productImage || item.image || '',
    price,
    quantity,
    purchaseMethod,
    requestedAmount: purchaseMethod === 'price' ? (requestedAmount ?? price) : undefined,
    subtotal,
    // Legacy fields preserved for existing clients
    item: item.item,
    name: item.name || item.productName,
    image: item.image || item.productImage || '',
  };
}

/**
 * Shape an order document for marketplace API responses.
 * Keeps legacy fields and adds canonical snapshot fields.
 */
function formatOrderResponse(order) {
  if (!order) return null;

  const plain = typeof order.toObject === 'function' ? order.toObject() : { ...order };
  const transfer = plain.transferInformation || {};
  const items = (plain.items || []).map(mapOrderItem);
  const subtotal = plain.subtotal ?? plain.total ?? 0;
  const totalAmount = plain.totalAmount ?? plain.total ?? 0;

  return {
    id: plain._id,
    _id: plain._id,
    orderNumber: plain.orderNumber,
    customerId: plain.customer?._id || plain.customer,
    storeId: plain.store?._id || plain.store,
    customerName: plain.customerName || plain.customer?.name || '',
    customerPhone: plain.customerPhone || plain.customer?.phone || '',
    storeName: plain.storeName || plain.store?.name || plain.containerName || '',
    items,
    subtotal,
    totalAmount,
    total: totalAmount,
    currency: plain.currency || 'ILS',
    deliveryMethod: plain.deliveryMethod || '',
    deliveryAddress: plain.deliveryAddress || '',
    deliveryNotes: plain.deliveryNotes || plain.customerNotes || '',
    paymentMethod: plain.paymentMethod || '',
    paymentProofImage: plain.paymentProofImage || plain.paymentProof || '',
    transferName: plain.transferName || transfer.senderName || '',
    transferPhone: plain.transferPhone || transfer.contactNumber || '',
    transferNumber: plain.transferNumber || transfer.referenceNumber || '',
    paymentNotes: plain.paymentNotes || transfer.note || '',
    transferInformation: transfer,
    status: toCanonicalStatus(plain.status),
    legacyStatus: plain.status,
    rejectionReason: plain.rejectionReason || '',
    verificationCode: plain.verificationCode || '',
    paymentStatus: plain.paymentStatus || 'unpaid',
    deliveryGroupId: plain.deliveryGroup || null,
    customerNotes: plain.customerNotes || '',
    storeNotes: plain.storeNotes || '',
    confirmedAt: plain.confirmedAt,
    completedAt: plain.completedAt,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    customer: plain.customer,
    store: plain.store,
  };
}

function formatOrderList(orders) {
  return (orders || []).map(formatOrderResponse);
}

module.exports = {
  formatOrderResponse,
  formatOrderList,
  mapOrderItem,
  enrichOrdersWithDeliverySession,
  summarizeDeliverySession,
};
