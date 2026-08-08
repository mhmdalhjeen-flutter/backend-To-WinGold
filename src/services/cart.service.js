const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const Product = require("../models/product");
const Offer = require("../models/offer");
const Store = require("../models/store");
const Order = require("../models/order");
const User = require("../models/user");
const pricingService = require("./pricing.service");
const cache = require("../utils/responseCache.util");
const { generateOrderNumber } = require("../utils/orderNumber.util");
const { generateUniqueVerificationCode } = require("../utils/verificationCode.util");
const { assertNoMongoOperators, requireObjectId, cleanString } = require("../utils/inputSecurity.util");
const {
  normalizeDeliveryMethod,
  normalizePaymentMethod,
} = require("../constants/marketplaceOrder.constants");
const {
  normalizePurchaseMethod,
  assertPurchaseMethodAllowed,
  parseRequestedAmount,
} = require("../constants/purchaseMode.constants");

function parseOrderCheckoutBody(body = {}) {
  const customerNotes = cleanString(body.customerNotes, { field: "customerNotes", max: 1000 }) || "";
  const deliveryNotes = cleanString(body.deliveryNotes, { field: "deliveryNotes", max: 1000 }) || "";
  const deliveryMethod = normalizeDeliveryMethod(
    cleanString(body.deliveryMethod, { field: "deliveryMethod", max: 64 }) || ""
  );
  const deliveryAddress = cleanString(body.deliveryAddress || body.locationDetails, {
    field: "deliveryAddress",
    max: 500,
  }) || "";
  const paymentMethod = normalizePaymentMethod(
    cleanString(body.paymentMethod, { field: "paymentMethod", max: 64 }) || ""
  );
  const paymentProof = cleanString(body.paymentProof || body.paymentProofImage, {
    field: "paymentProof",
    max: 2000,
  }) || "";

  const clientOperationId = cleanString(body.clientOperationId, {
    field: "clientOperationId",
    max: 64,
  }) || "";

  const transferRaw = body.transferInformation || body.transferDetails || {};
  const transferInformation = {
    senderName: cleanString(body.transferName || transferRaw.senderName, { field: "senderName", max: 120 }) || "",
    contactNumber: cleanString(body.transferPhone || transferRaw.contactNumber, { field: "contactNumber", max: 32 }) || "",
    referenceNumber: cleanString(body.transferNumber || transferRaw.referenceNumber, { field: "referenceNumber", max: 64 }) || "",
    note: cleanString(body.paymentNotes || transferRaw.note, { field: "note", max: 500 }) || "",
  };

  return {
    customerNotes,
    deliveryNotes: deliveryNotes || customerNotes,
    deliveryMethod,
    deliveryAddress,
    paymentMethod,
    paymentProof,
    paymentProofImage: paymentProof,
    clientOperationId,
    transferInformation,
    transferName: transferInformation.senderName,
    transferPhone: transferInformation.contactNumber,
    transferNumber: transferInformation.referenceNumber,
    paymentNotes: transferInformation.note,
  };
}

function resolveItemImage(item) {
  if (!item) return "";
  return item.image || (Array.isArray(item.images) && item.images[0]) || "";
}

function invalidateCartCache(userId) {
  if (userId) cache.invalidate(`cart:${userId}`);
}

const TYPE_MAP = {
  product: "Product",
  Product: "Product",
  offer: "Offer",
  Offer: "Offer",
};

function normalizeItemType(itemType) {
  return TYPE_MAP[itemType] || null;
}

function isStockManaged(stock) {
  return typeof stock === "number" && stock > 0;
}

function parsePositiveQuantity(quantity, label = "الكمية") {
  const qty = parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty < 1) {
    const err = new Error(`${label} يجب أن تكون 1 على الأقل`);
    err.status = 400;
    throw err;
  }
  return qty;
}

function cartLineMatches(a, itemId, itemType, purchaseMethod = "quantity") {
  return (
    a.item.toString() === itemId.toString() &&
    a.itemType === itemType &&
    (a.purchaseMethod || "quantity") === purchaseMethod
  );
}

function toCartSnapshotItem(i) {
  return {
    item: i.item,
    itemType: i.itemType,
    quantity: i.quantity,
    purchaseMethod: i.purchaseMethod || "quantity",
    ...(i.purchaseMethod === "price" && i.requestedAmount != null
      ? { requestedAmount: i.requestedAmount }
      : {}),
  };
}

function syncFlatItemsFromContainers(containers) {
  const flat = [];
  for (const c of containers || []) {
    if (c.locked) continue;
    for (const it of c.items || []) {
      const method = it.purchaseMethod || "quantity";
      const idx = flat.findIndex((f) => cartLineMatches(f, it.item, it.itemType, method));
      if (idx >= 0) {
        if (method === "price") {
          flat[idx].requestedAmount =
            Math.round(((flat[idx].requestedAmount || 0) + (it.requestedAmount || 0)) * 100) / 100;
        } else {
          flat[idx].quantity += it.quantity;
        }
      } else {
        flat.push(toCartSnapshotItem(it));
      }
    }
  }
  return flat;
}

