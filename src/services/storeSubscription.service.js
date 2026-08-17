const Store = require("../models/store");
const StoreSubscriptionPeriod = require("../models/storeSubscriptionPeriod");
const PromoCode = require("../models/promoCode");
const storeCardInventoryService = require("./storeCardInventory.service");
const { generatePromoCodeString } = require("../utils/promoCode.util");
const {
  SUBSCRIPTION_STATUSES,
  CLOSED_SUBSCRIPTION_STATUSES,
  OPEN_SUBSCRIPTION_STATUSES,
  CARD_SOURCES,
  DEFAULT_SUBSCRIPTION_CARD_CONFIG,
} = require("../constants/storeSubscription.constants");
const {
  getCurrentMonthKey,
  addMonthsToMonthKey,
} = require("../utils/subscriptionMonth.util");
const { formatMonthLabel } = require("../utils/billingMonth.util");
const { parseSubscriptionPaymentSubmission } = require("../utils/storeSubscriptionPayment.util");
const { safeLog } = require("../utils/logSanitize.util");

function isMongoDuplicateKeyError(err) {
  return err?.code === 11000;
}

function resolveStoreCardConfig(store) {
  const config = store?.subscriptionCardConfig || {};
  return {
    digital: {
      quantity: Number(config.digital?.quantity ?? DEFAULT_SUBSCRIPTION_CARD_CONFIG.digital.quantity),
      pointsPerCard: Number(config.digital?.pointsPerCard ?? DEFAULT_SUBSCRIPTION_CARD_CONFIG.digital.pointsPerCard),
    },
    paper: {
      quantity: Number(config.paper?.quantity ?? DEFAULT_SUBSCRIPTION_CARD_CONFIG.paper.quantity),
      pointsPerCard: Number(config.paper?.pointsPerCard ?? DEFAULT_SUBSCRIPTION_CARD_CONFIG.paper.pointsPerCard),
    },
  };
}

const CLOSED_SET = new Set(CLOSED_SUBSCRIPTION_STATUSES);

function isOperationalStatus(status) {
  return status === SUBSCRIPTION_STATUSES.COUNTING
    || status === SUBSCRIPTION_STATUSES.ACTIVE
    || status === SUBSCRIPTION_STATUSES.EXEMPTED
    || status === SUBSCRIPTION_STATUSES.PAYMENT_PENDING;
}

function blocksStoreAccess(status) {
  return status === SUBSCRIPTION_STATUSES.AWAITING_PAYMENT
    || status === SUBSCRIPTION_STATUSES.PAYMENT_REJECTED;
}

function needsSubscriptionPayment(status) {
  return status === SUBSCRIPTION_STATUSES.AWAITING_PAYMENT
    || status === SUBSCRIPTION_STATUSES.PAYMENT_REJECTED;
}

async function getCurrentPeriod(storeId, monthKey = getCurrentMonthKey()) {
  return StoreSubscriptionPeriod.findOne({ store: storeId, monthKey }).lean();
}

async function findActiveCountingPeriod(storeId) {
  return StoreSubscriptionPeriod.findOne({
    store: storeId,
    status: SUBSCRIPTION_STATUSES.COUNTING,
    expiredAt: null,
  }).sort({ monthKey: -1 });
}

async function findOldestOpenSubscriptionPeriod(storeId) {
  return StoreSubscriptionPeriod.findOne({
    store: storeId,
    status: { $in: OPEN_SUBSCRIPTION_STATUSES },
    expiredAt: null,
  }).sort({ monthKey: 1 }).lean();
}

async function findEligibleStoresForSubscriptionRequest() {
  return Store.find({ isActive: true })
    .select("_id name subscriptionCardConfig")
    .sort({ name: 1 })
    .lean();
}

