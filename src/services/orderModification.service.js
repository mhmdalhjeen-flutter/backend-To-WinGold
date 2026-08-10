const Order = require("../models/order");
const Store = require("../models/store");
const notificationService = require("./notification.service");
const cartService = require("./cart.service");
const {
  normalizeDeliveryMethod,
  normalizePaymentMethod,
  PAYMENT_METHODS,
  DELIVERY_METHODS,
} = require("../constants/marketplaceOrder.constants");
const { assertNoMongoOperators, requireObjectId, cleanString } = require("../utils/inputSecurity.util");
const { canTransition } = require("../utils/orderStatus.util");
const { formatOrderResponse } = require("../utils/orderPresentation.util");
const { syncOrderContentsInSessions } = require("./deliverySession.service");

const MODIFICATION_REASONS = {
  AREA_TOO_FAR: "area_too_far",
  ITEMS_UNAVAILABLE: "items_unavailable",
  PAYMENT_METHOD_CHANGE_SUGGESTED: "payment_method_change_suggested",
  PAYMENT_DATA_REVIEW: "payment_data_review",
};

const PAYMENT_METHOD_DECISIONS = {
  KEEP_CURRENT: "keep_current",
  ACCEPT_SUGGESTED: "accept_suggested",
  CHOOSE_METHOD: "choose_method",
};

const AREA_TOO_FAR_MESSAGE = "المنطقة بعيدة عن المتجر، يرجى تغيير طريقة التوصيل.";

const DIGITAL_UNDER_BUDGET_MESSAGE =
  "عند الدفع الإلكتروني يجب أن تكون قيمة البدائل مساوية أو أعلى من المبلغ المتاح للاستبدال — لا يُسترد الفرق تلقائياً.";

const FLEXIBLE_PAYMENT_METHODS = new Set([
  PAYMENT_METHODS.CASH_ON_DELIVERY,
  PAYMENT_METHODS.SELLER_AGREEMENT,
]);

const DIGITAL_PAYMENT_METHODS = new Set([
  PAYMENT_METHODS.BANK,
  PAYMENT_METHODS.PALPAY,
  PAYMENT_METHODS.JAWWAL_PAY,
]);

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function itemLineTotal(item) {
  if (item.subtotal != null) return roundMoney(item.subtotal);
  if (item.purchaseMethod === "price") {
    return roundMoney(item.requestedAmount ?? item.price ?? 0);
  }
  return roundMoney((item.price || 0) * (item.quantity || 0));
}

function pushChangeHistory(order, entry) {
  const list = Array.isArray(order.orderChangeHistory) ? [...order.orderChangeHistory] : [];
  list.push({
    at: new Date(),
    type: entry.type,
    note: entry.note || "",
    actor: entry.actor || "system",
    meta: entry.meta || null,
  });
  return list;
}

function pushTimeline(order, status, note = "") {
  const list = Array.isArray(order.statusTimeline) ? [...order.statusTimeline] : [];
  list.push({ status, at: new Date(), note });
  return list;
}

function isFlexiblePayment(method) {
  return FLEXIBLE_PAYMENT_METHODS.has(normalizePaymentMethod(method));
}

function isDigitalPayment(method) {
  return DIGITAL_PAYMENT_METHODS.has(normalizePaymentMethod(method));
}

function getOrderPaidAmount(order) {
  if (order.originalTotal != null) return roundMoney(order.originalTotal);
  return roundMoney(order.totalAmount ?? order.total ?? 0);
}

function getDifferenceTransactionsTotal(order) {
  const txs = Array.isArray(order.paymentTransactions) ? order.paymentTransactions : [];
  return roundMoney(
    txs
      .filter((t) => t.type === "difference")
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
  );
}

function getTotalPaidSoFar(order) {
  return roundMoney(getOrderPaidAmount(order) + getDifferenceTransactionsTotal(order));
}

/** Record a client operation id only when the modification is about to persist. */
function stampClientOperationId(order, clientOperationId) {
  if (!clientOperationId) return;
  order.appliedModificationOps = [
    ...(order.appliedModificationOps || []),
    clientOperationId,
  ];
}

/**
 * Payment totals for modification previews/resolves.
 * When replacements cost less than the unavailable credit, digital orders may
 * show a surplus (customer paid more than the revised invoice). There is no
 * automated refund path — surplus is informational for store review only.
 */
function buildPaymentSummary(order, newOrderTotal, additionalNeeded = 0) {
  const originalTotal = getOrderPaidAmount(order);
  const totalPaidSoFar = getTotalPaidSoFar(order);
  const paymentSurplus = roundMoney(Math.max(0, totalPaidSoFar - newOrderTotal));
  const digital = isDigitalPayment(order.paymentMethod);

  return {
    originalTotal,
    totalPaidSoFar,
    newOrderTotal: roundMoney(newOrderTotal),
    additionalNeeded: roundMoney(additionalNeeded),
    paymentSurplus,
    hasPaymentSurplus: paymentSurplus > 0 && digital,
    refundAvailable: false,
  };
}

function assertElectronicReplacementAllowed(order, replacementTotal, availableAmount) {
  if (!isDigitalPayment(order.paymentMethod)) return;
  if (replacementTotal > 0 && replacementTotal < availableAmount) {
    const err = new Error(DIGITAL_UNDER_BUDGET_MESSAGE);
    err.status = 400;
    err.electronicUnderBudgetBlocked = true;
    throw err;
  }
}

function hasDifferencePaymentDetails(payment = {}) {
  const transfer = payment.transferInformation || {};
  const senderName = String(transfer.senderName || "").trim();
  const contactNumber = String(transfer.contactNumber || "").trim();
  const referenceNumber = String(transfer.referenceNumber || "").trim();
  return Boolean(
    payment.proof
    || referenceNumber
    || (senderName && contactNumber)
  );
}