function mergeIntoContainerItems(items, itemId, itemType, qtyOrOptions) {
  let qty = 1;
  let purchaseMethod = "quantity";
  let requestedAmount;
  let replace = false;

  if (typeof qtyOrOptions === "number") {
    qty = qtyOrOptions;
  } else if (qtyOrOptions && typeof qtyOrOptions === "object") {
    qty = qtyOrOptions.qty ?? 1;
    purchaseMethod = qtyOrOptions.purchaseMethod || "quantity";
    requestedAmount = qtyOrOptions.requestedAmount;
    replace = !!qtyOrOptions.replace;
  }

  const idx = items.findIndex((i) => cartLineMatches(i, itemId, itemType, purchaseMethod));

  if (purchaseMethod === "price") {
    const amount = parseRequestedAmount(requestedAmount);
    if (idx >= 0) {
      items[idx].quantity = 1;
      items[idx].requestedAmount = replace
        ? amount
        : Math.round(((items[idx].requestedAmount || 0) + amount) * 100) / 100;
    } else {
      items.push({
        item: itemId,
        itemType,
        quantity: 1,
        purchaseMethod: "price",
        requestedAmount: amount,
      });
    }
    return;
  }

  if (idx >= 0) {
    items[idx].quantity = replace ? qty : items[idx].quantity + qty;
  } else {
    items.push({ item: itemId, itemType, quantity: qty, purchaseMethod: "quantity" });
  }
}

async function resolveProductCartLine(productId, body) {
  const product = await Product.findById(productId)
    .select("purchaseMode price name stock")
    .lean();
  if (!product) {
    const err = new Error("العنصر غير موجود");
    err.status = 404;
    throw err;
  }

  const purchaseMethod = assertPurchaseMethodAllowed(
    product.purchaseMode,
    body.purchaseMethod || "quantity"
  );

  if (purchaseMethod === "price") {
    return {
      purchaseMethod: "price",
      quantity: 1,
      requestedAmount: parseRequestedAmount(body.requestedAmount),
    };
  }

  return {
    purchaseMethod: "quantity",
    quantity: parsePositiveQuantity(body.quantity ?? 1),
  };
}

async function resolveOfferCartLine(offerId, body) {
  const offer = await Offer.findById(offerId)
    .select("purchaseMode title isActive")
    .lean();
  if (!offer) {
    const err = new Error("العرض غير موجود");
    err.status = 404;
    throw err;
  }

  const purchaseMethod = assertPurchaseMethodAllowed(
    offer.purchaseMode,
    body.purchaseMethod || "quantity"
  );

  if (purchaseMethod === "price") {
    return {
      purchaseMethod: "price",
      quantity: 1,
      requestedAmount: parseRequestedAmount(body.requestedAmount),
    };
  }

  return {
    purchaseMethod: "quantity",
    quantity: parsePositiveQuantity(body.quantity ?? 1),
  };
}

function findUnlockedContainer(cart, storeId) {
  return (cart.containers || []).find(
    (c) => !c.locked && c.store.toString() === storeId.toString()
  );
}

function findOrCreateUnlockedContainer(cart, storeId, storeName) {
  if (!cart.containers) cart.containers = [];
  let container = findUnlockedContainer(cart, storeId);
  if (!container) {
    cart.containers.push({
      store: storeId,
      storeName: storeName || "",
      locked: false,
      items: [],
      customerNotes: "",
    });
    container = cart.containers[cart.containers.length - 1];
  } else if (storeName && !container.storeName) {
    container.storeName = storeName;
  }
  return container;
}

async function getProductStockInfo(productId) {
  const product = await Product.findById(productId).select("name stock isActive");
  if (!product) {
    const err = new Error("المنتج غير موجود");
    err.status = 404;
    throw err;
  }
  if (product.isActive === false) {
    const err = new Error("هذا المنتج غير متاح");
    err.status = 400;
    throw err;
  }
  return product;
}

async function assertProductsStockAvailable(productQty) {
  if (productQty.size === 0) return;
  const ids = [...productQty.keys()];
  const products = await Product.find({ _id: { $in: ids } }).select("name stock isActive").lean();
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  for (const [productId, qty] of productQty) {
    const product = productMap.get(productId);
    if (!product) {
      const err = new Error("المنتج غير موجود");
      err.status = 404;
      throw err;
    }
    if (product.isActive === false) {
      const err = new Error("هذا المنتج غير متاح");
      err.status = 400;
      throw err;
    }
    if (!isStockManaged(product.stock)) continue;
    if (qty > product.stock) {
      const err = new Error(
        `الكمية المطلوبة (${qty}) أكبر من المتوفر (${product.stock}) — ${product.name}`
      );
      err.status = 400;
      throw err;
    }
  }
}

async function assertProductStockAvailable(productId, quantityNeeded) {
  await assertProductsStockAvailable(new Map([[productId.toString(), quantityNeeded]]));
  return getProductStockInfo(productId);
}

async function deductProductStock(productId, quantity, session) {
  const opts = session ? { session, new: true } : { new: true };
  const updated = await Product.findOneAndUpdate(
    { _id: productId, stock: { $gte: quantity } },
    { $inc: { stock: -quantity } },
    opts
  );
  if (!updated) {
    const product = await Product.findById(productId).select("name stock");
    const err = new Error(
      product
        ? `الكمية المطلوبة (${quantity}) أكبر من المتوفر (${product.stock ?? 0}) — ${product.name}`
        : "المنتج غير موجود"
    );
    err.status = 400;
    throw err;
  }
  return updated;
}