async function resolveCycleMonthKeyForStore(storeId, date = new Date()) {
  const counting = await findActiveCountingPeriod(storeId);
  if (counting) return counting.monthKey;

  const latestClosed = await StoreSubscriptionPeriod.findOne({
    store: storeId,
    status: { $in: CLOSED_SUBSCRIPTION_STATUSES },
    expiredAt: null,
  }).sort({ monthKey: -1 }).lean();

  if (latestClosed) {
    return addMonthsToMonthKey(latestClosed.monthKey, 1);
  }

  return getCurrentMonthKey(date);
}

async function reactivateCountingPeriod(periodDoc, store) {
  const period = periodDoc?.save ? periodDoc : await StoreSubscriptionPeriod.findById(periodDoc?._id || periodDoc);
  if (!period) return null;

  period.status = SUBSCRIPTION_STATUSES.COUNTING;
  period.expiredAt = null;
  period.cardConfig = resolveStoreCardConfig(store);
  period.paymentMethod = undefined;
  period.transferInformation = {};
  period.paymentProof = "";
  period.paymentProofImage = "";
  period.rejectionReason = "";
  period.reviewedBy = null;
  period.reviewedAt = null;
  period.exemptedBy = null;
  period.exemptedAt = null;
  period.digitalCardsIssued = 0;
  period.paperCardsIssued = 0;
  period.paperCodeIds = [];
  period.cardsIssuedAt = null;
  await period.save();
  return period;
}

async function findOrCreateCountingPeriod(storeId, monthKey, storeDoc = null) {
  const store = storeDoc || await Store.findById(storeId).select("subscriptionCardConfig").lean();
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  const existing = await StoreSubscriptionPeriod.findOne({ store: storeId, monthKey });
  if (existing?.status === SUBSCRIPTION_STATUSES.COUNTING && !existing.expiredAt) {
    return existing;
  }
  if (existing) {
    return existing;
  }

  const cardConfig = resolveStoreCardConfig(store);
  try {
    return await StoreSubscriptionPeriod.create({
      store: storeId,
      monthKey,
      status: SUBSCRIPTION_STATUSES.COUNTING,
      cardConfig,
    });
  } catch (err) {
    if (!isMongoDuplicateKeyError(err)) throw err;
    safeLog("info", "store_subscription_period_race_resolved", {
      storeId: String(storeId),
      monthKey,
      phase: "counting_create",
    });
    const period = await StoreSubscriptionPeriod.findOne({ store: storeId, monthKey });
    if (!period) {
      const retryErr = new Error("فشل إنشاء فترة الاشتراك");
      retryErr.status = 500;
      throw retryErr;
    }
    return period;
  }
}

async function ensureCountingPeriodForRequest(storeId) {
  const activeCounting = await findActiveCountingPeriod(storeId);
  if (activeCounting) return activeCounting;

  let monthKey = await resolveCycleMonthKeyForStore(storeId);
  const store = await Store.findById(storeId).select("subscriptionCardConfig").lean();
  if (!store) return null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const period = await findOrCreateCountingPeriod(storeId, monthKey, store);
    if (!period) return null;

    if (period.status === SUBSCRIPTION_STATUSES.COUNTING && !period.expiredAt) {
      return period;
    }

    if (period.expiredAt) {
      return reactivateCountingPeriod(period, store);
    }

    if (CLOSED_SET.has(period.status)) {
      monthKey = addMonthsToMonthKey(monthKey, 1);
      continue;
    }

    return null;
  }

  return null;
}

async function ensureActiveCountingPeriod(storeId) {
  return ensureCountingPeriodForRequest(storeId);
}

async function startNewCountingCycleAfterClose(storeId, closedMonthKey) {
  const targetMonthKey = addMonthsToMonthKey(closedMonthKey || getCurrentMonthKey(), 1);
  const existing = await StoreSubscriptionPeriod.findOne({
    store: storeId,
    monthKey: targetMonthKey,
  });

  if (existing?.status === SUBSCRIPTION_STATUSES.COUNTING && !existing.expiredAt) {
    return existing;
  }

  if (existing?.expiredAt) {
    const store = await Store.findById(storeId).select("subscriptionCardConfig").lean();
    return reactivateCountingPeriod(existing, store);
  }

  if (existing && CLOSED_SET.has(existing.status)) {
    return findOrCreateCountingPeriod(storeId, addMonthsToMonthKey(targetMonthKey, 1));
  }

  if (existing) return existing;
  return findOrCreateCountingPeriod(storeId, targetMonthKey);
}

