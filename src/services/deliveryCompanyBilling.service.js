const mongoose = require("mongoose");
const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyBillingPeriod = require("../models/deliveryCompanyBillingPeriod");
const DeliveryCompanyOrderHandover = require("../models/deliveryCompanyOrderHandover");
const {
  BILLING_STATUSES,
  DEFAULT_PRICE_PER_ORDER,
  CLOSED_BILLING_STATUSES,
  OPEN_BILLING_STATUSES,
} = require("../constants/deliveryBilling.constants");
const {
  getCurrentMonthKey,
  getPreviousMonthKey,
  addMonthsToMonthKey,
} = require("../utils/subscriptionMonth.util");
const { getMonthBounds, formatMonthLabel } = require("../utils/billingMonth.util");
const { parseSubscriptionPaymentSubmission, serializePaymentForOwner } = require("../utils/storeSubscriptionPayment.util");
const billingNotification = require("./deliveryCompanyBillingNotification.service");
const { getPaymentTypeLabel } = require("../utils/paymentMethodTypes.util");
const { safeLog } = require("../utils/logSanitize.util");

const CLOSED_SET = new Set(CLOSED_BILLING_STATUSES);
const BILLING_INCREMENT_MAX_ATTEMPTS = 3;

function isMongoDuplicateKeyError(err) {
  return err?.code === 11000;
}

function computeAmountDue(count, pricePerOrder) {
  return Math.max(0, Number(count || 0) * Number(pricePerOrder || 0));
}

async function getCompanyBillingConfig(companyId) {
  const company = await DeliveryCompany.findById(companyId)
    .select("pricePerDeliveredOrder currency name isActive")
    .lean();
  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }
  return {
    company,
    pricePerOrder: Number(company.pricePerDeliveredOrder ?? DEFAULT_PRICE_PER_ORDER),
    currency: company.currency || "ILS",
  };
}

async function countHandoversInMonth(companyId, monthKey) {
  const { start, end } = getMonthBounds(monthKey);
  return DeliveryCompanyOrderHandover.countDocuments({
    deliveryCompany: companyId,
    handoverAt: { $gte: start, $lt: end },
  });
}

async function findBillingPeriod(companyId, monthKey, session = null) {
  return DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    monthKey,
  }).session(session || null);
}

/**
 * Atomically get or create the single billing-period document for company+monthKey.
 * Safe under concurrent handover increments (unique index on deliveryCompany+monthKey).
 */
async function findOrCreateCountingPeriod(companyId, monthKey, session = null) {
  const existing = await findBillingPeriod(companyId, monthKey, session);
  if (existing) return existing;

  const { pricePerOrder, currency } = await getCompanyBillingConfig(companyId);
  const opts = {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
    ...(session ? { session } : {}),
  };

  try {
    const created = await DeliveryCompanyBillingPeriod.findOneAndUpdate(
      { deliveryCompany: companyId, monthKey },
      {
        $setOnInsert: {
          deliveryCompany: companyId,
          monthKey,
          status: BILLING_STATUSES.COUNTING,
          deliveredOrderCount: 0,
          pricePerOrder,
          amountDue: 0,
          currency,
          closedAt: null,
        },
      },
      opts,
    );
    if (created) return created;
  } catch (err) {
    if (!isMongoDuplicateKeyError(err)) throw err;
    safeLog("info", "delivery_billing_period_race_resolved", {
      companyId: String(companyId),
      monthKey,
    });
  }

  const period = await findBillingPeriod(companyId, monthKey, session);
  if (!period) {
    const err = new Error("فشل إنشاء فترة الفوترة");
    err.status = 500;
    safeLog("error", "delivery_billing_period_create_failed", {
      companyId: String(companyId),
      monthKey,
    });
    throw err;
  }
  return period;
}

async function ensureCountingPeriod(companyId, monthKey, session = null) {
  const existing = await findBillingPeriod(companyId, monthKey, session);
  if (existing) {
    if (existing.status === BILLING_STATUSES.COUNTING) return existing;
    if (!CLOSED_SET.has(existing.status)) return existing;
    return existing;
  }
  return findOrCreateCountingPeriod(companyId, monthKey, session);
}