async function restoreProductStock(productId, quantity, session) {
  const opts = session ? { session } : {};
  await Product.findByIdAndUpdate(productId, { $inc: { stock: quantity } }, opts);
}

async function restoreStockForOrderItems(orderItems, session) {
  const opts = session ? { session } : {};
  const productQty = new Map();
  for (const oi of orderItems) {
    if (oi.itemType !== "Product") continue;
    const id = oi.item.toString();
    productQty.set(id, (productQty.get(id) || 0) + oi.quantity);
  }
  for (const [productId, qty] of productQty) {
    await Product.findByIdAndUpdate(productId, { $inc: { stock: qty } }, opts);
  }
}

async function deductStockForOrderItems(items, session) {
  const productQty = new Map();
  for (const item of items) {
    if (item.itemType !== "Product") continue;
    if (item.purchaseMethod === "price") continue;
    const id = item.item.toString();
    productQty.set(id, (productQty.get(id) || 0) + item.quantity);
  }

  const deducted = [];
  if (productQty.size === 0) return deducted;

  const ids = [...productQty.keys()];
  let productQuery = Product.find({ _id: { $in: ids } }).select("stock name");
  if (session) productQuery = productQuery.session(session);
  const products = await productQuery.lean();
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  for (const [productId, qty] of productQty) {
    const product = productMap.get(productId);
    if (!product || !isStockManaged(product.stock)) continue;
    await deductProductStock(productId, qty, session);
    deducted.push({ productId, qty });
  }
  return deducted;
}

async function restoreStockDeductions(deductions, session) {
  for (const { productId, qty } of deductions) {
    await restoreProductStock(productId, qty, session);
  }
}

function enrichCartItemDoc(doc, itemType) {
  if (!doc) return null;
  const plain = doc.toObject ? doc.toObject() : { ...doc };

  if (itemType === "Offer") {
    const pricing = pricingService.buildOfferPricingDTO(plain);
    plain.pricing = pricing;
    plain.price = pricing.unitPrice;
  }

  return plain;
}

async function populateCartItems(items) {
  if (!items?.length) return [];

  const productIds = [];
  const offerIds = [];
  for (const cartItem of items) {
    const id = cartItem.item?.toString?.() ?? String(cartItem.item);
    if (cartItem.itemType === "Product") productIds.push(id);
    else if (cartItem.itemType === "Offer") offerIds.push(id);
  }

  const [products, offers] = await Promise.all([
    productIds.length
      ? Product.find({ _id: { $in: productIds } })
          .select("name price currency priceUnit image images description isActive store stock purchaseMode")
          .lean()
      : [],
    offerIds.length
      ? Offer.find({ _id: { $in: offerIds } })
          .select(
            "title finalPrice price image images description isActive store value offerType originalPrice currency purchaseMode"
          )
          .lean()
      : [],
  ]);

  const productMap = new Map(products.map((p) => [p._id.toString(), p]));
  const offerMap = new Map(offers.map((o) => [o._id.toString(), o]));

  const storeIds = new Set();
  for (const doc of [...products, ...offers]) {
    if (doc.store) storeIds.add(doc.store.toString());
  }

  const stores = storeIds.size
    ? await Store.find({ _id: { $in: [...storeIds] } })
        .select("name region phone owner")
        .populate({ path: "owner", select: "role name" })
        .lean()
    : [];
  const storeMap = new Map(stores.map((s) => [s._id.toString(), s]));

  function attachStore(doc) {
    if (!doc?.store) return doc;
    const store = storeMap.get(doc.store.toString());
    return store ? { ...doc, store } : doc;
  }

  return items.map((cartItem) => {
    try {
      const id = cartItem.item?.toString?.() ?? String(cartItem.item);
      let doc = null;

      if (cartItem.itemType === "Product") {
        doc = attachStore(productMap.get(id) || null);
      } else if (cartItem.itemType === "Offer") {
        doc = enrichCartItemDoc(attachStore(offerMap.get(id) || null), "Offer");
      }

      const unitPrice =
        cartItem.itemType === "Offer"
          ? pricingService.getOfferUnitPrice(doc)
          : doc?.price ?? 0;

      const purchaseMethod = cartItem.purchaseMethod || "quantity";
      let lineTotal;
      if (purchaseMethod === "price") {
        lineTotal = Math.round((cartItem.requestedAmount || 0) * 100) / 100;
      } else if (cartItem.itemType === "Offer") {
        lineTotal = pricingService.computeOfferLineTotal(doc, cartItem.quantity);
      } else {
        lineTotal = Math.round(unitPrice * cartItem.quantity * 100) / 100;
      }

      return {
        item: doc,
        itemType: cartItem.itemType,
        quantity: cartItem.quantity,
        purchaseMethod,
        requestedAmount: cartItem.requestedAmount,
        unitPrice,
        lineTotal,
      };
    } catch {
      return {
        item: null,
        itemType: cartItem.itemType,
        quantity: cartItem.quantity,
        unitPrice: 0,
        lineTotal: 0,
      };
    }
  });
}

function calculateCartTotal(populatedItems) {
  return populatedItems.reduce((sum, row) => {
    if (!row.item || row.item.isActive === false) return sum;
    return sum + (row.lineTotal ?? (row.unitPrice || 0) * row.quantity);
  }, 0);
}

