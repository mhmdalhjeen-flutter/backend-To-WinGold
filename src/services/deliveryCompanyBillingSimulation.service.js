const mongoose = require("mongoose");
const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyBillingPeriod = require("../models/deliveryCompanyBillingPeriod");
const DeliveryCompanyBillingSimulation = require("../models/deliveryCompanyBillingSimulation");
const DeliveryCompanyOrderHandover = require("../models/deliveryCompanyOrderHandover");
const {
  BILLING_STATUSES,
  DEFAULT_PRICE_PER_ORDER,
} = require("../constants/deliveryBilling.constants");
const { getCurrentMonthKey, addMonthsToMonthKey } = require("../utils/subscriptionMonth.util");
const { getMonthBounds } = require("../utils/billingMonth.util");
const { isBillingSimulationAllowed } = require("../utils/deliveryBillingSimulation.util");

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

function realPeriodScope() {
  return { $or: [{ simulationSessionId: null }, { simulationSessionId: { $exists: false } }] };
}

function assertSimulationAllowed() {
  if (!isBillingSimulationAllowed()) {
    const err = new Error("محاكاة الفوترة غير متاحة في هذا البيئة");
    err.status = 403;
    throw err;
  }
}

async function getActiveSimulation(companyId) {
  return DeliveryCompanyBillingSimulation.findOne({
    deliveryCompany: companyId,
    active: true,
  }).lean();
}

async function startBillingSimulation(companyId, userId) {
  assertSimulationAllowed();

  const existing = await getActiveSimulation(companyId);
  if (existing) {
    const err = new Error("توجد محاكاة نشطة بالفعل — احذفها أولاً");
    err.status = 409;
    throw err;
  }

  const closedMonthKey = getCurrentMonthKey();
  const countingMonthKey = addMonthsToMonthKey(closedMonthKey, 1);
  const { pricePerOrder, currency } = await getCompanyBillingConfig(companyId);

  const realPeriod = await DeliveryCompanyBillingPeriod.findOne({
    deliveryCompany: companyId,
    monthKey: closedMonthKey,
    ...realPeriodScope(),
  }).lean();

  let deliveredOrderCount = Number(realPeriod?.deliveredOrderCount || 0);
  if (!deliveredOrderCount) {
    deliveredOrderCount = await countHandoversInMonth(companyId, closedMonthKey);
  }

  const session = await DeliveryCompanyBillingSimulation.create({
    deliveryCompany: companyId,
    active: true,
    closedMonthKey,
    countingMonthKey,
    startedBy: userId || null,
  });

  await DeliveryCompanyBillingPeriod.create({
    deliveryCompany: companyId,
    monthKey: closedMonthKey,
    simulationSessionId: session._id,
    status: BILLING_STATUSES.AWAITING_PAYMENT,
    deliveredOrderCount,
    pricePerOrder,
    amountDue: computeAmountDue(deliveredOrderCount, pricePerOrder),
    currency,
    billingFinalizedAt: new Date(),
    closedAt: null,
  });

  await DeliveryCompanyBillingPeriod.create({
    deliveryCompany: companyId,
    monthKey: countingMonthKey,
    simulationSessionId: session._id,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 0,
    pricePerOrder,
    amountDue: 0,
    currency,
    closedAt: null,
  });

  return session;
}

async function resetBillingSimulation(companyId) {
  assertSimulationAllowed();

  const session = await DeliveryCompanyBillingSimulation.findOne({
    deliveryCompany: companyId,
    active: true,
  });

  if (!session) {
    const err = new Error("لا توجد محاكاة نشطة");
    err.status = 404;
    throw err;
  }

  const sessionId = session._id;
  await DeliveryCompanyBillingPeriod.deleteMany({ simulationSessionId: sessionId });
  await DeliveryCompanyBillingSimulation.deleteOne({ _id: sessionId });

  return { deletedSessionId: sessionId };
}

module.exports = {
  getActiveSimulation,
  startBillingSimulation,
  resetBillingSimulation,
  realPeriodScope,
  assertSimulationAllowed,
  isBillingSimulationAllowed,
};
