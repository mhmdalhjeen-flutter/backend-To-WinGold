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
} = require("../utils/subscriptionMonth.util");
const { getMonthBounds, formatMonthLabel } = require("../utils/billingMonth.util");
const { parseSubscriptionPaymentSubmission } = require("../utils/storeSubscriptionPayment.util");
const billingNotification = require("./deliveryCompanyBillingNotification.service");

const CLOSED_SET = new Set(CLOSED_BILLING_STATUSES);

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

async function ensureCountingPeriod(companyId, monthKey, session = null) {
  const existing = await DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    monthKey,
    status: BILLING_STATUSES.COUNTING,
  }).session(session || null);

  if (existing) return existing;

  const openPeriod = await DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    monthKey,
    status: { $nin: CLOSED_BILLING_STATUSES },
  }).session(session || null);

  if (openPeriod) return openPeriod;

  const { pricePerOrder, currency } = await getCompanyBillingConfig(companyId);
  const createOpts = session ? { session } : {};
  const [created] = await DeliveryCompanyBillingPeriod.create([{
    deliveryCompany: companyId,
    monthKey,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 0,
    pricePerOrder,
    amountDue: 0,
    currency,
  }], createOpts);
  return created;
}

async function incrementHandoverCount(companyId, handoverAt = new Date()) {
  if (!companyId) return { incremented: false, reason: "no_company" };

  const monthKey = getCurrentMonthKey(handoverAt);
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

  const countingPeriod = period || await ensureCountingPeriod(companyId, monthKey);

  const result = await DeliveryCompanyBillingPeriod.updateOne(
    { _id: countingPeriod._id, status: BILLING_STATUSES.COUNTING },
    { $inc: { deliveredOrderCount: 1 } },
  );

  return {
    incremented: result.modifiedCount > 0,
    periodId: countingPeriod._id,
    monthKey,
  };
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

async function startNewCountingCycleAfterClose(companyId, session) {
  const currentMonthKey = getCurrentMonthKey();
  const existingCounting = await DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    monthKey: currentMonthKey,
    status: BILLING_STATUSES.COUNTING,
  }).session(session);

  if (existingCounting) return existingCounting;

  const openCurrent = await DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    monthKey: currentMonthKey,
    status: { $nin: CLOSED_BILLING_STATUSES },
  }).session(session);

  if (openCurrent) return openCurrent;

  const { pricePerOrder, currency } = await getCompanyBillingConfig(companyId);
  const [created] = await DeliveryCompanyBillingPeriod.create([{
    deliveryCompany: companyId,
    monthKey: currentMonthKey,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 0,
    pricePerOrder,
    amountDue: 0,
    currency,
  }], { session });
  return created;
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

    await startNewCountingCycleAfterClose(period.deliveryCompany, session);
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
    await ensureCountingPeriod(companyId, currentMonthKey);
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

async function listAdminBillingCards(date = new Date()) {
  const currentMonthKey = getCurrentMonthKey(date);
  const previousMonthKey = getPreviousMonthKey(date);

  const companies = await DeliveryCompany.find({ deletedAt: null })
    .select("name phone logo isActive pricePerDeliveredOrder currency handedOverOrderCount")
    .sort({ name: 1 })
    .lean();

  const companyIds = companies.map((c) => c._id);
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

      const billingStatus = reviewPeriod?.status
        || openPeriod?.status
        || previousPeriod?.status
        || currentPeriod?.status
        || BILLING_STATUSES.COUNTING;

      return {
        company,
        pricePerOrder: Number(company.pricePerDeliveredOrder ?? DEFAULT_PRICE_PER_ORDER),
        currentPeriod: serializePeriod(currentPeriod),
        previousPeriod: serializePeriod(previousPeriod),
        openPeriod: serializePeriod(openPeriod),
        reviewPeriod: serializePeriod(reviewPeriod),
        billingStatus,
        canReview: Boolean(reviewPeriod),
        canExempt: Boolean(openPeriod || reviewPeriod),
        exemptPeriodId: (reviewPeriod || openPeriod)?._id || null,
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
  countHandoversInMonth,
  computeAmountDue,
};