function filterValidCheckoutItems(populatedItems, userRole = "customer") {
  return populatedItems.filter((row) => {
    if (!row.item || row.item.isActive === false) return false;
    const ownerRole = row.item.store?.owner?.role;
    if (userRole === "store" || userRole === "supplier") {
      return ownerRole === "store" || ownerRole === "supplier";
    }
    return ownerRole === "store";
  });
}

async function migrateLegacyItemsToContainers(cart) {
  if (!cart) return cart;
  if (!cart.containers) cart.containers = [];

  const hasUnlockedWithItems = cart.containers.some((c) => !c.locked && c.items?.length);
  if (hasUnlockedWithItems || !cart.items?.length) {
    cart.items = syncFlatItemsFromContainers(cart.containers);
    return cart;
  }

  const populated = await populateCartItems(cart.items);
  const byStore = new Map();

  for (const row of populated) {
    if (!row.item?.store?._id) continue;
    const storeId = row.item.store._id.toString();
    const storeName = row.item.store.name || "";
    if (!byStore.has(storeId)) byStore.set(storeId, { storeId, storeName, items: [] });
    mergeIntoContainerItems(byStore.get(storeId).items, row.item._id, row.itemType, {
      qty: row.quantity,
      purchaseMethod: row.purchaseMethod || "quantity",
      requestedAmount: row.requestedAmount,
    });
  }

  for (const [, group] of byStore) {
    const container = findOrCreateUnlockedContainer(cart, group.storeId, group.storeName);
    for (const it of group.items) {
      mergeIntoContainerItems(container.items, it.item, it.itemType, {
        qty: it.quantity,
        purchaseMethod: it.purchaseMethod || "quantity",
        requestedAmount: it.requestedAmount,
      });
    }
  }

  cart.items = syncFlatItemsFromContainers(cart.containers);
  if (cart.isModified?.() ?? true) await cart.save();
  return cart;
}

async function buildCartResponse(cartDoc) {
  const cart = cartDoc.toObject ? cartDoc : cartDoc;
  const activeContainers = (cart.containers || []).filter((c) => !c.locked);

  const containerResponses = [];
  let grandTotal = 0;
  const allFlat = [];

  for (const c of activeContainers) {
    const populatedItems = await populateCartItems(c.items || []);
    const validItems = populatedItems.filter((i) => i.item && i.item.isActive !== false);
    const total = calculateCartTotal(validItems);
    grandTotal += total;
    allFlat.push(...validItems);

    const storeDoc = validItems[0]?.item?.store;
    containerResponses.push({
      id: c._id?.toString?.() ?? String(c._id),
      store: storeDoc
        ? { _id: storeDoc._id, name: storeDoc.name, phone: storeDoc.phone }
        : { _id: c.store, name: c.storeName || "" },
      storeName: c.storeName || storeDoc?.name || "",
      customerNotes: c.customerNotes || "",
      locked: false,
      items: validItems,
      total: Math.round(total * 100) / 100,
    });
  }

  return {
    containers: containerResponses,
    items: allFlat,
    total: Math.round(grandTotal * 100) / 100,
  };
}

async function restoreCartSnapshot(userId, cartItems, session) {
  if (!cartItems?.length) return;
  const opts = session ? { session } : {};
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = new Cart({ user: userId, items: [], containers: [] });

  await migrateLegacyItemsToContainers(cart);

  const populated = await populateCartItems(cartItems);
  for (const row of populated) {
    const storeId = row.item?.store?._id;
    if (!storeId) continue;
    const container = findOrCreateUnlockedContainer(
      cart,
      storeId,
      row.item.store?.name || ""
    );
    mergeIntoContainerItems(container.items, row.item._id, row.itemType, {
      qty: row.quantity,
      purchaseMethod: row.purchaseMethod || "quantity",
      requestedAmount: row.requestedAmount,
    });
  }
  cart.items = syncFlatItemsFromContainers(cart.containers);
  await cart.save(opts);
}

async function restoreItemsToStoreContainer(userId, orderItems, storeId, session) {
  const opts = session ? { session } : {};
  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = new Cart({ user: userId, items: [], containers: [] });

  await migrateLegacyItemsToContainers(cart);
  const store = await Store.findById(storeId).select("name").lean();
  const container = findOrCreateUnlockedContainer(cart, storeId, store?.name || "");

  for (const oi of orderItems) {
    mergeIntoContainerItems(container.items, oi.item, oi.itemType, {
      qty: oi.quantity,
      purchaseMethod: oi.purchaseMethod || "quantity",
      requestedAmount: oi.requestedAmount,
    });
  }
  cart.items = syncFlatItemsFromContainers(cart.containers);
  await cart.save(opts);
  await restoreStockForOrderItems(orderItems, session);
}

const CHECKOUT_DEDUP_MS = 60_000;

/**
 * Orders already created for a client-generated checkout id.
 * A retried offline sync replays these instead of creating duplicates.
 */
async function findOrdersByClientOperationId(userId, clientOperationId) {
  if (!clientOperationId) return [];
  return Order.find({ customer: userId, clientOperationId })
    .sort({ createdAt: 1 })
    .lean();
}

function toConfirmResponse(order) {
  return {
    message: "تم إرسال طلبك — بانتظار تأكيد صاحب المحل",
    verificationCode: order.verificationCode,
    order: {
      id: order._id,
      orderNumber: order.orderNumber,
      verificationCode: order.verificationCode,
      store: order.store,
      total: order.total,
      status: order.status,
    },
  };
}

