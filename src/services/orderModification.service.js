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

const MODIFICATION_REASONS = {
  AREA_TOO_FAR: "area_too_far",
  ITEMS_UNAVAILABLE: "items_unavailable",
};

const AREA_TOO_FAR_MESSAGE = "المنطقة بعيدة عن المتجر، يرجى تغيير طريقة التوصيل.";

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

  let message = "";
  let unavailableItemIndexes = [];
  let unavailableItems = [];

  if (reason === MODIFICATION_REASONS.AREA_TOO_FAR) {
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

  order.status = "modification_requested";
  order.originalTotal = originalTotal;
  order.modificationRequest = {
    reason,
    message,
    unavailableItemIndexes,
    unavailableItems,
    requestedAt: new Date(),
    resolvedAt: undefined,
  };
  order.statusTimeline = pushTimeline(order, "modification_requested", message);
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "modification_requested",
    note: message,
    actor: "store",
    meta: { reason, unavailableItemIndexes },
  });

  await order.save();

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
  const checkout = cartService.parseOrderCheckoutBody({
    ...body,
    paymentMethod: body.paymentMethod || orderPaymentMethod,
    paymentProof: body.paymentProof || body.paymentProofImage || body.additionalPayment?.proof,
    transferInformation: body.transferInformation || body.additionalPayment?.transferInformation,
    transferName: body.transferName || body.additionalPayment?.transferName,
    transferPhone: body.transferPhone || body.additionalPayment?.transferPhone,
    transferNumber: body.transferNumber || body.additionalPayment?.transferNumber,
    paymentNotes: body.paymentNotes || body.additionalPayment?.paymentNotes,
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
  const store = await Store.findById(order.store).select("_id name owner").lean();
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  if (action === "change_delivery") {
    return resolveChangeDelivery(order, store, body);
  }
  if (action === "remove_unavailable") {
    return resolveRemoveUnavailable(order, store, body);
  }
  if (action === "replace") {
    return resolveReplace(order, store, body);
  }

  const err = new Error("إجراء التعديل غير معروف");
  err.status = 400;
  throw err;
}

async function resolveChangeDelivery(order, store, body) {
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

  await order.save();

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

async function resolveRemoveUnavailable(order, store) {
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

  const indexes = new Set(
    (mod.unavailableItemIndexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n))
  );
  if (!indexes.size) {
    const err = new Error("لا توجد منتجات محددة للإزالة");
    err.status = 400;
    throw err;
  }

  const removed = [];
  const kept = [];
  order.items.forEach((item, idx) => {
    if (indexes.has(idx)) removed.push(item);
    else kept.push(item);
  });

  if (!kept.length) {
    const err = new Error("لا يمكن إزالة كل المنتجات — اختر بدائل أو تواصل مع المتجر");
    err.status = 400;
    throw err;
  }

  await cartService.restoreStockForOrderItems(removed, null);

  const newTotal = roundMoney(kept.reduce((sum, item) => sum + itemLineTotal(item), 0));

  order.items = kept;
  order.subtotal = newTotal;
  order.total = newTotal;
  order.totalAmount = newTotal;
  order.status = "pending";
  order.modificationRequest = {
    ...mod.toObject?.() || mod,
    resolvedAt: new Date(),
  };
  order.statusTimeline = pushTimeline(order, "pending", "أزال الزبون المنتجات غير المتوفرة");
  order.orderChangeHistory = pushChangeHistory(order, {
    type: "items_removed",
    note: "تمت إزالة المنتجات غير المتوفرة",
    actor: "customer",
    meta: {
      removed: removed.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: itemLineTotal(i) })),
      newTotal,
    },
  });

  await order.save();

  await notifyStore(order, store, {
    type: "order_modification_resolved",
    title: "تم تعديل الطلب",
    body: `أزال الزبون المنتجات غير المتوفرة من الطلب ${order.orderNumber || ""}`.trim(),
  });

  return {
    message: "تم تحديث الطلب — بانتظار مراجعة المتجر",
    order: formatOrderResponse(order),
  };
}

async function resolveReplace(order, store, body) {
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
  const newOrderTotal = roundMoney(keptTotal + replacementTotal);
  const originalPaid = getOrderPaidAmount(order);
  const difference = roundMoney(newOrderTotal - originalPaid);

  let additionalPayment = null;
  let additionalPaymentAmount = 0;

  if (difference > 0) {
    if (isDigitalPayment(order.paymentMethod)) {
      const payment = parseAdditionalPayment(body, order.paymentMethod);
      if (!payment.proof && !payment.transferInformation?.referenceNumber) {
        const err = new Error("يرجى إدخال بيانات دفع الفرق");
        err.status = 400;
        err.requiresDifferencePayment = true;
        err.differenceAmount = difference;
        throw err;
      }
      additionalPayment = payment;
      additionalPaymentAmount = difference;
    } else if (isFlexiblePayment(order.paymentMethod)) {
      // cash / agreement — difference collected later with the order
      additionalPaymentAmount = difference;
    } else {
      additionalPaymentAmount = difference;
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
    difference > 0
      ? `تم استبدال المنتجات ودفع فرق ${difference} ₪ — بانتظار مراجعة المتجر`
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
      originalPaid,
      removedTotal,
      replacementTotal,
      newOrderTotal,
      difference,
      additionalPaymentAmount,
    },
  });

  if (additionalPaymentAmount > 0) {
    order.orderChangeHistory = pushChangeHistory(order, {
      type: "difference_paid",
      note: difference > 0 && additionalPayment
        ? "تم تسجيل دفع الفرق"
        : `فرق المبلغ: ${additionalPaymentAmount} ₪`,
      actor: "customer",
      meta: {
        amount: additionalPaymentAmount,
        method: additionalPayment?.method || order.paymentMethod,
        hasProof: Boolean(additionalPayment?.proof),
      },
    });
  }

  await order.save();

  await notifyStore(order, store, {
    type: "order_modification_resolved",
    title: "فاتورة محدّثة — استبدال منتجات",
    body: `حدّث الزبون الطلب ${order.orderNumber || ""} بمنتجات بديلة${
      additionalPaymentAmount > 0 ? ` (فرق ${additionalPaymentAmount} ₪)` : ""
    }`.trim(),
    extra: {
      originalPaid,
      additionalPaymentAmount,
      newOrderTotal,
    },
  });

  return {
    message: "تم تحديث الطلب بالبدائل — بانتظار مراجعة المتجر",
    order: formatOrderResponse(order),
    summary: {
      originalPaid,
      replacementTotal,
      removedTotal,
      newOrderTotal,
      difference,
      additionalPaymentAmount,
    },
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
  const newOrderTotal = roundMoney(keptTotal + replacementTotal);
  const originalPaid = getOrderPaidAmount(order);
  const difference = roundMoney(newOrderTotal - originalPaid);

  return {
    originalPaid,
    keptTotal,
    removedTotal,
    replacementTotal,
    newOrderTotal,
    difference,
    requiresDifferencePayment: difference > 0 && isDigitalPayment(order.paymentMethod),
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
  AREA_TOO_FAR_MESSAGE,
  requestModification,
  resolveModification,
  previewReplacement,
  isFlexiblePayment,
  isDigitalPayment,
};