async function incrementHandoverCount(companyId, handoverAt = new Date()) {
  if (!companyId) return { incremented: false, reason: "no_company" };

  const monthKey = getCurrentMonthKey(handoverAt);

  for (let attempt = 1; attempt <= BILLING_INCREMENT_MAX_ATTEMPTS; attempt += 1) {
    const period = await DeliveryCompanyBillingPeriod.findOne({
      deliveryCompany: companyId,
      monthKey,
    });

    if (period && CLOSED_SET.has(period.status)) {
      return { incremented: false, reason: "period_closed" };
    }

    if (period && period.status !== BILLING_STATUSES.COUNTING) {
      return { incremented: false, reason: "billing_frozen" };
    }

    let countingPeriod = period;
    try {
      countingPeriod = period || await ensureCountingPeriod(companyId, monthKey);
    } catch (err) {
      if (!isMongoDuplicateKeyError(err)) throw err;
      safeLog("info", "delivery_billing_period_race_resolved", {
        companyId: String(companyId),
        monthKey,
        phase: "increment_ensure",
        attempt,
      });
      countingPeriod = await findBillingPeriod(companyId, monthKey);
      if (!countingPeriod) throw err;
    }

    if (CLOSED_SET.has(countingPeriod.status)) {
      return { incremented: false, reason: "period_closed" };
    }
    if (countingPeriod.status !== BILLING_STATUSES.COUNTING) {
      return { incremented: false, reason: "billing_frozen" };
    }

    const result = await DeliveryCompanyBillingPeriod.updateOne(
      { _id: countingPeriod._id, status: BILLING_STATUSES.COUNTING },
      { $inc: { deliveredOrderCount: 1 } },
    );

    if (result.modifiedCount > 0) {
      return {
        incremented: true,
        periodId: countingPeriod._id,
        monthKey,
      };
    }

    if (attempt < BILLING_INCREMENT_MAX_ATTEMPTS) {
      safeLog("warn", "delivery_billing_increment_retry", {
        companyId: String(companyId),
        monthKey,
        periodId: String(countingPeriod._id),
        attempt,
      });
    }
  }

  safeLog("error", "delivery_billing_increment_failed", {
    companyId: String(companyId),
    monthKey,
    attempts: BILLING_INCREMENT_MAX_ATTEMPTS,
  });
  const err = new Error("فشل زيادة عداد الفوترة");
  err.status = 500;
  throw err;
}

async function finalizePeriodForBilling(periodDoc) {
  const period = periodDoc?.save ? periodDoc : await DeliveryCompanyBillingPeriod.findById(periodDoc?._id || periodDoc);
  if (!period || period.status !== BILLING_STATUSES.COUNTING) return period;

  const count = await countHandoversInMonth(period.deliveryCompany, period.monthKey);
  const { pricePerOrder, currency } = await getCompanyBillingConfig(period.deliveryCompany);

  period.deliveredOrderCount = count;
  period.pricePerOrder = pricePerOrder;
  period.currency = currency;
  period.amountDue = computeAmountDue(count, pricePerOrder);
  period.status = BILLING_STATUSES.AWAITING_PAYMENT;
  period.billingFinalizedAt = new Date();
  await period.save();

  await billingNotification.notifyBillingRequired(period.deliveryCompany, period);
  return period;
}

async function closeCountingPeriodsForPastMonths(date = new Date()) {
  const currentMonthKey = getCurrentMonthKey(date);
  const countingPeriods = await DeliveryCompanyBillingPeriod.find({
    status: BILLING_STATUSES.COUNTING,
    monthKey: { $lt: currentMonthKey },
  });

  const finalized = [];
  for (const period of countingPeriods) {
    finalized.push(await finalizePeriodForBilling(period));
  }
  return finalized;
}

async function findOldestOpenBillingPeriod(companyId) {
  return DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    status: { $in: OPEN_BILLING_STATUSES },
    closedAt: null,
  }).sort({ monthKey: 1 });
}

async function startNewCountingCycleAfterClose(companyId, session, closedMonthKey) {
  const currentMonthKey = getCurrentMonthKey();
  const closedKey = closedMonthKey || currentMonthKey;

  // One document per company+monthKey — never insert a second row for a closed month.
  let targetMonthKey = currentMonthKey;
  if (closedKey >= currentMonthKey) {
    targetMonthKey = addMonthsToMonthKey(closedKey, 1);
  }

  const targetExisting = await findBillingPeriod(companyId, targetMonthKey, session);
  if (targetExisting) return targetExisting;

  return findOrCreateCountingPeriod(companyId, targetMonthKey, session);
}