function applyPaymentFieldsToOrder(order, payment, { paymentMethod } = {}) {
  if (paymentMethod) {
    order.paymentMethod = normalizePaymentMethod(paymentMethod);
  }
  if (payment.proof) {
    order.paymentProof = payment.proof;
    order.paymentProofImage = payment.proof;
  }
  const transfer = payment.transferInformation || {};
  order.transferInformation = {
    senderName: transfer.senderName || "",
    contactNumber: transfer.contactNumber || "",
    referenceNumber: transfer.referenceNumber || "",
    note: transfer.note || "",
  };
  order.transferName = order.transferInformation.senderName;
  order.transferPhone = order.transferInformation.contactNumber;
  order.transferNumber = order.transferInformation.referenceNumber;
  if (transfer.note) order.paymentNotes = transfer.note;
  order.paymentStatus = payment.proof ? "pending" : (order.paymentStatus || "unpaid");
}

function pushPaymentTransaction(order, entry) {
  const txs = Array.isArray(order.paymentTransactions) ? [...order.paymentTransactions] : [];
  txs.push(entry);
  order.paymentTransactions = txs;
  return txs;
}

async function assertStorePaymentMethodEnabled(storeId, method) {
  const paymentMethodService = require("./storePaymentMethod.service");
  const { enabledPaymentMethods } = await paymentMethodService.buildPaymentSettingsForStore(storeId);
  const normalized = normalizePaymentMethod(method);
  const enabled = new Set(
    (enabledPaymentMethods || []).map((id) => {
      if (id === "bank_palestine") return PAYMENT_METHODS.BANK;
      return normalizePaymentMethod(id);
    })
  );
  if (!enabled.has(normalized)) {
    const err = new Error("طريقة الدفع المقترحة غير مفعّلة لدى المتجر");
    err.status = 400;
    throw err;
  }
}

function seedOriginalPaymentTransaction(order) {
  if (!isDigitalPayment(order.paymentMethod)) return order.paymentTransactions || [];
  const txs = Array.isArray(order.paymentTransactions) ? [...order.paymentTransactions] : [];
  if (txs.length > 0) return txs;

  const amount = order.originalTotal != null
    ? roundMoney(order.originalTotal)
    : roundMoney(order.totalAmount ?? order.total ?? 0);

  txs.push({
    type: "original",
    amount,
    method: normalizePaymentMethod(order.paymentMethod),
    proof: order.paymentProof || order.paymentProofImage || "",
    transferInformation: order.transferInformation || {},
    paidAt: order.createdAt || new Date(),
    note: "",
  });
  return txs;
}

function isNearbyStoreDelivery(method) {
  return normalizeDeliveryMethod(method) === DELIVERY_METHODS.NEARBY_STORE;
}

async function getStoreForOwner(ownerId) {
  const store = await Store.findOne({ owner: ownerId }).select("_id name");
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }
  return store;
}

async function notifyCustomer(order, store, { type, title, body, extra = {} }) {
  try {
    await notificationService.create({
      user: order.customer,
      type,
      title,
      body,
      data: {
        orderId: order._id.toString(),
        storeId: store._id.toString(),
        ...extra,
      },
    });
  } catch (_) {
    /* non-critical */
  }
}

async function notifyStore(order, store, { type, title, body, extra = {} }) {
  try {
    const ownerId = store.owner || (await Store.findById(store._id || store).select("owner").lean())?.owner;
    if (!ownerId) return;
    await notificationService.create({
      user: ownerId,
      type,
      title,
      body,
      data: {
        orderId: order._id.toString(),
        storeId: String(store._id || store),
        pushApp: "store",
        ...extra,
      },
    });
  } catch (_) {
    /* non-critical */
  }
}

/**
 * Store owner requests customer modification.
 */
async function requestModification(ownerId, orderId, body = {}) {
  assertNoMongoOperators(body, "modification");
  const store = await getStoreForOwner(ownerId);
  const reason = cleanString(body.reason, { field: "reason", max: 64 }) || "";

  if (!Object.values(MODIFICATION_REASONS).includes(reason)) {
    const err = new Error("سبب التعديل غير صالح");
    err.status = 400;
    throw err;
  }

  const order = await Order.findOne({ _id: orderId, store: store._id });
  if (!order) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  if (order.status !== "pending") {
    const err = new Error("يمكن طلب التعديل فقط للطلبات قيد المراجعة");
    err.status = 400;
    throw err;
  }

  if (!canTransition(order.status, "modification_requested")) {
    const err = new Error("لا يمكن طلب تعديل لهذا الطلب");
    err.status = 400;
    throw err;
  }

  if (reason === MODIFICATION_REASONS.PAYMENT_METHOD_CHANGE_SUGGESTED) {
    return requestPaymentMethodChange(order, store, body);
  }
  if (reason === MODIFICATION_REASONS.PAYMENT_DATA_REVIEW) {
    return requestPaymentDataReview(order, store, body);
  }

  let message = "";
  let unavailableItemIndexes = [];
  let unavailableItems = [];

  if (reason === MODIFICATION_REASONS.AREA_TOO_FAR) {
    if (!isNearbyStoreDelivery(order.deliveryMethod)) {
      const err = new Error("سبب «المنطقة بعيدة» مسموح فقط لطلبات التوصيل من متجر قريب");
      err.status = 400;
      throw err;
    }
    message = AREA_TOO_FAR_MESSAGE;
  } else {
    const indexes = Array.isArray(body.unavailableItemIndexes)
      ? body.unavailableItemIndexes.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0)
      : [];
    const unique = [...new Set(indexes)];
    if (!unique.length) {
      const err = new Error("يرجى تحديد المنتجات غير المتوفرة");
      err.status = 400;
      throw err;
    }
    for (const idx of unique) {
      if (idx >= order.items.length) {
        const err = new Error("فهرس منتج غير صالح");
        err.status = 400;
        throw err;
      }
      const item = order.items[idx];
      unavailableItems.push({
        index: idx,
        item: item.item,
        itemType: item.itemType,
        name: item.name || item.productName || "",
        quantity: item.quantity,
        price: item.price,
        subtotal: itemLineTotal(item),
        image: item.image || item.productImage || "",
      });
    }
    unavailableItemIndexes = unique;
    const names = unavailableItems.map((i) => i.name).filter(Boolean).join("، ");
    message = names
      ? `بعض المنتجات غير متوفرة: ${names}. يرجى تعديل الطلب.`
      : "بعض المنتجات غير متوفرة. يرجى تعديل الطلب.";
  }

  const originalTotal = getOrderPaidAmount(order);
  const availableReplacementAmount = reason === MODIFICATION_REASONS.ITEMS_UNAVAILABLE
    ? roundMoney(unavailableItems.reduce((sum, item) => sum + (item.subtotal || 0), 0))
    : undefined;

  order.status = "modification_requested";
  if (order.originalTotal == null) {
    order.originalTotal = originalTotal;
  }
  if (isDigitalPayment(order.paymentMethod)) {
    order.paymentTransactions = seedOriginalPaymentTransaction(order);
  }
  order.modificationRequest = {
    reason,
    message,
    unavailableItemIndexes,
    unavailableItems,
    requestedAt: new Date(),
    resolvedAt: undefined,
    ...(availableReplacementAmount != null ? { availableReplacementAmount } : {}),
  };
  order.statusTimeline = pushTimeline(order, "modification_requested", message);
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "modification_requested",
    note: message,
    actor: "store",
    meta: { reason, unavailableItemIndexes },
  });

  await order.save();

  await syncOrderContentsInSessions(order._id).catch(() => {});

  await notifyCustomer(order, store, {
    type: "order_modification_requested",
    title: "طلب يحتاج تعديلاً",
    body: message,
    extra: { modificationReason: reason },
  });

  return {
    message: "تم إرسال طلب التعديل للزبون",
    order: formatOrderResponse(order),
  };
}

