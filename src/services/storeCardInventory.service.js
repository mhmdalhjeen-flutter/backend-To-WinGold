const Store = require("../models/store");
const CodeOrder = require("../models/codeOrder");
const CardType = require("../models/cardType");

function inventoryKey(cardTypeId, pointsValue) {
  return `${cardTypeId || "none"}:${pointsValue}`;
}

function findInventoryEntry(inventory, cardTypeId, pointsValue) {
  const typeStr = cardTypeId ? String(cardTypeId) : null;
  return (inventory || []).find((entry) => {
    const entryType = entry.cardType ? String(entry.cardType) : null;
    return entryType === typeStr && entry.pointsValue === pointsValue;
  });
}

async function resolvePointsFromHistory(storeId) {
  const order = await CodeOrder.findOne({ store: storeId, status: "received" })
    .sort({ receivedAt: -1, configuredAt: -1, createdAt: -1 })
    .populate("cardType", "pointsValue points")
    .lean();

  if (order?.cardType) {
    const value = order.cardType.pointsValue ?? order.cardType.points ?? 0;
    if (value > 0) return value;
  }

  const fallbackType = await CardType.findOne({ isActive: true }).sort({ pointsValue: -1 }).select("pointsValue").lean();
  return fallbackType?.pointsValue > 0 ? fallbackType.pointsValue : 1;
}

async function ensureLegacyInventory(storeId, session) {
  const opts = session ? { session } : {};
  const store = await Store.findById(storeId).select("cards cardInventory").setOptions(opts);
  if (!store || store.cards <= 0) return store;
  if ((store.cardInventory || []).some((entry) => entry.count > 0)) return store;

  const pointsValue = await resolvePointsFromHistory(storeId);
  store.cardInventory = [{ cardType: null, pointsValue, count: store.cards }];
  store.markModified("cardInventory");
  await store.save(opts);
  return store;
}

/**
 * Add digital cards to a store's typed inventory (and total cards counter).
 */
async function addCardsToStore(storeId, { cardType = null, pointsValue, quantity }, session) {
  const qty = Number(quantity);
  const points = Number(pointsValue);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (!Number.isFinite(points) || points <= 0) {
    const err = new Error("قيمة نقاط الكرت غير صالحة");
    err.status = 400;
    throw err;
  }

  const opts = session ? { session } : {};
  const store = await Store.findById(storeId).setOptions(opts);
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  store.cardInventory = store.cardInventory || [];
  const existing = findInventoryEntry(store.cardInventory, cardType, points);
  if (existing) {
    existing.count += qty;
  } else {
    store.cardInventory.push({ cardType, pointsValue: points, count: qty });
  }
  store.cards = (store.cards || 0) + qty;
  store.markModified("cardInventory");
  await store.save(opts);
  return store;
}

/**
 * Consume one digital card (FIFO) and return its reward points.
 */
async function consumeStoreCard(storeId, session) {
  const opts = session ? { session, new: true } : { new: true };
  await ensureLegacyInventory(storeId, session);

  const store = await Store.findOne({ _id: storeId, cards: { $gt: 0 } }).setOptions(session ? { session } : {});
  if (!store) {
    const err = new Error(
      "لا يوجد كروت كافية لتأكيد الطلب. يرجى شراء كروت أو التواصل مع الإدارة."
    );
    err.status = 403;
    err.noCards = true;
    throw err;
  }

  store.cardInventory = store.cardInventory || [];
  const entryIdx = store.cardInventory.findIndex((entry) => entry.count > 0);
  if (entryIdx === -1) {
    const err = new Error(
      "لا يوجد كروت كافية لتأكيد الطلب. يرجى شراء كروت أو التواصل مع الإدارة."
    );
    err.status = 403;
    err.noCards = true;
    throw err;
  }

  const entry = store.cardInventory[entryIdx];
  const consumed = {
    cardType: entry.cardType || null,
    pointsValue: entry.pointsValue,
  };

  entry.count -= 1;
  if (entry.count <= 0) {
    store.cardInventory.splice(entryIdx, 1);
  }

  store.cards = Math.max(0, (store.cards || 0) - 1);
  store.markModified("cardInventory");

  const updatedStore = await Store.findByIdAndUpdate(
    store._id,
    { $set: { cards: store.cards, cardInventory: store.cardInventory } },
    opts
  );

  return {
    ...consumed,
    remainingCards: updatedStore?.cards ?? store.cards,
  };
}

/**
 * Restore one consumed card back to store inventory.
 */
async function restoreStoreCard(storeId, { cardType = null, pointsValue }, session) {
  if (!pointsValue || pointsValue <= 0) return null;

  const opts = session ? { session, new: true } : { new: true };
  const store = await Store.findById(storeId).setOptions(session ? { session } : {});
  if (!store) return null;

  store.cardInventory = store.cardInventory || [];
  const existing = findInventoryEntry(store.cardInventory, cardType, pointsValue);
  if (existing) {
    existing.count += 1;
  } else {
    store.cardInventory.push({ cardType, pointsValue, count: 1 });
  }
  store.cards = (store.cards || 0) + 1;
  store.markModified("cardInventory");

  return Store.findByIdAndUpdate(
    store._id,
    { $set: { cards: store.cards, cardInventory: store.cardInventory } },
    opts
  );
}

module.exports = {
  addCardsToStore,
  consumeStoreCard,
  restoreStoreCard,
  resolvePointsFromHistory,
  ensureLegacyInventory,
  inventoryKey,
  findInventoryEntry,
};
