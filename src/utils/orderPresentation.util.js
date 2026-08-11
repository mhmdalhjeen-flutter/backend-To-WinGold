const { toCanonicalStatus, normalizePaymentMethod } = require('../constants/marketplaceOrder.constants');
const DeliverySession = require('../models/deliverySession');
const DeliveryCompany = require('../models/deliveryCompany');
const DeliveryCompanyDriver = require('../models/deliveryCompanyDriver');
const User = require('../models/user');
const {
  normalizeSessionStatus,
  getCustomerStatusLabel,
} = require('../constants/deliverySession.constants');
const {
  buildCustomerOrderTimeline,
  getCustomerDeliveryStatusMessage,
} = require('./orderTimeline.util');

function summarizeDeliverySession(session, company = null, chatTargets = {}) {
  if (!session) return null;
  const plain = typeof session.toObject === 'function' ? session.toObject() : { ...session };
  const status = normalizeSessionStatus(plain.status);
  const assigned = plain.assignedDriver || null;
  const timeline = plain.statusTimeline || [];
  const lastTimeline = timeline[timeline.length - 1];
  const companyPlain = company || plain.deliveryCompany;
  const driverId = assigned?.driverId ? String(assigned.driverId) : '';
  const companyId = plain.deliveryCompany ? String(plain.deliveryCompany) : '';

  const summary = {
    id: plain._id,
    status,
    statusLabel: getCustomerStatusLabel(status),
    statusTimeline: timeline,
    driverName: assigned?.name || '',
    driverPhone: assigned?.phone || '',
    driverWhatsapp: assigned?.whatsapp || assigned?.phone || '',
    assignedDriver: assigned
      ? {
          ...assigned,
          userId: chatTargets.driverUsers?.[driverId] || assigned.userId || null,
        }
      : null,
    rejectionReason: plain.rejectionReason || (status === 'rejected' ? lastTimeline?.note || '' : ''),
    lastUpdatedAt: lastTimeline?.at || plain.updatedAt || plain.createdAt,
    companyName: companyPlain?.name || '',
    companyPhone: companyPlain?.phone || '',
    companyWhatsapp: companyPlain?.whatsapp || companyPlain?.phone || '',
    companyChatUserId: chatTargets.companyUsers?.[companyId] || null,
  };

  return summary;
}

async function loadDeliveryChatTargets(sessions = []) {
  const driverIds = [...new Set(
    sessions
      .map((s) => s.assignedDriver?.driverId)
      .filter(Boolean)
      .map(String),
  )];
  const companyIds = [...new Set(
    sessions.map((s) => s.deliveryCompany).filter(Boolean).map(String),
  )];

  const [drivers, companyUsers] = await Promise.all([
    driverIds.length
      ? DeliveryCompanyDriver.find({ _id: { $in: driverIds } }).select('userId').lean()
      : [],
    companyIds.length
      ? User.find({ role: 'delivery_company', deliveryCompanyId: { $in: companyIds } })
        .select('_id deliveryCompanyId')
        .lean()
      : [],
  ]);

  const driverUsers = Object.fromEntries(
    drivers.filter((d) => d.userId).map((d) => [String(d._id), String(d.userId)]),
  );
  const companyUsersMap = Object.fromEntries(
    companyUsers.map((u) => [String(u.deliveryCompanyId), String(u._id)]),
  );

  return { driverUsers, companyUsers: companyUsersMap };
}

async function enrichOrdersWithDeliverySession(orders) {
  const formatted = (orders || []).map(formatOrderResponse);
  const groupIds = [...new Set(
    formatted.map((o) => o.deliveryGroupId).filter(Boolean).map(String),
  )];
  if (!groupIds.length) return formatted.map(enrichOrderDeliveryFields);

  const sessions = await DeliverySession.find({ _id: { $in: groupIds } })
    .select('status statusTimeline assignedDriver rejectionReason updatedAt createdAt deliveryCompany')
    .lean();

  const companyIds = [...new Set(sessions.map((s) => String(s.deliveryCompany)).filter(Boolean))];
  const companies = companyIds.length
    ? await DeliveryCompany.find({ _id: { $in: companyIds } }).select('name phone whatsapp').lean()
    : [];
  const companyById = Object.fromEntries(companies.map((c) => [String(c._id), c]));
  const chatTargets = await loadDeliveryChatTargets(sessions);

  const byId = Object.fromEntries(
    sessions.map((s) => [
      String(s._id),
      summarizeDeliverySession(s, companyById[String(s.deliveryCompany)], chatTargets),
    ]),
  );

  return formatted.map((order) => enrichOrderDeliveryFields(order, byId[String(order.deliveryGroupId)]));
}