async function resolveAdminListMonthKey(monthKey) {
  if (monthKey) return monthKey;

  const openPeriod = await StoreSubscriptionPeriod.findOne({
    status: { $in: OPEN_SUBSCRIPTION_STATUSES },
    expiredAt: null,
  }).sort({ monthKey: -1 }).lean();
  if (openPeriod) return openPeriod.monthKey;

  const countingPeriod = await StoreSubscriptionPeriod.findOne({
    status: SUBSCRIPTION_STATUSES.COUNTING,
    expiredAt: null,
  }).sort({ monthKey: -1 }).lean();
  if (countingPeriod) return countingPeriod.monthKey;

  return getCurrentMonthKey();
}

async function getStoreSubscriptionStatus(storeId, date = new Date()) {
  const store = await Store.findById(storeId).select("subscriptionActive subscriptionCardConfig name").lean();
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  const [countingPeriod, openPeriod] = await Promise.all([
    findActiveCountingPeriod(storeId).then((p) => (p ? p.toObject?.() || p : null)),
    findOldestOpenSubscriptionPeriod(storeId),
  ]);

  const currentMonthKey = openPeriod?.monthKey
    || countingPeriod?.monthKey
    || getCurrentMonthKey(date);
  const period = openPeriod || countingPeriod || await getCurrentPeriod(storeId, currentMonthKey);
  const status = period?.status || null;
  const paymentPending = status === SUBSCRIPTION_STATUSES.PAYMENT_PENDING;
  const paymentRejected = status === SUBSCRIPTION_STATUSES.PAYMENT_REJECTED;
  const awaitingPayment = status === SUBSCRIPTION_STATUSES.AWAITING_PAYMENT;
  const needsPayment = Boolean(openPeriod && needsSubscriptionPayment(openPeriod.status));

  return {
    storeId,
    storeName: store.name,
    monthKey: period?.monthKey || currentMonthKey,
    monthLabel: formatMonthLabel(period?.monthKey || currentMonthKey),
    currentCycleMonthKey: countingPeriod?.monthKey || openPeriod?.monthKey || currentMonthKey,
    subscriptionActive: store.subscriptionActive !== false,
    status,
    period,
    cardConfig: period?.cardConfig || resolveStoreCardConfig(store),
    awaitingPayment,
    paymentPending,
    paymentRejected,
    needsPayment,
    canOperate: store.subscriptionActive !== false && !needsPayment,
    cardsIssued: Boolean(period?.cardsIssuedAt),
  };
}

async function setStoreCardQuantities(storeId, body = {}) {
  const store = await Store.findById(storeId);
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  if (!store.subscriptionCardConfig) store.subscriptionCardConfig = {};

  if (body.digital) {
    if (body.digital.quantity !== undefined) {
      store.subscriptionCardConfig.digital = store.subscriptionCardConfig.digital || {};
      store.subscriptionCardConfig.digital.quantity = Math.max(0, Number(body.digital.quantity) || 0);
    }
    if (body.digital.pointsPerCard !== undefined) {
      store.subscriptionCardConfig.digital = store.subscriptionCardConfig.digital || {};
      store.subscriptionCardConfig.digital.pointsPerCard = Math.max(1, Number(body.digital.pointsPerCard) || 1);
    }
  }

  if (body.paper) {
    if (body.paper.quantity !== undefined) {
      store.subscriptionCardConfig.paper = store.subscriptionCardConfig.paper || {};
      store.subscriptionCardConfig.paper.quantity = Math.max(0, Number(body.paper.quantity) || 0);
    }
    if (body.paper.pointsPerCard !== undefined) {
      store.subscriptionCardConfig.paper = store.subscriptionCardConfig.paper || {};
      store.subscriptionCardConfig.paper.pointsPerCard = Math.max(1, Number(body.paper.pointsPerCard) || 1);
    }
  }

  store.markModified("subscriptionCardConfig");
  await store.save();
  return resolveStoreCardConfig(store);
}