async function requestPaymentMethodChange(order, store, body = {}) {
  if (isDigitalPayment(order.paymentMethod)) {
    const err = new Error("لا يمكن طلب تغيير طريقة الدفع للطلبات المدفوعة إلكترونياً — استخدم مراجعة بيانات الدفع");
    err.status = 400;
    throw err;
  }

  const currentPaymentMethod = normalizePaymentMethod(order.paymentMethod);
  const suggestedPaymentMethod = normalizePaymentMethod(
    cleanString(body.suggestedPaymentMethod, { field: "suggestedPaymentMethod", max: 64 }) || ""
  );
  const storeNote = cleanString(body.storeNote || body.note, { field: "storeNote", max: 500 }) || "";

  if (!suggestedPaymentMethod) {
    const err = new Error("يرجى اختيار طريقة الدفع المقترحة");
    err.status = 400;
    throw err;
  }
  if (suggestedPaymentMethod === currentPaymentMethod) {
    const err = new Error("طريقة الدفع المقترحة يجب أن تختلف عن الطريقة الحالية");
    err.status = 400;
    throw err;
  }

  await assertStorePaymentMethodEnabled(store._id, suggestedPaymentMethod);

  const suggestedLabel = suggestedPaymentMethod;
  const message = storeNote
    ? `صاحب متجر ${store.name} يقترح تغيير طريقة الدفع إلى ${suggestedLabel}. ${storeNote}`
    : `صاحب متجر ${store.name} يقترح تغيير طريقة الدفع إلى ${suggestedLabel}.`;

  order.status = "modification_requested";
  order.modificationRequest = {
    reason: MODIFICATION_REASONS.PAYMENT_METHOD_CHANGE_SUGGESTED,
    message,
    storeNote,
    currentPaymentMethod,
    suggestedPaymentMethod,
    requestedAt: new Date(),
    resolvedAt: undefined,
    unavailableItemIndexes: [],
    unavailableItems: [],
  };
  order.statusTimeline = pushTimeline(order, "modification_requested", message);
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "payment_method_change_requested",
    note: message,
    actor: "store",
    meta: { currentPaymentMethod, suggestedPaymentMethod, storeNote },
  });

  await order.save();
  await syncOrderContentsInSessions(order._id).catch(() => {});

  await notifyCustomer(order, store, {
    type: "payment_method_change_requested",
    title: "اقتراح تغيير طريقة الدفع",
    body: message,
    extra: {
      modificationReason: MODIFICATION_REASONS.PAYMENT_METHOD_CHANGE_SUGGESTED,
      suggestedPaymentMethod,
      currentPaymentMethod,
      storeNote,
    },
  });

  return {
    message: "تم إرسال اقتراح تغيير طريقة الدفع للزبون",
    order: formatOrderResponse(order),
  };
}

async function requestPaymentDataReview(order, store, body = {}) {
  if (!isDigitalPayment(order.paymentMethod)) {
    const err = new Error("مراجعة بيانات الدفع متاحة فقط للطلبات المدفوعة إلكترونياً");
    err.status = 400;
    throw err;
  }

  const storeNote = cleanString(body.storeNote || body.note, { field: "storeNote", max: 500 }) || "";
  const message = storeNote
    ? `صاحب متجر ${store.name} يطلب مراجعة بيانات الدفع. ${storeNote}`
    : `صاحب متجر ${store.name} يطلب مراجعة بيانات الدفع — يرجى التأكد من بيانات التحويل أو إعادة إرسالها.`;

  if (order.originalTotal == null) {
    order.originalTotal = getOrderPaidAmount(order);
  }
  order.paymentTransactions = seedOriginalPaymentTransaction(order);

  order.status = "modification_requested";
  order.modificationRequest = {
    reason: MODIFICATION_REASONS.PAYMENT_DATA_REVIEW,
    message,
    storeNote,
    currentPaymentMethod: normalizePaymentMethod(order.paymentMethod),
    requestedAt: new Date(),
    resolvedAt: undefined,
    unavailableItemIndexes: [],
    unavailableItems: [],
  };
  order.statusTimeline = pushTimeline(order, "modification_requested", message);
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "payment_data_review_requested",
    note: message,
    actor: "store",
    meta: { storeNote, paymentMethod: order.paymentMethod },
  });

  await order.save();
  await syncOrderContentsInSessions(order._id).catch(() => {});

  await notifyCustomer(order, store, {
    type: "payment_data_review_requested",
    title: "مراجعة بيانات الدفع",
    body: message,
    extra: {
      modificationReason: MODIFICATION_REASONS.PAYMENT_DATA_REVIEW,
      storeNote,
    },
  });

  return {
    message: "تم إرسال طلب مراجعة بيانات الدفع للزبون",
    order: formatOrderResponse(order),
  };
}

