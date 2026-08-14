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

async function findActiveCountingPeriod(companyId, session = null) {
  return DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    status: BILLING_STATUSES.COUNTING,
    closedAt: null,
  }).sort({ monthKey: -1 }).session(session || null);
}

async function resolveBillingMonthKey(companyId, handoverAt = new Date()) {
  const active = await findActiveCountingPeriod(companyId);
  if (active) return active.monthKey;
  return getCurrentMonthKey(handoverAt);
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

  const monthKey = await resolveBillingMonthKey(companyId, handoverAt);

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
      countingPeriod = period || await ensureCountingPeriod(companyId, monthKey, null);
    } catch (err) {
      if (!isMongoDuplicateKeyError(err)) throw err;
      safeLog("info", "delivery_billing_period_race_resolved", {
        companyId: String(companyId),
        monthKey,
        phase: "increment_ensure",
        attempt,
      });
      countingPeriod = await findBillingPeriod(companyId, monthKey, null);
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

  const { pricePerOrder, currency } = await getCompanyBillingConfig(period.deliveryCompany);
  const count = Number(period.deliveredOrderCount || 0);

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

/** @deprecated Billing closure is admin-triggered via requestDeliverySubscriptions. */
async function closeCountingPeriodsForPastMonths() {
  return [];
}

async function findOldestOpenBillingPeriod(companyId) {
  return DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    status: { $in: OPEN_BILLING_STATUSES },
    closedAt: null,
  }).sort({ monthKey: 1 }).lean();
}

async function startNewCountingCycleAfterClose(companyId, session, closedMonthKey) {
  const targetMonthKey = addMonthsToMonthKey(closedMonthKey || getCurrentMonthKey(), 1);

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
    canOperate: !(openPeriod && [
      BILLING_STATUSES.AWAITING_PAYMENT,
      BILLING_STATUSES.PAYMENT_REJECTED,
    ].includes(openPeriod.status)),
    lifetimeHandoverCount: company.handedOverOrderCount ?? 0,
  };
}

async function reconcileCountingPeriodFromLedger(companyId, monthKey) {
  const period = await findBillingPeriod(companyId, monthKey, null);
  if (!period || period.status !== BILLING_STATUSES.COUNTING) {
    return period;
  }

  const ledgerCount = await countHandoversInMonth(companyId, monthKey);
  const pricePerOrder = Number(period.pricePerOrder ?? DEFAULT_PRICE_PER_ORDER);
  const amountDue = computeAmountDue(ledgerCount, pricePerOrder);

  if (period.deliveredOrderCount === ledgerCount && period.amountDue === amountDue) {
    return period;
  }

  await DeliveryCompanyBillingPeriod.updateOne(
    { _id: period._id, status: BILLING_STATUSES.COUNTING },
    { $set: { deliveredOrderCount: ledgerCount, amountDue } },
  );

  return findBillingPeriod(companyId, monthKey, null);
}

async function getCompanyBillingStatus(companyId, date = new Date()) {
  const { company } = await getCompanyBillingConfig(companyId);

  const [
    countingPeriod,
    openPeriod,
    rejectedPeriod,
  ] = await Promise.all([
    findActiveCountingPeriod(companyId).then((p) => (p ? p.toObject?.() || p : null)),
    findOldestOpenBillingPeriod(companyId),
    DeliveryCompanyBillingPeriod.findOne({
      deliveryCompany: companyId,
      status: BILLING_STATUSES.PAYMENT_REJECTED,
      closedAt: null,
    }).sort({ monthKey: 1 }).lean(),
  ]);

  let currentMonthKey = countingPeriod?.monthKey || openPeriod?.monthKey || getCurrentMonthKey(date);
  const previousMonthKey = openPeriod?.monthKey
    || (countingPeriod?.monthKey ? addMonthsToMonthKey(countingPeriod.monthKey, -1) : getPreviousMonthKey(date));

  if (!countingPeriod && !openPeriod) {
    await findOrCreateCountingPeriod(companyId, getCurrentMonthKey(date));
    currentMonthKey = getCurrentMonthKey(date);
  }

  const refreshedCounting = countingPeriod
    || await DeliveryCompanyBillingPeriod.findOne({
      deliveryCompany: companyId,
      status: BILLING_STATUSES.COUNTING,
      closedAt: null,
    }).sort({ monthKey: -1 }).lean();

  const currentPeriodDoc = refreshedCounting
    || await DeliveryCompanyBillingPeriod.findOne({
      deliveryCompany: companyId,
      monthKey: currentMonthKey,
    }).lean();

  let currentPeriod = currentPeriodDoc;
  if (currentPeriodDoc?.status === BILLING_STATUSES.COUNTING && currentPeriodDoc.monthKey) {
    const ledgerCount = await countHandoversInMonth(companyId, currentPeriodDoc.monthKey);
    const displayCount = Math.max(Number(currentPeriodDoc.deliveredOrderCount || 0), ledgerCount);
    currentPeriod = periodWithHandoverCount(currentPeriodDoc, currentPeriodDoc.monthKey, displayCount);
  }

  const previousPeriod = openPeriod
    || await DeliveryCompanyBillingPeriod.findOne({
      deliveryCompany: companyId,
      monthKey: previousMonthKey,
    }).lean();

  return buildBillingStatusPayload(company, {
    currentPeriod,
    previousPeriod,
    openPeriod,
    rejectedPeriod,
  }, { currentMonthKey, previousMonthKey });
}