async function findOrCreateStoreSubscriptionPeriod(storeId, monthKey, insertFields) {
  let period = await StoreSubscriptionPeriod.findOne({ store: storeId, monthKey });
  if (period) return period;

  try {
    period = await StoreSubscriptionPeriod.create({
      store: storeId,
      monthKey,
      ...insertFields,
    });
    return period;
  } catch (err) {
    if (!isMongoDuplicateKeyError(err)) throw err;
    safeLog("info", "store_subscription_period_race_resolved", {
      storeId: String(storeId),
      monthKey,
    });
    period = await StoreSubscriptionPeriod.findOne({ store: storeId, monthKey });
    if (!period) {
      const retryErr = new Error("فشل إنشاء فترة الاشتراك");
      retryErr.status = 500;
      safeLog("error", "store_subscription_period_create_failed", {
        storeId: String(storeId),
        monthKey,
      });
      throw retryErr;
    }
    return period;
  }
}

async function ensurePeriodForPayment(store, periodDoc) {
  const period = periodDoc?.save ? periodDoc : await StoreSubscriptionPeriod.findById(periodDoc?._id || periodDoc);
  if (!period) {
    const err = new Error("فترة الاشتراك غير موجودة");
    err.status = 404;
    throw err;
  }

  if (period.status === SUBSCRIPTION_STATUSES.ACTIVE || period.status === SUBSCRIPTION_STATUSES.EXEMPTED) {
    const err = new Error("الاشتراك الشهري مفعّل بالفعل");
    err.status = 400;
    throw err;
  }

  if (period.status === SUBSCRIPTION_STATUSES.PAYMENT_PENDING) {
    const err = new Error("الدفع قيد المراجعة بالفعل");
    err.status = 400;
    throw err;
  }

  if (![SUBSCRIPTION_STATUSES.AWAITING_PAYMENT, SUBSCRIPTION_STATUSES.PAYMENT_REJECTED].includes(period.status)) {
    const err = new Error("لا توجد مطالبة دفع مفتوحة للاشتراك");
    err.status = 400;
    throw err;
  }

  return period;
}

async function submitSubscriptionPayment(storeId, body = {}) {
  const store = await Store.findById(storeId);
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  const openPeriod = await findOldestOpenSubscriptionPeriod(storeId);
  if (!openPeriod) {
    const err = new Error("لا توجد مطالبة دفع مفتوحة للاشتراك");
    err.status = 400;
    throw err;
  }

  const payment = await parseSubscriptionPaymentSubmission(body);
  const period = await ensurePeriodForPayment(store, openPeriod);

  period.status = SUBSCRIPTION_STATUSES.PAYMENT_PENDING;
  period.paymentMethod = payment.paymentMethod;
  period.transferInformation = payment.transferInformation;
  period.paymentProof = payment.paymentProof;
  period.paymentProofImage = payment.paymentProofImage;
  period.rejectionReason = "";
  period.reviewedBy = null;
  period.reviewedAt = null;
  await period.save();

  return getStoreSubscriptionStatus(storeId);
}