function toCheckoutResponse(orders) {
  return {
    ordersCount: orders.length,
    orders: orders.map((o) => ({
      id: o._id,
      store: o.store,
      total: o.total,
      status: o.status,
      orderNumber: o.orderNumber,
      verificationCode: o.verificationCode,
    })),
  };
}

async function assertNoRecentDuplicateOrders(userId, orderPayloads, session) {
  if (!orderPayloads.length) return;
  const since = new Date(Date.now() - CHECKOUT_DEDUP_MS);
  const queryOpts = session ? { session } : {};
  const duplicate = await Order.findOne(
    {
      customer: userId,
      status: "pending",
      createdAt: { $gte: since },
      $or: orderPayloads.map((p) => ({ store: p.store, total: p.total })),
    },
    null,
    queryOpts
  );
  if (duplicate) {
    const err = new Error("طلب مكرر — تم استلام طلبك مسبقاً");
    err.status = 409;
    err.code = "DUPLICATE_ORDER";
    throw err;
  }
}

async function buildOrdersFromCartItems(
  userId,
  cartItems,
  session,
  userRole = "customer",
  extraOrderFields = {}
) {
  const populatedItems = await populateCartItems(cartItems);
  const validItems = filterValidCheckoutItems(populatedItems, userRole);

  if (validItems.length === 0) {
    const err = new Error(
      userRole === "customer"
        ? "لا توجد منتجات متاحة في السلة (عروض أصحاب المحلات فقط)"
        : "لا توجد منتجات متاحة في السلة"
    );
    err.status = 400;
    throw err;
  }

  const storeMap = {};
  for (const ci of validItems) {
    const storeId = ci.item.store?._id?.toString();
    if (!storeId) continue;
    if (!storeMap[storeId]) storeMap[storeId] = { storeId, items: [] };

    const purchaseMethod = ci.purchaseMethod || "quantity";
    const lineTotal = ci.lineTotal ?? (ci.unitPrice || 0) * ci.quantity;
    const effectiveUnit =
      purchaseMethod === "price"
        ? ci.requestedAmount ?? lineTotal
        : ci.quantity > 0
          ? Math.round((lineTotal / ci.quantity) * 100) / 100
          : ci.unitPrice ?? 0;

    storeMap[storeId].items.push({
      item: ci.item._id,
      itemType: ci.itemType,
      quantity: purchaseMethod === "price" ? 1 : ci.quantity,
      purchaseMethod,
      ...(purchaseMethod === "price" ? { requestedAmount: ci.requestedAmount } : {}),
      price: effectiveUnit,
      name: ci.item.name || ci.item.title || "",
      image: resolveItemImage(ci.item),
      _lineTotal: lineTotal,
    });
  }

  const productQty = new Map();
  for (const ci of validItems) {
    if (ci.itemType !== "Product") continue;
    if (ci.purchaseMethod === "price") continue;
    const id = ci.item._id.toString();
    productQty.set(id, (productQty.get(id) || 0) + ci.quantity);
  }
  if (productQty.size) await assertProductsStockAvailable(productQty);

  const customerDoc = await User.findById(userId).select("name phone").lean();
  const storeIds = Object.keys(storeMap);
  const storeDocs = await Store.find({ _id: { $in: storeIds } }).select("name").lean();
  const storeNameById = Object.fromEntries(storeDocs.map((s) => [s._id.toString(), s.name || ""]));

  const orderPayloads = Object.values(storeMap).map(({ storeId, items }) => {
    const storeTotal = items.reduce((s, i) => s + i._lineTotal, 0);
    return {
      store: storeId,
      total: Math.round(storeTotal * 100) / 100,
    };
  });
  // A client operation id is an exact duplicate guarantee, so the
  // total-based heuristic (which can reject a genuine repeat order) is skipped.
  if (!extraOrderFields.clientOperationId) {
    await assertNoRecentDuplicateOrders(userId, orderPayloads, session);
  }

  let stockDeductions = [];
  try {
    stockDeductions = await deductStockForOrderItems(
      validItems
        .filter((ci) => ci.purchaseMethod !== "price")
        .map((ci) => ({
          item: ci.item._id,
          itemType: ci.itemType,
          quantity: ci.quantity,
        })),
      session
    );

    const now = new Date();
    const orders = [];
    for (const { storeId, items } of Object.values(storeMap)) {
      const storeTotal = items.reduce((s, i) => s + i._lineTotal, 0);
      const roundedTotal = Math.round(storeTotal * 100) / 100;
      const orderItems = items.map(({ _lineTotal, ...rest }) => ({
        ...rest,
        productId: rest.item,
        productName: rest.name,
        productImage: rest.image,
        subtotal: Math.round(_lineTotal * 100) / 100,
      }));
      const verificationCode = await generateUniqueVerificationCode(session);
      const payload = {
        customer: userId,
        store: storeId,
        customerName: customerDoc?.name || "",
        customerPhone: customerDoc?.phone || "",
        storeName: extraOrderFields.containerName || storeNameById[storeId] || "",
        items: orderItems,
        subtotal: roundedTotal,
        total: roundedTotal,
        totalAmount: roundedTotal,
        status: "pending",
        orderNumber:
          orders.length === 0 && extraOrderFields.orderNumber
            ? extraOrderFields.orderNumber
            : generateOrderNumber(),
        verificationCode,
        ...(extraOrderFields.clientOperationId
          ? { clientOperationId: extraOrderFields.clientOperationId }
          : {}),
        containerId: extraOrderFields.containerId || "",
        containerName: extraOrderFields.containerName || storeNameById[storeId] || "",
        customerNotes: extraOrderFields.customerNotes || "",
        deliveryNotes: extraOrderFields.deliveryNotes || extraOrderFields.customerNotes || "",
        deliveryMethod: extraOrderFields.deliveryMethod || "",
        deliveryAddress: extraOrderFields.deliveryAddress || "",
        paymentMethod: extraOrderFields.paymentMethod || "",
        paymentProof: extraOrderFields.paymentProof || "",
        paymentProofImage: extraOrderFields.paymentProofImage || extraOrderFields.paymentProof || "",
        transferInformation: extraOrderFields.transferInformation || {},
        transferName: extraOrderFields.transferName || extraOrderFields.transferInformation?.senderName || "",
        transferPhone: extraOrderFields.transferPhone || extraOrderFields.transferInformation?.contactNumber || "",
        transferNumber: extraOrderFields.transferNumber || extraOrderFields.transferInformation?.referenceNumber || "",
        paymentNotes: extraOrderFields.paymentNotes || extraOrderFields.transferInformation?.note || "",
        paymentStatus: extraOrderFields.paymentProof ? "pending" : "unpaid",
        statusTimeline: extraOrderFields.statusTimeline || [{ status: "pending", at: now }],
      };

      if (session) {
        const created = await Order.create([payload], { session });
        orders.push(created[0]);
      } else {
        orders.push(await Order.create(payload));
      }
    }

    return orders;
  } catch (err) {
    await restoreStockDeductions(stockDeductions, session);
    throw err;
  }
}