async function buildReplacementOrderItems(storeId, replacementItemsInput) {
  if (!Array.isArray(replacementItemsInput) || !replacementItemsInput.length) {
    const err = new Error("يرجى اختيار منتجات بديلة");
    err.status = 400;
    throw err;
  }

  const cartLike = replacementItemsInput.map((raw) => {
    const itemId = requireObjectId(raw.itemId || raw.item || raw.productId, "itemId");
    const itemType = raw.itemType === "Offer" ? "Offer" : "Product";
    const purchaseMethod = raw.purchaseMethod === "price" ? "price" : "quantity";
    return {
      item: itemId,
      itemType,
      quantity: purchaseMethod === "price" ? 1 : Math.max(1, Number(raw.quantity) || 1),
      purchaseMethod,
      ...(purchaseMethod === "price"
        ? { requestedAmount: Number(raw.requestedAmount) || 0 }
        : {}),
    };
  });

  const populated = await cartService.populateCartItems(cartLike);
  const valid = populated.filter((ci) => ci.item);

  if (!valid.length) {
    const err = new Error("المنتجات البديلة غير متاحة");
    err.status = 400;
    throw err;
  }

  for (const ci of valid) {
    const itemStoreId = ci.item.store?._id?.toString() || ci.item.store?.toString();
    if (itemStoreId !== String(storeId)) {
      const err = new Error("يجب اختيار بدائل من نفس المتجر فقط");
      err.status = 400;
      throw err;
    }
    if (ci.item.isActive === false) {
      const err = new Error(`المنتج غير متاح: ${ci.item.name || ci.item.title || ""}`);
      err.status = 400;
      throw err;
    }
  }

  const orderItems = valid.map((ci) => {
    const purchaseMethod = ci.purchaseMethod || "quantity";
    const lineTotal = ci.lineTotal ?? (ci.unitPrice || 0) * ci.quantity;
    const effectiveUnit =
      purchaseMethod === "price"
        ? ci.requestedAmount ?? lineTotal
        : ci.quantity > 0
          ? roundMoney(lineTotal / ci.quantity)
          : ci.unitPrice ?? 0;
    const name = ci.item.name || ci.item.title || "";
    const image = ci.item.image || (Array.isArray(ci.item.images) ? ci.item.images[0] : "") || "";

    return {
      item: ci.item._id,
      productId: ci.item._id,
      itemType: ci.itemType,
      quantity: purchaseMethod === "price" ? 1 : ci.quantity,
      purchaseMethod,
      ...(purchaseMethod === "price" ? { requestedAmount: ci.requestedAmount } : {}),
      price: effectiveUnit,
      name,
      productName: name,
      image,
      productImage: image,
      subtotal: roundMoney(lineTotal),
      _lineTotal: roundMoney(lineTotal),
    };
  });

  return orderItems;
}

function parseAdditionalPayment(body = {}, orderPaymentMethod) {
  const nested = body.additionalPayment || {};
  const nestedTransfer = nested.transferInformation || {};
  const checkout = cartService.parseOrderCheckoutBody({
    ...body,
    paymentMethod: body.paymentMethod || nested.method || orderPaymentMethod,
    paymentProof: body.paymentProof
      || body.paymentProofImage
      || nested.proof
      || nested.paymentProof
      || nested.paymentProofImage,
    transferInformation: body.transferInformation || nestedTransfer,
    transferName: body.transferName
      || nested.transferName
      || nestedTransfer.senderName,
    transferPhone: body.transferPhone
      || nested.transferPhone
      || nestedTransfer.contactNumber,
    transferNumber: body.transferNumber
      || nested.transferNumber
      || nestedTransfer.referenceNumber,
    paymentNotes: body.paymentNotes
      || nested.paymentNotes
      || nestedTransfer.note,
  });

  return {
    method: checkout.paymentMethod || normalizePaymentMethod(orderPaymentMethod),
    proof: checkout.paymentProof || "",
    transferInformation: checkout.transferInformation || {},
    paidAt: new Date(),
  };
}

/**
 * Customer resolves a modification request.
 * body.action:
 *  - change_delivery
 *  - remove_unavailable
 *  - replace
 */
async function resolveModification(customerId, orderId, body = {}) {
  assertNoMongoOperators(body, "modification");
  const action = cleanString(body.action, { field: "action", max: 64 }) || "";
  const clientOperationId = cleanString(body.clientOperationId, {
    field: "clientOperationId",
    max: 80,
  }) || "";

  const order = await Order.findOne({ _id: orderId, customer: customerId });
  if (!order) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }

  // A modification saved offline may be uploaded more than once. Replaying an
  // id we already applied returns the resulting order rather than failing on
  // the status check below or applying the same change twice.
  if (clientOperationId && (order.appliedModificationOps || []).includes(clientOperationId)) {
    return {
      message: "تم تحديث الطلب مسبقاً",
      replayed: true,
      order: formatOrderResponse(order),
    };
  }

  if (order.status !== "modification_requested") {
    const err = new Error("هذا الطلب لا يحتاج تعديلاً حالياً");
    err.status = 400;
    throw err;
  }

  const mod = order.modificationRequest || {};
  const store = await Store.findById(order.store).select("_id name owner").lean();
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  if (action === "change_delivery") {
    return resolveChangeDelivery(order, store, body, clientOperationId);
  }
  if (action === "remove_unavailable") {
    return resolveRemoveUnavailable(order, store, body, clientOperationId);
  }
  if (action === "replace") {
    return resolveReplace(order, store, body, clientOperationId);
  }
  if (action === "respond_payment_method") {
    return resolveRespondPaymentMethod(order, store, body, clientOperationId);
  }
  if (action === "resubmit_payment_data") {
    return resolveResubmitPaymentData(order, store, body, clientOperationId);
  }

  const err = new Error("إجراء التعديل غير معروف");
  err.status = 400;
  throw err;
}