async function issueSubscriptionCards(period, adminId = null) {
  if (period.cardsIssuedAt) return period;

  const store = await Store.findById(period.store);
  if (!store?.codePrefix) {
    const err = new Error("المتجر لا يملك بصمة أكواد");
    err.status = 400;
    throw err;
  }

  const cardConfig = period.cardConfig || resolveStoreCardConfig(store);
  const digitalQty = Number(cardConfig.digital?.quantity || 0);
  const paperQty = Number(cardConfig.paper?.quantity || 0);
  const digitalPoints = Number(cardConfig.digital?.pointsPerCard || 1);
  const paperPoints = Number(cardConfig.paper?.pointsPerCard || 1);

  if (digitalQty > 0) {
    await storeCardInventoryService.addCardsToStore(period.store, {
      cardType: null,
      pointsValue: digitalPoints,
      quantity: digitalQty,
      source: CARD_SOURCES.SUBSCRIPTION,
      subscriptionPeriodId: period._id,
    });
  }

  let paperCodeIds = [];
  if (paperQty > 0) {
    const paperPayload = Array.from({ length: paperQty }, () => ({
      code: generatePromoCodeString(store.codePrefix),
      rewardPoints: paperPoints,
      rewardEntries: 1,
      store: period.store,
      createdBy: adminId || undefined,
      cardSource: CARD_SOURCES.SUBSCRIPTION,
      subscriptionPeriodId: period._id,
    }));
    const created = await PromoCode.insertMany(paperPayload);
    paperCodeIds = created.map((row) => row._id);
  }

  period.digitalCardsIssued = digitalQty;
  period.paperCardsIssued = paperQty;
  period.paperCodeIds = paperCodeIds;
  period.cardsIssuedAt = new Date();
  await period.save();
  return period;
}

async function approveSubscriptionPayment(periodId, adminId) {
  const period = await StoreSubscriptionPeriod.findById(periodId);
  if (!period) {
    const err = new Error("فترة الاشتراك غير موجودة");
    err.status = 404;
    throw err;
  }
  if (period.status !== SUBSCRIPTION_STATUSES.PAYMENT_PENDING) {
    const err = new Error("لا يمكن اعتماد هذه الفترة");
    err.status = 400;
    throw err;
  }

  period.status = SUBSCRIPTION_STATUSES.ACTIVE;
  period.reviewedBy = adminId;
  period.reviewedAt = new Date();
  period.rejectionReason = "";
  await period.save();

  await issueSubscriptionCards(period, adminId);

  const store = await Store.findById(period.store);
  if (store && store.subscriptionActive === false) {
    store.subscriptionActive = true;
    await store.save();
  }

  await startNewCountingCycleAfterClose(period.store, period.monthKey);

  return period;
}

async function rejectSubscriptionPayment(periodId, adminId, reason = "") {
  const period = await StoreSubscriptionPeriod.findById(periodId);
  if (!period) {
    const err = new Error("فترة الاشتراك غير موجودة");
    err.status = 404;
    throw err;
  }
  if (period.status !== SUBSCRIPTION_STATUSES.PAYMENT_PENDING) {
    const err = new Error("لا يمكن رفض هذه الفترة");
    err.status = 400;
    throw err;
  }

  period.status = SUBSCRIPTION_STATUSES.PAYMENT_REJECTED;
  period.reviewedBy = adminId;
  period.reviewedAt = new Date();
  period.rejectionReason = String(reason || "بيانات الدفع غير صالحة").trim();
  await period.save();
  return period;
}

async function exemptStoreForMonth(storeId, adminId, monthKey = null) {
  const store = await Store.findById(storeId);
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  let periodDoc = null;
  if (monthKey) {
    periodDoc = await StoreSubscriptionPeriod.findOne({ store: storeId, monthKey });
  } else {
    const openPeriod = await findOldestOpenSubscriptionPeriod(storeId);
    if (openPeriod) {
      periodDoc = await StoreSubscriptionPeriod.findById(openPeriod._id);
      monthKey = openPeriod.monthKey;
    } else {
      const counting = await findActiveCountingPeriod(storeId);
      monthKey = counting?.monthKey || getCurrentMonthKey();
      if (counting) periodDoc = counting;
    }
  }

  const cardConfig = periodDoc?.cardConfig || resolveStoreCardConfig(store);
  let period = periodDoc;

  if (!period) {
    period = await findOrCreateStoreSubscriptionPeriod(storeId, monthKey, {
      status: SUBSCRIPTION_STATUSES.EXEMPTED,
      cardConfig,
      exemptedBy: adminId,
      exemptedAt: new Date(),
    });
  } else {
    period.status = SUBSCRIPTION_STATUSES.EXEMPTED;
    period.exemptedBy = adminId;
    period.exemptedAt = new Date();
    period.rejectionReason = "";
    if (!period.cardConfig?.digital?.quantity && !period.cardConfig?.paper?.quantity) {
      period.cardConfig = cardConfig;
    }
    await period.save();
  }

  await issueSubscriptionCards(period, adminId);

  if (store.subscriptionActive === false) {
    store.subscriptionActive = true;
    await store.save();
  }

  await startNewCountingCycleAfterClose(storeId, period.monthKey);

  return period;
}