async function checkoutCore(userId, session, userRole = "customer", clientOperationId = "") {
  let cartQuery = Cart.findOne({ user: userId });
  if (session) cartQuery = cartQuery.session(session);
  const cart = await cartQuery;
  if (!cart) {
    const err = new Error("السلة فارغة");
    err.status = 400;
    throw err;
  }

  await migrateLegacyItemsToContainers(cart);
  const activeContainers = (cart.containers || []).filter((c) => !c.locked && c.items?.length);
  const flatItems = activeContainers.flatMap((c) =>
    (c.items || []).map(toCartSnapshotItem)
  );

  if (!flatItems.length && !cart.items?.length) {
    const err = new Error("السلة فارغة");
    err.status = 400;
    throw err;
  }

  const snapshot = flatItems.length
    ? flatItems
    : (cart.items || []).map(toCartSnapshotItem);

  cart.containers = (cart.containers || []).filter((c) => c.locked);
  cart.items = [];
  await cart.save(session ? { session } : {});

  try {
    const orders = await buildOrdersFromCartItems(userId, snapshot, session, userRole, {
      clientOperationId,
    });
    return toCheckoutResponse(orders);
  } catch (err) {
    if (!session) {
      await restoreCartSnapshot(userId, snapshot, null);
    }
    throw err;
  }
}

async function getCartForUser(userId) {
  let cart = await Cart.findOne({ user: userId });
  if (!cart) return { items: [], containers: [], total: 0 };
  await migrateLegacyItemsToContainers(cart);
  return buildCartResponse(cart);
}

async function addToCart(user, body) {
  assertNoMongoOperators(body, "cart");
  const itemId = requireObjectId(body.itemId, "itemId");
  const itemType = cleanString(body.itemType, { field: "itemType", max: 20, required: true });

  const normalizedType = normalizeItemType(itemType);
  if (!normalizedType) {
    const err = new Error("itemType غير صحيح");
    err.status = 400;
    throw err;
  }

  const Model = normalizedType === "Product" ? Product : Offer;
  const exists = await Model.findById(itemId)
    .select("_id isActive store stock name title")
    .populate({ path: "store", select: "name owner", populate: { path: "owner", select: "role" } });

  if (!exists) {
    const err = new Error("العنصر غير موجود");
    err.status = 404;
    throw err;
  }
  if (exists.isActive === false) {
    const err = new Error("هذا العنصر غير متاح");
    err.status = 400;
    throw err;
  }
  if (user.role === "customer" && exists.store?.owner?.role === "supplier") {
    const err = new Error("هذا العرض/المنتج غير متاح للزبائن — أصحاب المحلات فقط");
    err.status = 403;
    throw err;
  }

  let cart = await Cart.findOne({ user: user.id });
  if (!cart) cart = new Cart({ user: user.id, items: [], containers: [] });

  await migrateLegacyItemsToContainers(cart);

  const storeId = exists.store._id.toString();
  const storeName = exists.store.name || "";
  const container = findOrCreateUnlockedContainer(cart, storeId, storeName);

  const line =
    normalizedType === "Product"
      ? await resolveProductCartLine(itemId, body)
      : await resolveOfferCartLine(itemId, body);

  const purchaseMethod = line.purchaseMethod || "quantity";
  const existing = container.items.find((i) =>
    cartLineMatches(i, itemId, normalizedType, purchaseMethod)
  );

  if (normalizedType === "Product" && purchaseMethod === "quantity") {
    const nextQty = existing ? existing.quantity + line.quantity : line.quantity;
    await assertProductStockAvailable(itemId, nextQty);
  }

  mergeIntoContainerItems(container.items, itemId, normalizedType, {
    qty: line.quantity,
    purchaseMethod,
    requestedAmount: line.requestedAmount,
  });
  cart.items = syncFlatItemsFromContainers(cart.containers);
  await cart.save();
  invalidateCartCache(user.id);

  return buildCartResponse(cart);
}