function enrichOrderDeliveryFields(order, delivery = null) {
  const deliveryStatusMessage = getCustomerDeliveryStatusMessage(order, delivery);
  const timeline = buildCustomerOrderTimeline(order, delivery);

  return {
    ...order,
    deliverySession: delivery,
    deliveryStatus: delivery?.status || null,
    deliveryStatusLabel: delivery?.statusLabel || deliveryStatusMessage?.title || null,
    deliveryStatusMessage,
    deliveryDriverName: delivery?.driverName || '',
    deliveryDriverPhone: delivery?.driverPhone || '',
    deliveryDriverWhatsapp: delivery?.driverWhatsapp || '',
    deliveryCompanyName: delivery?.companyName || '',
    deliveryCompanyPhone: delivery?.companyPhone || '',
    deliveryCompanyWhatsapp: delivery?.companyWhatsapp || '',
    deliveryCompanyChatUserId: delivery?.companyChatUserId || null,
    deliveryDriverChatUserId: delivery?.assignedDriver?.userId || null,
    orderTimeline: timeline,
  };
}

async function enrichSingleOrder(order, options = {}) {
  const formatted = formatOrderResponse(order);
  if (!formatted.deliveryGroupId) {
    return enrichOrderDeliveryFields({
      ...formatted,
      statusTimeline: order.statusTimeline || [],
    });
  }

  const session = await DeliverySession.findById(formatted.deliveryGroupId)
    .select('status statusTimeline assignedDriver rejectionReason updatedAt createdAt deliveryCompany')
    .lean();

  let company = null;
  if (session?.deliveryCompany) {
    company = await DeliveryCompany.findById(session.deliveryCompany).select('name phone whatsapp').lean();
  }

  const chatTargets = await loadDeliveryChatTargets(session ? [session] : []);
  const delivery = session ? summarizeDeliverySession(session, company, chatTargets) : null;
  const enriched = enrichOrderDeliveryFields({
    ...formatted,
    statusTimeline: order.statusTimeline || [],
  }, delivery);

  if (options.forStore) {
    const hasDriver = Boolean(
      delivery?.assignedDriver?.driverId
      || delivery?.assignedDriver?.name
      || delivery?.driverName
    );
    enriched.canHandToDriver = enriched.legacyStatus === "ready_for_driver_pickup" && hasDriver;
    enriched.storeStatusLabel = getStoreStatusLabel(enriched.legacyStatus);
  }

  return enriched;
}

function getStoreStatusLabel(legacyStatus) {
  const labels = {
    pending: 'بانتظار التأكيد',
    modification_requested: 'يحتاج تعديل من الزبون',
    store_accepted: 'تم قبول المتجر',
    ready_for_delivery_pickup: 'جاهز للتسليم — شركة التوصيل',
    ready_for_driver_pickup: 'جاهز لاستلام السائق',
    delivery_handover_complete: 'اكتمل تسليم الطلب للسائق',
    preparing: 'قيد التحضير',
    delivered_to_driver: 'تم التسليم للسائق',
    delivered_to_customer: 'تم استلام الطلب بنجاح',
    confirmed: 'مؤكّد',
    rejected: 'مرفوض',
    cancelled: 'ملغى',
    delivered: 'تم استلام الطلب بنجاح',
    completed_off_platform: 'اكتمل خارج المنصة',
  };
  return labels[legacyStatus] || legacyStatus;
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
    item: item.item,
    name: item.name || item.productName,
    image: item.image || item.productImage || '',
  };
}

function computeTotalPaid(plain) {
  const original = plain.originalTotal != null
    ? plain.originalTotal
    : (plain.totalAmount ?? plain.total ?? 0);
  const differenceSum = (plain.paymentTransactions || [])
    .filter((t) => t.type === 'difference')
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  return Math.round((original + differenceSum) * 100) / 100;
}

function formatOrderResponse(order) {
  if (!order) return null;

  const plain = typeof order.toObject === 'function' ? order.toObject() : { ...order };
  const transfer = plain.transferInformation || {};
  const items = (plain.items || []).map(mapOrderItem);
  const subtotal = plain.subtotal ?? plain.total ?? 0;
  const totalAmount = plain.totalAmount ?? plain.total ?? 0;
  const totalPaid = computeTotalPaid(plain);
  const paymentSurplus = Math.round(Math.max(0, totalPaid - totalAmount) * 100) / 100;
  const digitalMethods = new Set(['bank', 'palpay', 'jawwal_pay']);
  const hasPaymentSurplus = paymentSurplus > 0
    && digitalMethods.has(normalizePaymentMethod(plain.paymentMethod));

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
    statusTimeline: plain.statusTimeline || [],
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
    modificationRequest: plain.modificationRequest || null,
    orderChangeHistory: plain.orderChangeHistory || [],
    originalTotal: plain.originalTotal,
    additionalPaymentAmount: plain.additionalPaymentAmount || 0,
    additionalPayment: plain.additionalPayment || null,
    paymentTransactions: plain.paymentTransactions || [],
    totalPaid,
    paymentSurplus,
    hasPaymentSurplus,
    refundAvailable: false,
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
  enrichSingleOrder,
  summarizeDeliverySession,
  getStoreStatusLabel,
};