async function requestSubscriptionForCompany(companyId) {
  const openBill = await findOldestOpenBillingPeriod(companyId);
  if (openBill) {
    const nextCountingPeriod = await DeliveryCompanyBillingPeriod.findOne({
      deliveryCompany: companyId,
      status: BILLING_STATUSES.COUNTING,
      closedAt: null,
    }).sort({ monthKey: -1 }).lean();

    return {
      companyId,
      alreadyRequested: true,
      finalizedMonthKey: openBill.monthKey,
      openPeriod: serializePeriod(openBill),
      nextMonthKey: nextCountingPeriod?.monthKey || addMonthsToMonthKey(openBill.monthKey, 1),
      nextCountingPeriod: serializePeriod(nextCountingPeriod),
      amountDue: openBill.amountDue ?? 0,
      deliveredOrderCount: openBill.deliveredOrderCount ?? 0,
    };
  }

  const countingPeriod = await findActiveCountingPeriod(companyId);
  if (!countingPeriod) {
    return { companyId, skipped: true, reason: "no_counting_period" };
  }

  const finalized = await finalizePeriodForBilling(countingPeriod);
  const nextMonthKey = addMonthsToMonthKey(finalized.monthKey, 1);
  const nextPeriod = await findOrCreateCountingPeriod(companyId, nextMonthKey);

  return {
    companyId,
    finalized: true,
    finalizedMonthKey: finalized.monthKey,
    amountDue: finalized.amountDue ?? 0,
    deliveredOrderCount: finalized.deliveredOrderCount ?? 0,
    nextMonthKey,
    nextPeriod: serializePeriod(nextPeriod),
    openPeriod: serializePeriod(finalized),
  };
}

async function requestDeliverySubscriptions(adminId) {
  const companies = await DeliveryCompany.find({ deletedAt: null })
    .select("_id name")
    .sort({ name: 1 })
    .lean();

  const results = [];
  for (const company of companies) {
    const result = await requestSubscriptionForCompany(company._id);
    results.push({ ...result, companyName: company.name });
  }

  const finalized = results.filter((r) => r.finalized);
  const alreadyRequested = results.filter((r) => r.alreadyRequested);
  const skipped = results.filter((r) => r.skipped);
  const alreadyExecuted = finalized.length === 0 && alreadyRequested.length > 0;

  const nextActiveBillingMonth = finalized[0]?.nextMonthKey
    || alreadyRequested[0]?.nextCountingPeriod?.monthKey
    || alreadyRequested[0]?.nextMonthKey
    || null;

  const finalizedMonthKeys = [...new Set(
    finalized.map((r) => r.finalizedMonthKey).concat(alreadyRequested.map((r) => r.finalizedMonthKey)),
  )].filter(Boolean);

  return {
    alreadyExecuted,
    requestedBy: adminId,
    message: alreadyExecuted
      ? "تم طلب الاشتراكات مسبقاً لهذه الدورة"
      : "تم طلب الاشتراكات بنجاح",
    finalizedMonths: finalizedMonthKeys,
    companiesAffected: finalized.length,
    companiesAlreadyRequested: alreadyRequested.length,
    companiesSkipped: skipped.length,
    companiesRequiringPayment: finalized.filter((r) => (r.amountDue || 0) > 0).length,
    totalAmountDue: finalized.reduce((sum, r) => sum + Number(r.amountDue || 0), 0),
    nextActiveBillingMonth,
    results,
  };
}