async function exemptAllExcept(storeIdsToKeep = [], adminId, monthKey = null) {
  const resolvedMonthKey = await resolveAdminListMonthKey(monthKey);
  const keepSet = new Set((storeIdsToKeep || []).map(String));
  const stores = await Store.find({ isActive: true }).select("_id").lean();
  const results = [];

  for (const store of stores) {
    if (keepSet.has(String(store._id))) continue;
    const period = await exemptStoreForMonth(store._id, adminId, resolvedMonthKey);
    results.push({ storeId: store._id, periodId: period._id, status: period.status });
  }

  return { monthKey: resolvedMonthKey, exemptedCount: results.length, results };
}

async function expireSubscriptionPeriod(period) {
  if (!period || period.expiredAt) return period;

  await storeCardInventoryService.removeSubscriptionDigitalCards(
    period.store,
    period._id,
  );
  await storeCardInventoryService.removeSubscriptionPaperCodes(
    period.store,
    period._id,
  );

  period.expiredAt = new Date();
  await period.save();
  return period;
}

async function expireEndedSubscriptionPeriods() {
  const completedPeriods = await StoreSubscriptionPeriod.find({
    status: { $in: CLOSED_SUBSCRIPTION_STATUSES },
    expiredAt: null,
    cardsIssuedAt: { $ne: null },
  }).select("_id store monthKey");

  const expired = [];
  for (const period of completedPeriods) {
    const newerPeriod = await StoreSubscriptionPeriod.findOne({
      store: period.store,
      monthKey: { $gt: period.monthKey },
      expiredAt: null,
    }).select("_id").lean();

    if (newerPeriod) {
      await expireSubscriptionPeriod(await StoreSubscriptionPeriod.findById(period._id));
      expired.push(period._id);
    }
  }
  return expired;
}

async function listAdminSubscriptionCards(monthKey) {
  const resolvedMonthKey = await resolveAdminListMonthKey(monthKey);
  const stores = await Store.find({ isActive: true })
    .select("name phone whatsapp owner subscriptionCardConfig subscriptionActive")
    .populate("owner", "name email phone")
    .sort({ name: 1 })
    .lean();

  const periods = await StoreSubscriptionPeriod.find({ monthKey: resolvedMonthKey })
    .lean();
  const periodByStore = new Map(periods.map((p) => [String(p.store), p]));

  return {
    monthKey: resolvedMonthKey,
    cards: stores.map((store) => {
      const period = periodByStore.get(String(store._id)) || null;
      return {
        store,
        period,
        cardConfig: period?.cardConfig || resolveStoreCardConfig(store),
        status: period?.status || null,
      };
    }),
  };
}

function resolvePeriodStoreId(period) {
  const store = period?.store;
  if (!store) return null;
  return store._id || store;
}

