const Store = require("../models/store");
const StoreSubscriptionPeriod = require("../models/storeSubscriptionPeriod");
const PromoCode = require("../models/promoCode");
const storeCardInventoryService = require("./storeCardInventory.service");
const { generatePromoCodeString } = require("../utils/promoCode.util");
const {
  SUBSCRIPTION_STATUSES,
  CARD_SOURCES,
  DEFAULT_SUBSCRIPTION_CARD_CONFIG,
} = require("../constants/storeSubscription.constants");
const {
  getCurrentMonthKey,
  isMonthKeyExpired,
} = require("../utils/subscriptionMonth.util");
const { parseSubscriptionPaymentSubmission } = require("../utils/storeSubscriptionPayment.util");

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

function isOperationalStatus(status) {
  return status === SUBSCRIPTION_STATUSES.ACTIVE
    || status === SUBSCRIPTION_STATUSES.EXEMPTED
    || status === SUBSCRIPTION_STATUSES.PAYMENT_PENDING;
}

function blocksStoreAccess(status) {
  return status === SUBSCRIPTION_STATUSES.PAYMENT_REJECTED;
}

async function getCurrentPeriod(storeId, monthKey = getCurrentMonthKey()) {
  return StoreSubscriptionPeriod.findOne({ store: storeId, monthKey }).lean();
}

async function getStoreSubscriptionStatus(storeId, monthKey = getCurrentMonthKey()) {
  const store = await Store.findById(storeId).select("subscriptionActive subscriptionCardConfig name").lean();
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  const period = await getCurrentPeriod(storeId, monthKey);
  return {
    storeId,
    storeName: store.name,
    monthKey,
    subscriptionActive: store.subscriptionActive !== false,
    status: period?.status || null,
    period,
    cardConfig: resolveStoreCardConfig(store),
    paymentPending: period?.status === SUBSCRIPTION_STATUSES.PAYMENT_PENDING,
    paymentRejected: period?.status === SUBSCRIPTION_STATUSES.PAYMENT_REJECTED,
    canOperate: store.subscriptionActive !== false
      && (!period?.status || !blocksStoreAccess(period.status)),
    needsPayment: !period
      || period.status === SUBSCRIPTION_STATUSES.PAYMENT_REJECTED
      || (!isOperationalStatus(period.status) && period.status !== SUBSCRIPTION_STATUSES.PAYMENT_PENDING),
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

async function ensurePeriodForPayment(store, monthKey = getCurrentMonthKey()) {
  let period = await StoreSubscriptionPeriod.findOne({ store: store._id, monthKey });
  const cardConfig = resolveStoreCardConfig(store);

  if (!period) {
    period = await StoreSubscriptionPeriod.create({
      store: store._id,
      monthKey,
      status: SUBSCRIPTION_STATUSES.PAYMENT_PENDING,
      cardConfig,
    });
    return period;
  }

  if (period.status === SUBSCRIPTION_STATUSES.ACTIVE || period.status === SUBSCRIPTION_STATUSES.EXEMPTED) {
    const err = new Error("الاشتراك الشهري مفعّل بالفعل");
    err.status = 400;
    throw err;
  }

  period.cardConfig = cardConfig;
  return period;
}

async function submitSubscriptionPayment(storeId, body = {}) {
  const store = await Store.findById(storeId);
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  const monthKey = getCurrentMonthKey();
  const payment = await parseSubscriptionPaymentSubmission(body);
  const period = await ensurePeriodForPayment(store, monthKey);

  period.status = SUBSCRIPTION_STATUSES.PAYMENT_PENDING;
  period.paymentMethod = payment.paymentMethod;
  period.transferInformation = payment.transferInformation;
  period.paymentProof = payment.paymentProof;
  period.paymentProofImage = payment.paymentProofImage;
  period.rejectionReason = "";
  period.reviewedBy = null;
  period.reviewedAt = null;
  await period.save();

  return getStoreSubscriptionStatus(storeId, monthKey);
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

async function exemptStoreForMonth(storeId, adminId, monthKey = getCurrentMonthKey()) {
  const store = await Store.findById(storeId);
  if (!store) {
    const err = new Error("المتجر غير موجود");
    err.status = 404;
    throw err;
  }

  let period = await StoreSubscriptionPeriod.findOne({ store: storeId, monthKey });
  const cardConfig = resolveStoreCardConfig(store);

  if (!period) {
    period = await StoreSubscriptionPeriod.create({
      store: storeId,
      monthKey,
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
    period.cardConfig = cardConfig;
    await period.save();
  }

  await issueSubscriptionCards(period, adminId);

  if (store.subscriptionActive === false) {
    store.subscriptionActive = true;
    await store.save();
  }

  return period;
}

async function exemptAllExcept(storeIdsToKeep = [], adminId, monthKey = getCurrentMonthKey()) {
  const keepSet = new Set((storeIdsToKeep || []).map(String));
  const stores = await Store.find({ isActive: true }).select("_id").lean();
  const results = [];

  for (const store of stores) {
    if (keepSet.has(String(store._id))) continue;
    const period = await exemptStoreForMonth(store._id, adminId, monthKey);
    results.push({ storeId: store._id, periodId: period._id, status: period.status });
  }

  return { monthKey, exemptedCount: results.length, results };
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

async function expireEndedSubscriptionPeriods(date = new Date()) {
  const currentMonthKey = getCurrentMonthKey(date);
  const stalePeriods = await StoreSubscriptionPeriod.find({
    monthKey: { $ne: currentMonthKey },
    expiredAt: null,
  }).select("_id store monthKey");

  const expired = [];
  for (const period of stalePeriods) {
    if (isMonthKeyExpired(period.monthKey, date)) {
      await expireSubscriptionPeriod(await StoreSubscriptionPeriod.findById(period._id));
      expired.push(period._id);
    }
  }
  return expired;
}

async function listAdminSubscriptionCards(monthKey = getCurrentMonthKey()) {
  const stores = await Store.find({ isActive: true })
    .select("name phone whatsapp owner subscriptionCardConfig subscriptionActive")
    .populate("owner", "name email phone")
    .sort({ name: 1 })
    .lean();

  const periods = await StoreSubscriptionPeriod.find({ monthKey })
    .lean();
  const periodByStore = new Map(periods.map((p) => [String(p.store), p]));

  return stores.map((store) => {
    const period = periodByStore.get(String(store._id)) || null;
    return {
      store,
      period,
      cardConfig: resolveStoreCardConfig(store),
      status: period?.status || null,
    };
  });
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
  if (!period.paperCodeIds?.length) {
    const err = new Error("لا توجد أكواد ورقية لهذه الفترة — تأكد من إصدار الكروت بعد الاعتماد");
    err.status = 400;
    throw err;
  }

  const codes = await PromoCode.find({
    _id: { $in: period.paperCodeIds },
  }).select("code cardSource subscriptionPeriodId").lean();

  if (!codes.length) {
    const err = new Error("تعذّر العثور على أكواد الكروت الورقية في قاعدة البيانات");
    err.status = 404;
    throw err;
  }

  return {
    storeName: period.store?.name || "",
    codes: codes.map((row) => ({
      code: row.code,
      source: CARD_SOURCES.SUBSCRIPTION,
    })),
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
};