async function listBillingHistory(companyId, { limit = 24 } = {}) {
  const periods = await DeliveryCompanyBillingPeriod.find({
    deliveryCompany: companyId,
  })
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

async function listAdminBillingCards() {
  const companies = await DeliveryCompany.find({ deletedAt: null })
    .select("name phone logo isActive pricePerDeliveredOrder currency handedOverOrderCount")
    .sort({ name: 1 })
    .lean();

  const companyIds = companies.map((c) => c._id);
  const deliverySessionService = require("./deliverySession.service");
  const handoverService = require("./deliveryCompanyHandover.service");
  const [outForDeliveryByCompany, allPeriods] = await Promise.all([
    deliverySessionService.countOutForDeliverySessionsByCompanies(companyIds),
    DeliveryCompanyBillingPeriod.find({
      deliveryCompany: { $in: companyIds },
      $or: [
        { status: BILLING_STATUSES.COUNTING, closedAt: null },
        { status: { $in: [...OPEN_BILLING_STATUSES, BILLING_STATUSES.PAYMENT_PENDING] }, closedAt: null },
      ],
    }).lean(),
  ]);

  const periodsByCompany = new Map();
  for (const period of allPeriods) {
    const key = String(period.deliveryCompany);
    if (!periodsByCompany.has(key)) periodsByCompany.set(key, []);
    periodsByCompany.get(key).push(period);
  }

  const monthKeyGroups = new Map();
  for (const company of companies) {
    const periods = periodsByCompany.get(String(company._id)) || [];
    const currentPeriod = periods
      .filter((p) => p.status === BILLING_STATUSES.COUNTING && !p.closedAt)
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey))[0] || null;
    if (currentPeriod?.monthKey) {
      if (!monthKeyGroups.has(currentPeriod.monthKey)) {
        monthKeyGroups.set(currentPeriod.monthKey, []);
      }
      monthKeyGroups.get(currentPeriod.monthKey).push(company._id);
    }
  }

  const ledgerCountsByCompany = new Map();
  await Promise.all([...monthKeyGroups.entries()].map(async ([mk, ids]) => {
    const counts = await handoverService.countHandoversByCompaniesForMonth(ids, mk);
    for (const [companyKey, count] of counts.entries()) {
      ledgerCountsByCompany.set(companyKey, count);
    }
  }));

  const cards = companies.map((company) => {
    const periods = periodsByCompany.get(String(company._id)) || [];
    const currentPeriod = periods
      .filter((p) => p.status === BILLING_STATUSES.COUNTING && !p.closedAt)
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey))[0] || null;
    const openPeriod = periods
      .filter((p) => OPEN_BILLING_STATUSES.includes(p.status) && !p.closedAt)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))[0] || null;
    const reviewPeriod = periods.find((p) => p.status === BILLING_STATUSES.PAYMENT_PENDING) || null;
    const billPeriod = openPeriod || reviewPeriod;
    const paymentSubmitted = Boolean(reviewPeriod);

    const billingStatus = reviewPeriod?.status
      || openPeriod?.status
      || currentPeriod?.status
      || BILLING_STATUSES.COUNTING;

    const billCount = billPeriod?.deliveredOrderCount ?? 0;
    const billPrice = billPeriod?.pricePerOrder ?? Number(company.pricePerDeliveredOrder ?? DEFAULT_PRICE_PER_ORDER);
    const billTotal = billPeriod?.amountDue ?? computeAmountDue(billCount, billPrice);
    const ledgerCount = ledgerCountsByCompany.get(String(company._id)) || 0;
    const currentMonthOrderCount = Math.max(currentPeriod?.deliveredOrderCount ?? 0, ledgerCount);
    const unconfirmedHandoverCount = outForDeliveryByCompany.get(String(company._id)) || 0;
    const currentPeriodForDisplay = periodWithHandoverCount(
      currentPeriod,
      currentPeriod?.monthKey,
      currentMonthOrderCount,
    );

    return {
      company,
      pricePerOrder: Number(company.pricePerDeliveredOrder ?? DEFAULT_PRICE_PER_ORDER),
      currentMonthKey: currentPeriod?.monthKey || null,
      previousMonthKey: openPeriod?.monthKey || null,
      currentMonthOrderCount,
      unconfirmedHandoverCount,
      hasUnconfirmedHandovers: unconfirmedHandoverCount > 0,
      currentPeriod: currentPeriodForDisplay,
      previousPeriod: serializePeriod(openPeriod),
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
  });

  const countingMonths = cards
    .map((c) => c.currentPeriod?.monthKey)
    .filter(Boolean);
  const openBillMonths = cards
    .map((c) => c.openPeriod?.monthKey)
    .filter(Boolean);

  return {
    currentMonthKey: countingMonths.sort()[0] || getCurrentMonthKey(),
    previousMonthKey: openBillMonths.sort()[0] || null,
    currentMonthLabel: formatMonthLabel(countingMonths.sort()[0] || getCurrentMonthKey()),
    previousMonthLabel: openBillMonths.sort()[0] ? formatMonthLabel(openBillMonths.sort()[0]) : null,
    cards,
  };
}

module.exports = {
  incrementHandoverCount,
  finalizePeriodForBilling,
  closeCountingPeriodsForPastMonths,
  requestDeliverySubscriptions,
  requestSubscriptionForCompany,
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
  findActiveCountingPeriod,
  resolveBillingMonthKey,
  countHandoversInMonth,
  computeAmountDue,
  reconcileCountingPeriodFromLedger,
  periodWithHandoverCount,
};