async function findSubscriptionPaperPromoCodes(period) {
  const storeId = resolvePeriodStoreId(period);
  const linkedIds = (period.paperCodeIds || [])
    .map((id) => (id?._id ? id._id : id))
    .filter(Boolean);

  let codes = [];
  if (linkedIds.length) {
    codes = await PromoCode.find({ _id: { $in: linkedIds } })
      .select("code cardSource subscriptionPeriodId rewardPoints")
      .lean();
  }

  const usedFallback = codes.length === 0
    && (linkedIds.length > 0 || Number(period.paperCardsIssued) > 0);

  if (usedFallback && storeId) {
    codes = await PromoCode.find({
      store: storeId,
      subscriptionPeriodId: period._id,
      cardSource: CARD_SOURCES.SUBSCRIPTION,
    })
      .select("code cardSource subscriptionPeriodId rewardPoints")
      .sort({ createdAt: 1 })
      .lean();
  }

  return { codes, usedFallback };
}

async function getSubscriptionPaperCodesForExport(periodId) {
  const period = await StoreSubscriptionPeriod.findById(periodId)
    .populate("store", "name")
    .lean();
  if (!period) {
    const err = new Error("فترة الاشتراك غير موجودة");
    err.status = 404;
    throw err;
  }
  if (![SUBSCRIPTION_STATUSES.ACTIVE, SUBSCRIPTION_STATUSES.EXEMPTED].includes(period.status)) {
    const err = new Error("لا يمكن تصدير الكروت قبل اعتماد الدفع أو الإعفاء");
    err.status = 400;
    throw err;
  }
  if (!period.paperCodeIds?.length && !(period.paperCardsIssued > 0)) {
    const err = new Error("لا توجد كروت ورقية مُصدَّرة لهذه الفترة");
    err.status = 400;
    throw err;
  }

  const { codes, usedFallback } = await findSubscriptionPaperPromoCodes(period);

  if (!codes.length) {
    const err = new Error("لا توجد أكواد ورقية محفوظة لهذه الفترة في قاعدة البيانات");
    err.status = 404;
    throw err;
  }

  if (usedFallback) {
    await StoreSubscriptionPeriod.updateOne(
      { _id: period._id },
      { $set: { paperCodeIds: codes.map((row) => row._id) } },
    );
  }

  return {
    storeName: period.store?.name || "",
    codes: codes.map((row) => ({
      code: row.code,
      source: CARD_SOURCES.SUBSCRIPTION,
      rewardPoints: row.rewardPoints,
    })),
  };
}

function serializeSubscriptionPeriod(period) {
  if (!period) return null;
  const row = period.toObject?.() || period;
  return {
    _id: row._id,
    store: row.store,
    monthKey: row.monthKey,
    status: row.status,
    cardConfig: row.cardConfig,
    paymentMethod: row.paymentMethod,
    rejectionReason: row.rejectionReason,
    cardsIssuedAt: row.cardsIssuedAt,
  };
}

async function requestSubscriptionForStore(storeId) {
  const openBill = await findOldestOpenSubscriptionPeriod(storeId);
  if (openBill) {
    return {
      storeId,
      alreadyRequested: true,
      monthKey: openBill.monthKey,
      status: openBill.status,
      cardConfig: openBill.cardConfig,
      openPeriod: serializeSubscriptionPeriod(openBill),
    };
  }

  const countingPeriod = await ensureCountingPeriodForRequest(storeId);
  if (!countingPeriod || countingPeriod.status !== SUBSCRIPTION_STATUSES.COUNTING) {
    return { storeId, skipped: true, reason: "no_counting_period" };
  }

  const store = await Store.findById(storeId).select("subscriptionCardConfig").lean();
  const cardConfig = resolveStoreCardConfig(store);
  const finalized = await StoreSubscriptionPeriod.findOneAndUpdate(
    {
      _id: countingPeriod._id,
      status: SUBSCRIPTION_STATUSES.COUNTING,
    },
    {
      $set: {
        status: SUBSCRIPTION_STATUSES.AWAITING_PAYMENT,
        cardConfig,
      },
    },
    { new: true },
  );

  if (!finalized) {
    const concurrentOpen = await findOldestOpenSubscriptionPeriod(storeId);
    if (concurrentOpen) {
      return {
        storeId,
        alreadyRequested: true,
        monthKey: concurrentOpen.monthKey,
        status: concurrentOpen.status,
        cardConfig: concurrentOpen.cardConfig,
        openPeriod: serializeSubscriptionPeriod(concurrentOpen),
      };
    }
    return { storeId, skipped: true, reason: "finalize_failed" };
  }

  return {
    storeId,
    finalized: true,
    monthKey: finalized.monthKey,
    status: finalized.status,
    cardConfig: finalized.cardConfig,
    openPeriod: serializeSubscriptionPeriod(finalized),
  };
}