async function updateCartItem(userId, body) {
  assertNoMongoOperators(body, "cart");
  const itemId = requireObjectId(body.itemId, "itemId");
  const itemType = cleanString(body.itemType, { field: "itemType", max: 20, required: true });

  const normalizedType = normalizeItemType(itemType);
  const purchaseMethod = normalizePurchaseMethod(body.purchaseMethod || "quantity");

  const cart = await Cart.findOne({ user: userId });
  if (!cart) {
    const err = new Error("السلة غير موجودة");
    err.status = 404;
    throw err;
  }

  await migrateLegacyItemsToContainers(cart);

  let updated = false;
  for (const container of cart.containers || []) {
    if (container.locked) continue;
    const idx = container.items.findIndex((i) =>
      cartLineMatches(i, itemId, normalizedType, purchaseMethod)
    );
    if (idx === -1) continue;

    if (purchaseMethod === "price") {
      const amount = parseRequestedAmount(body.requestedAmount);
      container.items[idx].quantity = 1;
      container.items[idx].purchaseMethod = "price";
      container.items[idx].requestedAmount = amount;
    } else {
      const qty = parsePositiveQuantity(body.quantity);
      if (normalizedType === "Product") {
        await assertProductStockAvailable(itemId, qty);
      }
      container.items[idx].quantity = qty;
      container.items[idx].purchaseMethod = "quantity";
      container.items[idx].requestedAmount = undefined;
    }
    updated = true;
    break;
  }

  if (!updated) {
    const err = new Error("العنصر غير موجود في السلة");
    err.status = 404;
    throw err;
  }

  cart.items = syncFlatItemsFromContainers(cart.containers);
  await cart.save();
  invalidateCartCache(userId);

  return getCartForUser(userId);
}

async function removeFromCart(userId, body) {
  assertNoMongoOperators(body, "cart");
  const itemId = requireObjectId(body.itemId, "itemId");
  const itemType = cleanString(body.itemType, { field: "itemType", max: 20, required: true });

  const normalizedType = normalizeItemType(itemType);
  const purchaseMethod = body.purchaseMethod
    ? normalizePurchaseMethod(body.purchaseMethod)
    : null;

  const cart = await Cart.findOne({ user: userId });
  if (!cart) {
    const err = new Error("السلة غير موجودة");
    err.status = 404;
    throw err;
  }

  await migrateLegacyItemsToContainers(cart);

  for (const container of cart.containers || []) {
    if (container.locked) continue;
    container.items = container.items.filter((i) => {
      if (i.item.toString() !== itemId || i.itemType !== normalizedType) return true;
      if (purchaseMethod) return (i.purchaseMethod || "quantity") !== purchaseMethod;
      return false;
    });
  }
  cart.containers = (cart.containers || []).filter(
    (c) => c.locked || (c.items && c.items.length > 0)
  );
  cart.items = syncFlatItemsFromContainers(cart.containers);
  await cart.save();
  invalidateCartCache(userId);

  return getCartForUser(userId);
}

async function clearCart(userId) {
  const cart = await Cart.findOne({ user: userId });
  if (!cart) return { items: [], containers: [], total: 0 };
  cart.items = [];
  cart.containers = (cart.containers || []).filter((c) => c.locked);
  await cart.save();
  invalidateCartCache(userId);
  return { items: [], containers: [], total: 0 };
}