async function resolveChangeDelivery(order, store, body, clientOperationId = "") {
  const mod = order.modificationRequest || {};
  if (mod.reason !== MODIFICATION_REASONS.AREA_TOO_FAR) {
    const err = new Error("تغيير طريقة التوصيل غير مطلوب لهذا الطلب");
    err.status = 400;
    throw err;
  }

  const checkout = cartService.parseOrderCheckoutBody(body);
  const deliveryMethod = checkout.deliveryMethod;
  if (!deliveryMethod) {
    const err = new Error("يرجى اختيار طريقة التوصيل");
    err.status = 400;
    throw err;
  }

  if (deliveryMethod === DELIVERY_METHODS.NEARBY_STORE) {
    const err = new Error("يرجى اختيار طريقة توصيل أخرى — المنطقة بعيدة عن المتجر");
    err.status = 400;
    throw err;
  }

  if (
    (deliveryMethod === DELIVERY_METHODS.NEARBY_STORE || deliveryMethod === DELIVERY_METHODS.DELIVERY)
    && !checkout.deliveryAddress
    && deliveryMethod === DELIVERY_METHODS.NEARBY_STORE
  ) {
    /* nearby blocked above */
  }

  if (deliveryMethod === DELIVERY_METHODS.DELIVERY && !checkout.deliveryAddress) {
    // company delivery may set address later — allow empty for now
  }

  order.deliveryMethod = deliveryMethod;
  if (checkout.deliveryAddress) order.deliveryAddress = checkout.deliveryAddress;
  if (checkout.deliveryNotes) order.deliveryNotes = checkout.deliveryNotes;
  if (checkout.customerNotes) order.customerNotes = checkout.customerNotes;

  order.status = "pending";
  order.modificationRequest = {
    ...mod.toObject?.() || mod,
    resolvedAt: new Date(),
  };
  order.statusTimeline = pushTimeline(order, "pending", "تم تغيير طريقة التوصيل — بانتظار مراجعة المتجر");
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "delivery_changed",
    note: `تم تغيير طريقة التوصيل إلى ${deliveryMethod}`,
    actor: "customer",
    meta: { deliveryMethod, deliveryAddress: order.deliveryAddress || "" },
  });

  stampClientOperationId(order, clientOperationId);
  await order.save();

  await syncOrderContentsInSessions(order._id).catch(() => {});

  await notifyStore(order, store, {
    type: "order_modification_resolved",
    title: "تم تعديل طريقة التوصيل",
    body: `عدّل الزبون طريقة التوصيل للطلب ${order.orderNumber || ""}`.trim(),
  });

  return {
    message: "تم تحديث طريقة التوصيل — الطلب بانتظار مراجعة المتجر",
    order: formatOrderResponse(order),
  };
}

async function resolveRemoveUnavailable(order, store, body = {}, clientOperationId = "") {
  const mod = order.modificationRequest || {};
  if (mod.reason !== MODIFICATION_REASONS.ITEMS_UNAVAILABLE) {
    const err = new Error("لا توجد منتجات غير متوفرة لإزالتها");
    err.status = 400;
    throw err;
  }

  if (!isFlexiblePayment(order.paymentMethod)) {
    const err = new Error("لا يمكن إزالة المنتجات بعد الدفع الإلكتروني — يرجى اختيار بدائل");
    err.status = 400;
    throw err;
  }

  const unavailableIndexes = new Set(
    (mod.unavailableItemIndexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n))
  );
  if (!unavailableIndexes.size) {
    const err = new Error("لا توجد منتجات محددة للإزالة");
    err.status = 400;
    throw err;
  }

  const rawRequested = body.itemIndexes ?? body.itemIndex ?? body.unavailableItemIndexes;
  let indexesToRemove;
  if (rawRequested != null) {
    const list = Array.isArray(rawRequested) ? rawRequested : [rawRequested];
    indexesToRemove = new Set(
      list.map((n) => Number(n)).filter((n) => unavailableIndexes.has(n))
    );
    if (!indexesToRemove.size) {
      const err = new Error("المنتج المحدد غير متاح للإزالة");
      err.status = 400;
      throw err;
    }
  } else {
    indexesToRemove = new Set(unavailableIndexes);
  }

  const removed = [];
  const kept = [];
  const indexMap = new Map();
  order.items.forEach((item, idx) => {
    if (indexesToRemove.has(idx)) {
      removed.push(item);
      return;
    }
    indexMap.set(idx, kept.length);
    kept.push(item);
  });

  if (!kept.length) {
    const err = new Error("لا يمكن إزالة كل المنتجات — اختر بدائل أو تواصل مع المتجر");
    err.status = 400;
    throw err;
  }

  await cartService.restoreStockForOrderItems(removed, null);

  const newTotal = roundMoney(kept.reduce((sum, item) => sum + itemLineTotal(item), 0));
  const remainingUnavailableIndexes = [...unavailableIndexes]
    .filter((idx) => !indexesToRemove.has(idx))
    .map((idx) => indexMap.get(idx))
    .filter((idx) => Number.isInteger(idx));

  const remainingUnavailableItems = remainingUnavailableIndexes.map((idx) => {
    const item = kept[idx];
    return {
      index: idx,
      name: item.name || item.productName,
      productName: item.productName || item.name,
      image: item.image || item.productImage || "",
      productImage: item.productImage || item.image || "",
      quantity: item.quantity,
      price: item.price,
      subtotal: itemLineTotal(item),
      item: item.item,
    };
  });

  const remainingReplacementAmount = roundMoney(
    remainingUnavailableItems.reduce((sum, item) => sum + (item.subtotal || 0), 0)
  );

  const allResolved = remainingUnavailableIndexes.length === 0;
  const modBase = mod.toObject?.() || mod;

  order.items = kept;
  order.subtotal = newTotal;
  order.total = newTotal;
  order.totalAmount = newTotal;
  order.status = allResolved ? "pending" : "modification_requested";
  order.modificationRequest = {
    ...modBase,
    unavailableItemIndexes: remainingUnavailableIndexes,
    unavailableItems: remainingUnavailableItems,
    availableReplacementAmount: remainingReplacementAmount,
    ...(allResolved ? { resolvedAt: new Date() } : {}),
  };

  const historyNote = allResolved
    ? "تمت إزالة المنتجات غير المتوفرة"
    : `تم إلغاء ${removed.length} منتج غير متوفر`;

  order.statusTimeline = pushTimeline(
    order,
    allResolved ? "pending" : "modification_requested",
    allResolved ? "أزال الزبون المنتجات غير المتوفرة" : "أزال الزبون منتجاً غير متوفر",
  );
  order.orderChangeHistory = pushChangeHistory(order, {
    type: allResolved ? "items_removed" : "item_removed",
    note: historyNote,
    actor: "customer",
    meta: {
      removed: removed.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        subtotal: itemLineTotal(i),
      })),
      newTotal,
      remainingUnavailable: remainingUnavailableIndexes.length,
    },
  });

  stampClientOperationId(order, clientOperationId);
  await order.save();

  await syncOrderContentsInSessions(order._id).catch(() => {});

  if (allResolved) {
    await notifyStore(order, store, {
      type: "order_modification_resolved",
      title: "تم تعديل الطلب",
      body: `أزال الزبون المنتجات غير المتوفرة من الطلب ${order.orderNumber || ""}`.trim(),
    });
  }

  return {
    message: allResolved
      ? "تم تحديث الطلب — بانتظار مراجعة المتجر"
      : "تم إلغاء المنتج — يمكنك متابعة تعديل بقية المنتجات",
    partial: !allResolved,
    order: formatOrderResponse(order),
  };
}