async function requestStoreSubscriptions(adminId) {
  const stores = await findEligibleStoresForSubscriptionRequest();

  const results = [];
  for (const store of stores) {
    const result = await requestSubscriptionForStore(store._id);
    results.push({
      ...result,
      storeName: store.name,
    });
  }

  const finalized = results.filter((row) => row.finalized);
  const alreadyRequested = results.filter((row) => row.alreadyRequested);
  const skipped = results.filter((row) => row.skipped);
  const alreadyExecuted = finalized.length === 0 && alreadyRequested.length > 0;

  const finalizedMonthKeys = [...new Set(
    finalized.map((row) => row.monthKey).concat(alreadyRequested.map((row) => row.monthKey)),
  )].filter(Boolean);

  const storesRequiringPayment = results.filter((row) => (
    row.finalized
    || (row.alreadyRequested && [
      SUBSCRIPTION_STATUSES.AWAITING_PAYMENT,
      SUBSCRIPTION_STATUSES.PAYMENT_REJECTED,
    ].includes(row.status))
  )).length;

  return {
    alreadyExecuted,
    requestedBy: adminId,
    message: alreadyExecuted
      ? "تم طلب اشتراكات المتاجر مسبقاً لهذه الدورة"
      : "تم طلب اشتراكات المتاجر بنجاح",
    finalizedMonths: finalizedMonthKeys,
    storesAffected: finalized.length,
    storesAlreadyRequested: alreadyRequested.length,
    storesSkipped: skipped.length,
    storesRequiringPayment,
    totalStores: stores.length,
    results,
  };
}

function buildSubscriptionCardIssuancePlan(cardConfig = {}) {
  return {
    digitalQty: Number(cardConfig.digital?.quantity || 0),
    paperQty: Number(cardConfig.paper?.quantity || 0),
    digitalPoints: Number(cardConfig.digital?.pointsPerCard || 1),
    paperPoints: Number(cardConfig.paper?.pointsPerCard || 1),
    digitalSource: CARD_SOURCES.SUBSCRIPTION,
    paperSource: CARD_SOURCES.SUBSCRIPTION,
  };
}

module.exports = {
  resolveStoreCardConfig,
  isOperationalStatus,
  blocksStoreAccess,
  needsSubscriptionPayment,
  buildSubscriptionCardIssuancePlan,
  getCurrentPeriod,
  getStoreSubscriptionStatus,
  setStoreCardQuantities,
  submitSubscriptionPayment,
  approveSubscriptionPayment,
  rejectSubscriptionPayment,
  exemptStoreForMonth,
  exemptAllExcept,
  issueSubscriptionCards,
  expireSubscriptionPeriod,
  expireEndedSubscriptionPeriods,
  listAdminSubscriptionCards,
  getSubscriptionPaperCodesForExport,
  findSubscriptionPaperPromoCodes,
  resolvePeriodStoreId,
  findOrCreateStoreSubscriptionPeriod,
  findActiveCountingPeriod,
  findOldestOpenSubscriptionPeriod,
  findOrCreateCountingPeriod,
  ensureCountingPeriodForRequest,
  ensureActiveCountingPeriod,
  resolveCycleMonthKeyForStore,
  findEligibleStoresForSubscriptionRequest,
  reactivateCountingPeriod,
  startNewCountingCycleAfterClose,
  requestSubscriptionForStore,
  requestStoreSubscriptions,
  resolveAdminListMonthKey,
};