async function confirmStoreContainer(userId, storeIdRaw, body = {}, userRole = "customer") {
  const storeId = requireObjectId(storeIdRaw, "storeId");
  const checkoutFields = parseOrderCheckoutBody(body);

  const replayed = await findOrdersByClientOperationId(userId, checkoutFields.clientOperationId);
  if (replayed.length) return toConfirmResponse(replayed[0]);

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    let cart = await Cart.findOne({ user: userId }).session(session);
    if (!cart) {
      const err = new Error("السلة فارغة");
      err.status = 400;
      throw err;
    }

    await migrateLegacyItemsToContainers(cart);

    const containerIdx = (cart.containers || []).findIndex(
      (c) => !c.locked && c.store.toString() === storeId.toString()
    );
    if (containerIdx === -1) {
      const err = new Error("لا توجد سلة نشطة لهذا المتجر");
      err.status = 404;
      throw err;
    }

    const container = cart.containers[containerIdx];
    if (!container.items?.length) {
      const err = new Error("سلة المتجر فارغة");
      err.status = 400;
      throw err;
    }

    const snapshot = container.items.map(toCartSnapshotItem);

    const storeDoc = await Store.findById(storeId).select("name").lean();
    const containerName = container.storeName || storeDoc?.name || "";

    const orders = await buildOrdersFromCartItems(userId, snapshot, session, userRole, {
      containerId: container._id.toString(),
      containerName,
      clientOperationId: checkoutFields.clientOperationId,
      customerNotes: checkoutFields.customerNotes || container.customerNotes || "",
      deliveryNotes: checkoutFields.deliveryNotes,
      deliveryMethod: checkoutFields.deliveryMethod,
      deliveryAddress: checkoutFields.deliveryAddress,
      paymentMethod: checkoutFields.paymentMethod,
      paymentProof: checkoutFields.paymentProof,
      paymentProofImage: checkoutFields.paymentProofImage,
      transferInformation: checkoutFields.transferInformation,
      transferName: checkoutFields.transferName,
      transferPhone: checkoutFields.transferPhone,
      transferNumber: checkoutFields.transferNumber,
      paymentNotes: checkoutFields.paymentNotes,
      orderNumber: generateOrderNumber(),
      statusTimeline: [{ status: "pending", at: new Date() }],
    });

    cart.containers.splice(containerIdx, 1);
    cart.items = syncFlatItemsFromContainers(cart.containers);
    await cart.save({ session });

    await session.commitTransaction();
    invalidateCartCache(userId);

    const order = orders[0];
    return {
      message: "تم إرسال طلبك — بانتظار تأكيد صاحب المحل",
      verificationCode: order.verificationCode,
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        verificationCode: order.verificationCode,
        store: order.store,
        total: order.total,
        status: order.status,
      },
    };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (
      err.message?.includes("Transaction numbers") ||
      err.code === 20 ||
      err.code === 251 ||
      err.code === 263
    ) {
      return confirmStoreContainerFallback(userId, storeIdRaw, body, userRole);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function confirmStoreContainerFallback(userId, storeIdRaw, body, userRole) {
  const storeId = requireObjectId(storeIdRaw, "storeId");
  const checkoutFields = parseOrderCheckoutBody(body);

  const replayed = await findOrdersByClientOperationId(userId, checkoutFields.clientOperationId);
  if (replayed.length) return toConfirmResponse(replayed[0]);

  let cart = await Cart.findOne({ user: userId });
  if (!cart) {
    const err = new Error("السلة فارغة");
    err.status = 400;
    throw err;
  }

  await migrateLegacyItemsToContainers(cart);

  const containerIdx = (cart.containers || []).findIndex(
    (c) => !c.locked && c.store.toString() === storeId.toString()
  );
  if (containerIdx === -1) {
    const err = new Error("لا توجد سلة نشطة لهذا المتجر");
    err.status = 404;
    throw err;
  }

  const container = cart.containers[containerIdx];
  const snapshot = container.items.map(toCartSnapshotItem);

  const storeDoc = await Store.findById(storeId).select("name").lean();
  const orders = await buildOrdersFromCartItems(userId, snapshot, null, userRole, {
    containerId: container._id.toString(),
    containerName: container.storeName || storeDoc?.name || "",
    clientOperationId: checkoutFields.clientOperationId,
    customerNotes: checkoutFields.customerNotes || container.customerNotes || "",
    deliveryNotes: checkoutFields.deliveryNotes,
    deliveryMethod: checkoutFields.deliveryMethod,
    deliveryAddress: checkoutFields.deliveryAddress,
    paymentMethod: checkoutFields.paymentMethod,
    paymentProof: checkoutFields.paymentProof,
    paymentProofImage: checkoutFields.paymentProofImage,
    transferInformation: checkoutFields.transferInformation,
    transferName: checkoutFields.transferName,
    transferPhone: checkoutFields.transferPhone,
    transferNumber: checkoutFields.transferNumber,
    paymentNotes: checkoutFields.paymentNotes,
    orderNumber: generateOrderNumber(),
    statusTimeline: [{ status: "pending", at: new Date() }],
  });

  cart.containers.splice(containerIdx, 1);
  cart.items = syncFlatItemsFromContainers(cart.containers);
  await cart.save();
  invalidateCartCache(userId);

  const order = orders[0];
  return {
    message: "تم إرسال طلبك — بانتظار تأكيد صاحب المحل",
    verificationCode: order.verificationCode,
    order: {
      id: order._id,
      orderNumber: order.orderNumber,
      verificationCode: order.verificationCode,
      store: order.store,
      total: order.total,
      status: order.status,
    },
  };
}

async function checkout(userId, userRole = "customer", body = {}) {
  const clientOperationId = cleanString(body?.clientOperationId, {
    field: "clientOperationId",
    max: 64,
  }) || "";

  const replayed = await findOrdersByClientOperationId(userId, clientOperationId);
  if (replayed.length) return toCheckoutResponse(replayed);

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await checkoutCore(userId, session, userRole, clientOperationId);
    await session.commitTransaction();
    invalidateCartCache(userId);
    return result;
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    if (
      err.message?.includes("Transaction numbers") ||
      err.code === 20 ||
      err.code === 251 ||
      err.code === 263
    ) {
      const retried = await findOrdersByClientOperationId(userId, clientOperationId);
      if (retried.length) return toCheckoutResponse(retried);
      const result = await checkoutCore(userId, null, userRole, clientOperationId);
      invalidateCartCache(userId);
      return result;
    }
    throw err;
  } finally {
    session.endSession();
  }
}

module.exports = {
  parseOrderCheckoutBody,
  populateCartItems,
  calculateCartTotal,
  getCartForUser,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  checkout,
  confirmStoreContainer,
  restoreStockForOrderItems,
  restoreItemsToStoreContainer,
  deductStockForOrderItems,
};