async function resolveReplace(order, store, body, clientOperationId = "") {
  const mod = order.modificationRequest || {};
  if (mod.reason !== MODIFICATION_REASONS.ITEMS_UNAVAILABLE) {
    const err = new Error("الاستبدال متاح فقط عند عدم توفر منتجات");
    err.status = 400;
    throw err;
  }

  const indexes = new Set(
    (mod.unavailableItemIndexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n))
  );
  if (!indexes.size) {
    const err = new Error("لا توجد منتجات غير متوفرة للاستبدال");
    err.status = 400;
    throw err;
  }

  const removed = [];
  const kept = [];
  order.items.forEach((item, idx) => {
    if (indexes.has(idx)) removed.push(item);
    else kept.push(item);
  });

  const replacementRaw = await buildReplacementOrderItems(store._id, body.replacementItems || body.items);
  const replacementTotal = roundMoney(replacementRaw.reduce((s, i) => s + i._lineTotal, 0));
  const keptTotal = roundMoney(kept.reduce((s, i) => s + itemLineTotal(i), 0));
  const removedTotal = roundMoney(removed.reduce((s, i) => s + itemLineTotal(i), 0));
  const availableAmount = removedTotal;
  const newOrderTotal = roundMoney(keptTotal + replacementTotal);
  const additionalNeeded = roundMoney(Math.max(0, replacementTotal - availableAmount));
  const originalTotal = getOrderPaidAmount(order);
  const totalPaidSoFar = getTotalPaidSoFar(order);

  assertElectronicReplacementAllowed(order, replacementTotal, availableAmount);

  let additionalPayment = null;
  let additionalPaymentAmount = getDifferenceTransactionsTotal(order);

  if (additionalNeeded > 0) {
    if (isDigitalPayment(order.paymentMethod)) {
      const payment = parseAdditionalPayment(body, order.paymentMethod);
      if (!hasDifferencePaymentDetails(payment)) {
        const err = new Error("يرجى إدخال بيانات دفع الفرق");
        err.status = 400;
        err.requiresDifferencePayment = true;
        err.differenceAmount = additionalNeeded;
        err.additionalNeeded = additionalNeeded;
        throw err;
      }
      additionalPayment = payment;

      const txs = Array.isArray(order.paymentTransactions) ? [...order.paymentTransactions] : [];
      txs.push({
        type: "difference",
        amount: additionalNeeded,
        method: payment.method,
        proof: payment.proof,
        transferInformation: payment.transferInformation || {},
        paidAt: payment.paidAt || new Date(),
        note: "",
      });
      order.paymentTransactions = txs;
      additionalPaymentAmount = getDifferenceTransactionsTotal({ paymentTransactions: txs });
    } else if (isFlexiblePayment(order.paymentMethod)) {
      // cash / agreement — difference collected later; update invoice totals only
      additionalPaymentAmount = additionalNeeded;
    } else {
      additionalPaymentAmount = additionalNeeded;
    }
  }

  await cartService.restoreStockForOrderItems(removed, null);
  await cartService.deductStockForOrderItems(
    replacementRaw.map(({ _lineTotal, ...rest }) => rest),
    null
  );

  const replacementItems = replacementRaw.map(({ _lineTotal, ...rest }) => rest);
  const newItems = [...kept.map((i) => (typeof i.toObject === "function" ? i.toObject() : { ...i })), ...replacementItems];

  order.items = newItems;
  order.subtotal = newOrderTotal;
  order.total = newOrderTotal;
  order.totalAmount = newOrderTotal;
  order.additionalPaymentAmount = additionalPaymentAmount;
  if (additionalPayment) {
    order.additionalPayment = additionalPayment;
  }
  order.status = "pending";
  order.modificationRequest = {
    ...mod.toObject?.() || mod,
    resolvedAt: new Date(),
  };
  order.statusTimeline = pushTimeline(
    order,
    "pending",
    additionalNeeded > 0
      ? `تم استبدال المنتجات ودفع فرق ${additionalNeeded} ₪ — بانتظار مراجعة المتجر`
      : "تم استبدال المنتجات — بانتظار مراجعة المتجر"
  );
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "items_replaced",
    note: "تم استبدال المنتجات غير المتوفرة",
    actor: "customer",
    meta: {
      removed: removed.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: itemLineTotal(i) })),
      replacements: replacementItems.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        subtotal: i.subtotal,
      })),
      originalTotal,
      availableAmount,
      removedTotal,
      replacementTotal,
      newOrderTotal,
      additionalNeeded,
      additionalPaymentAmount,
    },
  });

  if (additionalNeeded > 0) {
    order.orderChangeHistory = pushChangeHistory(order, {
      type: "difference_paid",
      note: additionalPayment
        ? "تم تسجيل دفع الفرق"
        : `فرق المبلغ: ${additionalPaymentAmount} ₪`,
      actor: "customer",
      meta: {
        amount: additionalNeeded,
        cumulativeAdditional: additionalPaymentAmount,
        method: additionalPayment?.method || order.paymentMethod,
        hasProof: Boolean(additionalPayment?.proof),
      },
    });
  }

  const paymentSummary = buildPaymentSummary(order, newOrderTotal, additionalNeeded);
  if (paymentSummary.hasPaymentSurplus) {
    order.orderChangeHistory = pushChangeHistory(order, {
      type: "payment_surplus",
      note: `المدفوع (${paymentSummary.totalPaidSoFar} ₪) أعلى من الفاتورة الجديدة (${newOrderTotal} ₪) — لا يوجد استرداد تلقائي`,
      actor: "system",
      meta: {
        totalPaidSoFar: paymentSummary.totalPaidSoFar,
        newOrderTotal,
        paymentSurplus: paymentSummary.paymentSurplus,
        refundAvailable: false,
      },
    });
  }

  stampClientOperationId(order, clientOperationId);
  await order.save();

  await syncOrderContentsInSessions(order._id).catch(() => {});

  await notifyStore(order, store, {
    type: "order_modification_resolved",
    title: "فاتورة محدّثة — استبدال منتجات",
    body: `حدّث الزبون الطلب ${order.orderNumber || ""} بمنتجات بديلة${
      additionalPaymentAmount > 0 ? ` (فرق ${additionalPaymentAmount} ₪)` : ""
    }`.trim(),
    extra: {
      originalTotal,
      additionalPaymentAmount,
      newOrderTotal,
    },
  });

  return {
    message: "تم تحديث الطلب بالبدائل — بانتظار مراجعة المتجر",
    order: formatOrderResponse(order),
    summary: {
      ...paymentSummary,
      replacementTotal,
      availableAmount,
      removedTotal,
      additionalPaymentAmount,
      remainingAfterReplacement: roundMoney(Math.max(0, availableAmount - replacementTotal)),
      requiresDifferencePayment: additionalNeeded > 0 && isDigitalPayment(order.paymentMethod),
    },
  };
}