async function completeBillingCycle(periodId, adminId, { outcome }) {
  const allowedByOutcome = {
    paid: [BILLING_STATUSES.PAYMENT_PENDING],
    exempted: OPEN_BILLING_STATUSES,
  };
  const targetStatus = outcome === "paid" ? BILLING_STATUSES.PAID : BILLING_STATUSES.EXEMPTED;
  const allowedStatuses = allowedByOutcome[outcome] || [];

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const updateFields = {
      status: targetStatus,
      closedAt: new Date(),
      rejectionReason: "",
    };
    if (outcome === "paid") {
      updateFields.reviewedBy = adminId;
      updateFields.reviewedAt = new Date();
    } else {
      updateFields.exemptedBy = adminId;
      updateFields.exemptedAt = new Date();
    }

    const period = await DeliveryCompanyBillingPeriod.findOneAndUpdate(
      {
        _id: periodId,
        status: { $in: allowedStatuses },
        closedAt: null,
      },
      { $set: updateFields },
      { new: true, session },
    );

    if (!period) {
      const err = new Error(outcome === "paid" ? "لا يمكن اعتماد هذه الفترة" : "لا يمكن إعفاء هذه الفترة");
      err.status = 400;
      throw err;
    }

    await startNewCountingCycleAfterClose(period.deliveryCompany, session, period.monthKey);
    await session.commitTransaction();

    if (outcome === "paid") {
      await billingNotification.notifyBillingVerified(period.deliveryCompany, period);
    } else {
      await billingNotification.notifyBillingExempted(period.deliveryCompany, period);
    }

    return period;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

async function approveBillingPayment(periodId, adminId) {
  return completeBillingCycle(periodId, adminId, { outcome: "paid" });
}

async function rejectBillingPayment(periodId, adminId, reason = "") {
  const period = await DeliveryCompanyBillingPeriod.findOneAndUpdate(
    {
      _id: periodId,
      status: BILLING_STATUSES.PAYMENT_PENDING,
      closedAt: null,
    },
    {
      $set: {
        status: BILLING_STATUSES.PAYMENT_REJECTED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectionReason: String(reason || "بيانات الدفع غير صالحة").trim(),
      },
    },
    { new: true },
  );

  if (!period) {
    const err = new Error("لا يمكن رفض هذه الفترة");
    err.status = 400;
    throw err;
  }

  await billingNotification.notifyBillingRejected(period.deliveryCompany, period, period.rejectionReason);
  return period;
}

async function exemptBillingPeriod(periodId, adminId) {
  return completeBillingCycle(periodId, adminId, { outcome: "exempted" });
}

async function submitBillingPayment(companyId, body = {}, periodId = null) {
  let period = null;
  if (periodId) {
    period = await DeliveryCompanyBillingPeriod.findOne({
      _id: periodId,
      deliveryCompany: companyId,
      closedAt: null,
    });
  } else {
    period = await findOldestOpenBillingPeriod(companyId);
  }

  if (!period) {
    const err = new Error("لا توجد فاتورة مستحقة للدفع");
    err.status = 400;
    throw err;
  }

  if (![BILLING_STATUSES.AWAITING_PAYMENT, BILLING_STATUSES.PAYMENT_REJECTED].includes(period.status)) {
    const err = new Error("لا يمكن إرسال الدفع لهذه الفترة");
    err.status = 400;
    throw err;
  }

  const payment = await parseSubscriptionPaymentSubmission(body);

  period.status = BILLING_STATUSES.PAYMENT_PENDING;
  period.paymentMethod = payment.paymentMethod;
  period.transferInformation = payment.transferInformation;
  period.paymentProof = payment.paymentProof;
  period.paymentProofImage = payment.paymentProofImage;
  period.rejectionReason = "";
  period.reviewedBy = null;
  period.reviewedAt = null;
  await period.save();

  await billingNotification.notifyBillingSubmitted(companyId, period);
  return period;
}

async function setPricePerDeliveredOrder(companyId, price) {
  const company = await DeliveryCompany.findOne({ _id: companyId, deletedAt: null });
  if (!company) {
    const err = new Error("شركة التوصيل غير موجودة");
    err.status = 404;
    throw err;
  }
  company.pricePerDeliveredOrder = Math.max(0, Number(price) || DEFAULT_PRICE_PER_ORDER);
  await company.save();
  return company.pricePerDeliveredOrder;
}

function serializePeriod(period) {
  if (!period) return null;
  const plain = period.toObject ? period.toObject() : period;
  return {
    ...plain,
    monthLabel: formatMonthLabel(plain.monthKey),
  };
}

function buildBillingStatusPayload(company, periods = {}, monthKeys = {}) {
  const {
    currentPeriod,
    previousPeriod,
    openPeriod,
    rejectedPeriod,
  } = periods;

  const billingStatus = openPeriod?.status
    || previousPeriod?.status
    || currentPeriod?.status
    || null;

  return {
    companyId: company._id,
    companyName: company.name,
    pricePerOrder: Number(company.pricePerDeliveredOrder ?? DEFAULT_PRICE_PER_ORDER),
    currency: company.currency || "ILS",
    currentMonthKey: monthKeys.currentMonthKey,
    previousMonthKey: monthKeys.previousMonthKey,
    currentMonthLabel: formatMonthLabel(monthKeys.currentMonthKey),
    previousMonthLabel: formatMonthLabel(monthKeys.previousMonthKey),
    currentPeriod: serializePeriod(currentPeriod),
    previousPeriod: serializePeriod(previousPeriod),
    openPeriod: serializePeriod(openPeriod),
    billingStatus,
    paymentPending: openPeriod?.status === BILLING_STATUSES.PAYMENT_PENDING,
    paymentRejected: Boolean(rejectedPeriod),
    needsPayment: Boolean(openPeriod && [
      BILLING_STATUSES.AWAITING_PAYMENT,
      BILLING_STATUSES.PAYMENT_REJECTED,
    ].includes(openPeriod.status)),
    canOperate: !rejectedPeriod,
    lifetimeHandoverCount: company.handedOverOrderCount ?? 0,
  };
}

async function getCompanyBillingStatus(companyId, date = new Date()) {
  const { company } = await getCompanyBillingConfig(companyId);
  const currentMonthKey = getCurrentMonthKey(date);
  const previousMonthKey = getPreviousMonthKey(date);

  const [currentPeriod, previousPeriod, openPeriod, rejectedPeriod] = await Promise.all([
    DeliveryCompanyBillingPeriod.findOne({ deliveryCompany: companyId, monthKey: currentMonthKey }).lean(),
    DeliveryCompanyBillingPeriod.findOne({ deliveryCompany: companyId, monthKey: previousMonthKey }).lean(),
    findOldestOpenBillingPeriod(companyId),
    DeliveryCompanyBillingPeriod.findOne({
      deliveryCompany: companyId,
      status: BILLING_STATUSES.PAYMENT_REJECTED,
      closedAt: null,
    }).sort({ monthKey: 1 }).lean(),
  ]);

  if (!currentPeriod) {
    await findOrCreateCountingPeriod(companyId, currentMonthKey);
  }

  const refreshedCurrent = currentPeriod
    || await DeliveryCompanyBillingPeriod.findOne({ deliveryCompany: companyId, monthKey: currentMonthKey }).lean();

  return buildBillingStatusPayload(company, {
    currentPeriod: refreshedCurrent,
    previousPeriod,
    openPeriod: openPeriod?.toObject ? openPeriod.toObject() : openPeriod,
    rejectedPeriod,
  }, { currentMonthKey, previousMonthKey });
}

async function listBillingHistory(companyId, { limit = 24 } = {}) {
  const periods = await DeliveryCompanyBillingPeriod.find({ deliveryCompany: companyId })
    .sort({ monthKey: -1 })
    .limit(Math.min(limit, 60))
    .lean();
  return periods.map(serializePeriod);
}

function periodWithHandoverCount(period, monthKey, handoverCount) {
  if (!handoverCount && !period) return null;
  const base = period ? serializePeriod(period) : {
    monthKey,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 0,
    amountDue: 0,
  };
  return {
    ...base,
    deliveredOrderCount: handoverCount,
    amountDue: computeAmountDue(
      handoverCount,
      base.pricePerOrder ?? DEFAULT_PRICE_PER_ORDER,
    ),
  };
}

async function listAdminBillingCards(date = new Date()) {
  const currentMonthKey = getCurrentMonthKey(date);
  const previousMonthKey = getPreviousMonthKey(date);

  const companies = await DeliveryCompany.find({ deletedAt: null })
    .select("name phone logo isActive pricePerDeliveredOrder currency handedOverOrderCount")
    .sort({ name: 1 })
    .lean();

  const companyIds = companies.map((c) => c._id);
  const deliverySessionService = require("./deliverySession.service");
  const handoverService = require("./deliveryCompanyHandover.service");
  const [outForDeliveryByCompany, currentHandoverCounts, previousHandoverCounts] = await Promise.all([
    deliverySessionService.countOutForDeliverySessionsByCompanies(companyIds),
    handoverService.countHandoversByCompaniesForMonth(companyIds, currentMonthKey),
    handoverService.countHandoversByCompaniesForMonth(companyIds, previousMonthKey),
  ]);

  const allPeriods = await DeliveryCompanyBillingPeriod.find({
    deliveryCompany: { $in: companyIds },
    $or: [
      { monthKey: { $in: [currentMonthKey, previousMonthKey] } },
      { status: { $in: [...OPEN_BILLING_STATUSES, BILLING_STATUSES.PAYMENT_PENDING] }, closedAt: null },
    ],
  }).lean();

  const periodsByCompany = new Map();
  for (const period of allPeriods) {
    const key = String(period.deliveryCompany);
    if (!periodsByCompany.has(key)) periodsByCompany.set(key, []);
    periodsByCompany.get(key).push(period);
  }

  return {
    currentMonthKey,
    previousMonthKey,
    currentMonthLabel: formatMonthLabel(currentMonthKey),
    previousMonthLabel: formatMonthLabel(previousMonthKey),
    cards: companies.map((company) => {
      const periods = periodsByCompany.get(String(company._id)) || [];
      const currentPeriod = periods.find((p) => p.monthKey === currentMonthKey) || null;
      const previousPeriod = periods.find((p) => p.monthKey === previousMonthKey) || null;
      const openPeriod = periods
        .filter((p) => OPEN_BILLING_STATUSES.includes(p.status) && !p.closedAt)
        .sort((a, b) => a.monthKey.localeCompare(b.monthKey))[0] || null;
      const reviewPeriod = periods.find((p) => p.status === BILLING_STATUSES.PAYMENT_PENDING) || null;
      const billPeriod = openPeriod || reviewPeriod;
      const paymentSubmitted = Boolean(reviewPeriod);

      const billingStatus = reviewPeriod?.status
        || openPeriod?.status
        || previousPeriod?.status
        || currentPeriod?.status
        || BILLING_STATUSES.COUNTING;

      const billCount = billPeriod?.deliveredOrderCount ?? 0;
      const billPrice = billPeriod?.pricePerOrder ?? Number(company.pricePerDeliveredOrder ?? DEFAULT_PRICE_PER_ORDER);
      const billTotal = billPeriod?.amountDue ?? computeAmountDue(billCount, billPrice);
      const currentMonthHandoverCount = currentHandoverCounts.get(String(company._id)) || 0;
      const previousMonthHandoverCount = previousHandoverCounts.get(String(company._id)) || 0;
      const currentMonthOrderCount = currentMonthHandoverCount;
      const unconfirmedHandoverCount = outForDeliveryByCompany.get(String(company._id)) || 0;
      const currentPeriodForDisplay = periodWithHandoverCount(
        currentPeriod,
        currentMonthKey,
        currentMonthHandoverCount,
      );
      const previousPeriodForDisplay = periodWithHandoverCount(
        previousPeriod,
        previousMonthKey,
        previousMonthHandoverCount,
      );

      return {
        company,
        pricePerOrder: Number(company.pricePerDeliveredOrder ?? DEFAULT_PRICE_PER_ORDER),
        currentMonthOrderCount,
        unconfirmedHandoverCount,
        hasUnconfirmedHandovers: unconfirmedHandoverCount > 0,
        currentPeriod: currentPeriodForDisplay,
        previousPeriod: previousPeriodForDisplay,
        openPeriod: serializePeriod(openPeriod),
        reviewPeriod: serializePeriod(reviewPeriod),
        billPeriod: serializePeriod(billPeriod),
        billingStatus,
        paymentSubmitted,
        canVerify: paymentSubmitted,
        canReview: paymentSubmitted,
        canExempt: Boolean(billPeriod),
        verifyPeriodId: reviewPeriod?._id || null,
        exemptPeriodId: billPeriod?._id || null,
        billSummary: billPeriod ? {
          monthKey: billPeriod.monthKey,
          monthLabel: formatMonthLabel(billPeriod.monthKey),
          deliveredOrderCount: billCount,
          pricePerOrder: billPrice,
          amountDue: billTotal,
          currency: billPeriod.currency || company.currency || "ILS",
        } : null,
        payment: reviewPeriod ? {
          ...serializePaymentForOwner(reviewPeriod),
          paymentMethodLabel: getPaymentTypeLabel(reviewPeriod.paymentMethod),
        } : null,
      };
    }),
  };
}

module.exports = {
  incrementHandoverCount,
  finalizePeriodForBilling,
  closeCountingPeriodsForPastMonths,
  approveBillingPayment,
  rejectBillingPayment,
  exemptBillingPeriod,
  submitBillingPayment,
  setPricePerDeliveredOrder,
  getCompanyBillingStatus,
  listBillingHistory,
  listAdminBillingCards,
  ensureCountingPeriod,
  findOrCreateCountingPeriod,
  findBillingPeriod,
  countHandoversInMonth,
  computeAmountDue,
};
