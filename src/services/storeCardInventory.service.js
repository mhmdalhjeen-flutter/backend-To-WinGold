const Store = require("../models/store");
const CodeOrder = require("../models/codeOrder");
const CardType = require("../models/cardType");
const PromoCode = require("../models/promoCode");
const { CARD_SOURCES } = require("../constants/storeSubscription.constants");

function inventoryKey(cardTypeId, pointsValue, source = CARD_SOURCES.INDEPENDENT) {
  return `${cardTypeId || "none"}:${pointsValue}:${source || CARD_SOURCES.INDEPENDENT}`;
}

function normalizeCardSource(source) {
  return source === CARD_SOURCES.SUBSCRIPTION
    ? CARD_SOURCES.SUBSCRIPTION
    : CARD_SOURCES.INDEPENDENT;
}

function findInventoryEntry(inventory, cardTypeId, pointsValue, source = null) {
  const typeStr = cardTypeId ? String(cardTypeId) : null;
  const normalizedSource = source ? normalizeCardSource(source) : null;
  return (inventory || []).find((entry) => {
    const entryType = entry.cardType ? String(entry.cardType) : null;
    const entrySource = normalizeCardSource(entry.source);
    const sourceMatches = normalizedSource ? entrySource === normalizedSource : true;
    return entryType === typeStr && entry.pointsValue === pointsValue && sourceMatches;
  });
}

function findConsumptionEntryIndex(inventory) {
  const rows = inventory || [];
  const subscriptionIdx = rows.findIndex(
    (entry) => entry.count > 0 && normalizeCardSource(entry.source) === CARD_SOURCES.SUBSCRIPTION,
  );
  if (subscriptionIdx !== -1) return subscriptionIdx;
  return rows.findIndex((entry) => entry.count > 0);
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
  store.cardInventory = [{
    cardType: null,
    pointsValue,
    count: store.cards,
    source: CARD_SOURCES.INDEPENDENT,
    subscriptionPeriodId: null,
  }];
  store.markModified("cardInventory");
  await store.save(opts);
  return store;
}

/**
 * Add digital cards to a store's typed inventory (and total cards counter).
 */
async function addCardsToStore(
  storeId,
  { cardType = null, pointsValue, quantity, source = CARD_SOURCES.INDEPENDENT, subscriptionPeriodId = null },
  session,
) {
  const qty = Number(quantity);
  const points = Number(pointsValue);
  const cardSource = normalizeCardSource(source);
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
  const existing = findInventoryEntry(store.cardInventory, cardType, points, cardSource);
  if (existing) {
    existing.count += qty;
    if (subscriptionPeriodId) existing.subscriptionPeriodId = subscriptionPeriodId;
  } else {
    store.cardInventory.push({
      cardType,
      pointsValue: points,
      count: qty,
      source: cardSource,
      subscriptionPeriodId: subscriptionPeriodId || null,
    });
  }
  store.cards = (store.cards || 0) + qty;
  store.markModified("cardInventory");
  await store.save(opts);
  return store;
}

/**
 * Consume one digital card (subscription first, then independent) and return its reward points.
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
  const entryIdx = findConsumptionEntryIndex(store.cardInventory);
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
    source: normalizeCardSource(entry.source),
    subscriptionPeriodId: entry.subscriptionPeriodId || null,
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
async function restoreStoreCard(
  storeId,
  { cardType = null, pointsValue, source = CARD_SOURCES.INDEPENDENT, subscriptionPeriodId = null },
  session,
) {
  if (!pointsValue || pointsValue <= 0) return null;

  const cardSource = normalizeCardSource(source);
  const opts = session ? { session, new: true } : { new: true };
  const store = await Store.findById(storeId).setOptions(session ? { session } : {});
  if (!store) return null;

  store.cardInventory = store.cardInventory || [];
  const existing = findInventoryEntry(store.cardInventory, cardType, pointsValue, cardSource);
  if (existing) {
    existing.count += 1;
    if (subscriptionPeriodId) existing.subscriptionPeriodId = subscriptionPeriodId;
  } else {
    store.cardInventory.push({
      cardType,
      pointsValue,
      count: 1,
      source: cardSource,
      subscriptionPeriodId: subscriptionPeriodId || null,
    });
  }
  store.cards = (store.cards || 0) + 1;
  store.markModified("cardInventory");

  return Store.findByIdAndUpdate(
    store._id,
    { $set: { cards: store.cards, cardInventory: store.cardInventory } },
    opts
  );
}

/**
 * Remove remaining subscription digital cards for a store/period.
 */
async function removeSubscriptionDigitalCards(storeId, subscriptionPeriodId, session) {
  const opts = session ? { session } : {};
  const store = await Store.findById(storeId).setOptions(opts);
  if (!store) return { removed: 0 };

  const periodIdStr = subscriptionPeriodId ? String(subscriptionPeriodId) : null;
  let removed = 0;
  store.cardInventory = (store.cardInventory || []).flatMap((entry) => {
    const isSubscription = normalizeCardSource(entry.source) === CARD_SOURCES.SUBSCRIPTION;
    const matchesPeriod = !periodIdStr
      || !entry.subscriptionPeriodId
      || String(entry.subscriptionPeriodId) === periodIdStr;
    if (isSubscription && matchesPeriod && entry.count > 0) {
      removed += entry.count;
      return [];
    }
    return [entry];
  });

  if (removed > 0) {
    store.cards = Math.max(0, (store.cards || 0) - removed);
    store.markModified("cardInventory");
    await store.save(opts);
  }

  return { removed };
}

/**
 * Delete unused subscription paper promo codes for a period.
 */
async function removeSubscriptionPaperCodes(storeId, subscriptionPeriodId, session) {
  const opts = session ? { session } : {};
  const query = {
    store: storeId,
    cardSource: CARD_SOURCES.SUBSCRIPTION,
    currentUses: 0,
  };
  if (subscriptionPeriodId) query.subscriptionPeriodId = subscriptionPeriodId;

  const result = await PromoCode.deleteMany(query).setOptions(opts);
  return { removed: result.deletedCount || 0 };
}

module.exports = {
  addCardsToStore,
  consumeStoreCard,
  restoreStoreCard,
  resolvePointsFromHistory,
  ensureLegacyInventory,
  inventoryKey,
  findInventoryEntry,
  findConsumptionEntryIndex,
  normalizeCardSource,
  removeSubscriptionDigitalCards,
  removeSubscriptionPaperCodes,
};