async function resolveRespondPaymentMethod(order, store, body, clientOperationId = "") {
  const mod = order.modificationRequest || {};
  if (mod.reason !== MODIFICATION_REASONS.PAYMENT_METHOD_CHANGE_SUGGESTED) {
    const err = new Error("لا يوجد اقتراح لتغيير طريقة الدفع");
    err.status = 400;
    throw err;
  }

  const decision = cleanString(body.decision, { field: "decision", max: 64 }) || "";
  const currentMethod = normalizePaymentMethod(mod.currentPaymentMethod || order.paymentMethod);
  const suggestedMethod = normalizePaymentMethod(mod.suggestedPaymentMethod || "");
  let nextMethod = currentMethod;

  if (decision === PAYMENT_METHOD_DECISIONS.KEEP_CURRENT) {
    nextMethod = currentMethod;
  } else if (decision === PAYMENT_METHOD_DECISIONS.ACCEPT_SUGGESTED) {
    nextMethod = suggestedMethod;
  } else if (decision === PAYMENT_METHOD_DECISIONS.CHOOSE_METHOD) {
    nextMethod = normalizePaymentMethod(
      cleanString(body.paymentMethod, { field: "paymentMethod", max: 64 }) || ""
    );
    if (!nextMethod) {
      const err = new Error("يرجى اختيار طريقة الدفع");
      err.status = 400;
      throw err;
    }
    if (nextMethod === currentMethod) {
      const err = new Error("اختر طريقة مختلفة أو اضغط «الإبقاء على الطريقة الحالية»");
      err.status = 400;
      throw err;
    }
    await assertStorePaymentMethodEnabled(store._id, nextMethod);
  } else {
    const err = new Error("يرجى اختيار رد على اقتراح طريقة الدفع");
    err.status = 400;
    throw err;
  }

  let payment = null;
  if (isDigitalPayment(nextMethod) && nextMethod !== currentMethod) {
    payment = parseAdditionalPayment(body, nextMethod);
    if (!hasDifferencePaymentDetails(payment)) {
      const err = new Error("يرجى إدخال بيانات التحويل أو إرفاق إيصال الدفع");
      err.status = 400;
      throw err;
    }
  }

  const previousMethod = order.paymentMethod;
  order.paymentMethod = nextMethod;
  if (payment) {
    applyPaymentFieldsToOrder(order, payment, { paymentMethod: nextMethod });
    if (isDigitalPayment(nextMethod)) {
      order.paymentTransactions = seedOriginalPaymentTransaction(order);
      pushPaymentTransaction(order, {
        type: "correction",
        amount: getOrderPaidAmount(order),
        method: nextMethod,
        proof: payment.proof,
        transferInformation: payment.transferInformation || {},
        paidAt: payment.paidAt || new Date(),
        note: "بيانات دفع بعد تغيير طريقة الدفع",
      });
    }
  }

  const paymentNotes = cleanString(body.paymentNotes, { field: "paymentNotes", max: 500 }) || "";
  if (paymentNotes) order.paymentNotes = paymentNotes;

  order.status = "pending";
  order.modificationRequest = {
    ...mod.toObject?.() || mod,
    resolvedAt: new Date(),
  };
  order.statusTimeline = pushTimeline(
    order,
    "pending",
    decision === PAYMENT_METHOD_DECISIONS.KEEP_CURRENT
      ? "أبقى الزبون على طريقة الدفع الحالية"
      : `غيّر الزبون طريقة الدفع إلى ${nextMethod}`,
  );
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "payment_method_changed",
    note: decision === PAYMENT_METHOD_DECISIONS.KEEP_CURRENT
      ? "رفض الزبون اقتراح تغيير طريقة الدفع"
      : `تم تغيير طريقة الدفع من ${previousMethod} إلى ${nextMethod}`,
    actor: "customer",
    meta: {
      decision,
      previousMethod,
      nextMethod,
      suggestedMethod,
      storeNote: mod.storeNote || "",
    },
  });

  stampClientOperationId(order, clientOperationId);
  await order.save();
  await syncOrderContentsInSessions(order._id).catch(() => {});

  await notifyStore(order, store, {
    type: "order_modification_resolved",
    title: "رد على اقتراح طريقة الدفع",
    body: decision === PAYMENT_METHOD_DECISIONS.KEEP_CURRENT
      ? `أبقى الزبون على طريقة الدفع للطلب ${order.orderNumber || ""}`
      : `غيّر الزبون طريقة الدفع للطلب ${order.orderNumber || ""}`,
  });

  return {
    message: decision === PAYMENT_METHOD_DECISIONS.KEEP_CURRENT
      ? "تم الإبقاء على طريقة الدفع — بانتظار مراجعة المتجر"
      : "تم تحديث طريقة الدفع — بانتظار مراجعة المتجر",
    order: formatOrderResponse(order),
  };
}

async function resolveResubmitPaymentData(order, store, body, clientOperationId = "") {
  const mod = order.modificationRequest || {};
  if (mod.reason !== MODIFICATION_REASONS.PAYMENT_DATA_REVIEW) {
    const err = new Error("لا يوجد طلب لمراجعة بيانات الدفع");
    err.status = 400;
    throw err;
  }
  if (!isDigitalPayment(order.paymentMethod)) {
    const err = new Error("مراجعة بيانات الدفع غير مطلوبة لهذا الطلب");
    err.status = 400;
    throw err;
  }

  const payment = parseAdditionalPayment(body, order.paymentMethod);
  if (!hasDifferencePaymentDetails(payment)) {
    const err = new Error("يرجى إدخال بيانات التحويل أو إرفاق إيصال الدفع");
    err.status = 400;
    throw err;
  }

  order.paymentTransactions = seedOriginalPaymentTransaction(order);
  applyPaymentFieldsToOrder(order, payment, { paymentMethod: order.paymentMethod });
  pushPaymentTransaction(order, {
    type: "correction",
    amount: getOrderPaidAmount(order),
    method: normalizePaymentMethod(order.paymentMethod),
    proof: payment.proof,
    transferInformation: payment.transferInformation || {},
    paidAt: payment.paidAt || new Date(),
    note: mod.storeNote ? `تصحيح بيانات الدفع — ${mod.storeNote}` : "تصحيح بيانات الدفع",
  });

  order.status = "pending";
  order.modificationRequest = {
    ...mod.toObject?.() || mod,
    resolvedAt: new Date(),
  };
  order.statusTimeline = pushTimeline(order, "pending", "أعاد الزبون إرسال بيانات الدفع — بانتظار مراجعة المتجر");
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "payment_data_resubmitted",
    note: "أعاد الزبون إرسال بيانات الدفع",
    actor: "customer",
    meta: {
      hasProof: Boolean(payment.proof),
      referenceNumber: payment.transferInformation?.referenceNumber || "",
      storeNote: mod.storeNote || "",
    },
  });

  stampClientOperationId(order, clientOperationId);
  await order.save();
  await syncOrderContentsInSessions(order._id).catch(() => {});

  await notifyStore(order, store, {
    type: "order_modification_resolved",
    title: "بيانات دفع محدّثة",
    body: `أعاد الزبون إرسال بيانات الدفع للطلب ${order.orderNumber || ""}`,
  });

  return {
    message: "تم إرسال بيانات الدفع — بانتظار مراجعة المتجر",
    order: formatOrderResponse(order),
  };
}

/**
 * Preview difference before customer commits payment.
 */
async function previewReplacement(customerId, orderId, body = {}) {
  assertNoMongoOperators(body, "modification");
  const order = await Order.findOne({ _id: orderId, customer: customerId });
  if (!order) {
    const err = new Error("الطلب غير موجود");
    err.status = 404;
    throw err;
  }
  if (order.status !== "modification_requested") {
    const err = new Error("هذا الطلب لا يحتاج تعديلاً حالياً");
    err.status = 400;
    throw err;
  }

  const mod = order.modificationRequest || {};
  const indexes = new Set(
    (mod.unavailableItemIndexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n))
  );
  const kept = [];
  const removed = [];
  order.items.forEach((item, idx) => {
    if (indexes.has(idx)) removed.push(item);
    else kept.push(item);
  });

  const replacementRaw = await buildReplacementOrderItems(order.store, body.replacementItems || body.items || []);
  const replacementTotal = roundMoney(replacementRaw.reduce((s, i) => s + i._lineTotal, 0));
  const keptTotal = roundMoney(kept.reduce((s, i) => s + itemLineTotal(i), 0));
  const removedTotal = roundMoney(removed.reduce((s, i) => s + itemLineTotal(i), 0));
  const availableAmount = removedTotal;
  const newOrderTotal = roundMoney(keptTotal + replacementTotal);
  const originalTotal = getOrderPaidAmount(order);
  const totalPaidSoFar = getTotalPaidSoFar(order);
  const additionalNeeded = roundMoney(Math.max(0, replacementTotal - availableAmount));
  const remainingAfterReplacement = roundMoney(Math.max(0, availableAmount - replacementTotal));
  const paymentSummary = buildPaymentSummary(order, newOrderTotal, additionalNeeded);
  const digital = isDigitalPayment(order.paymentMethod);
  const electronicUnderBudgetBlocked = digital
    && replacementTotal > 0
    && replacementTotal < availableAmount;

  return {
    ...paymentSummary,
    keptTotal,
    availableAmount,
    removedTotal,
    replacementTotal,
    remainingAfterReplacement,
    requiresDifferencePayment: additionalNeeded > 0 && digital,
    electronicUnderBudgetBlocked,
    minimumReplacementTotal: digital ? availableAmount : 0,
    paymentMethod: order.paymentMethod,
    isFlexiblePayment: isFlexiblePayment(order.paymentMethod),
    isDigitalPayment: isDigitalPayment(order.paymentMethod),
    replacementItems: replacementRaw.map(({ _lineTotal, ...rest }) => ({
      ...rest,
      subtotal: _lineTotal,
    })),
  };
}

module.exports = {
  MODIFICATION_REASONS,
  PAYMENT_METHOD_DECISIONS,
  AREA_TOO_FAR_MESSAGE,
  DIGITAL_UNDER_BUDGET_MESSAGE,
  requestModification,
  resolveModification,
  previewReplacement,
  isFlexiblePayment,
  isDigitalPayment,
  parseAdditionalPayment,
  hasDifferencePaymentDetails,
  assertElectronicReplacementAllowed,
};
