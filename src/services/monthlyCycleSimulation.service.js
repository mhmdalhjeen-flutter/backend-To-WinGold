const SystemSetting = require("../models/systemSetting");
const Store = require("../models/store");
const StoreSubscriptionPeriod = require("../models/storeSubscriptionPeriod");
const DeliveryCompany = require("../models/deliveryCompany");
const storeSubscriptionService = require("./storeSubscription.service");
const deliveryCompanyBillingService = require("./deliveryCompanyBilling.service");
const { CARD_SOURCES, SUBSCRIPTION_STATUSES } = require("../constants/storeSubscription.constants");
const { BILLING_STATUSES } = require("../constants/deliveryBilling.constants");
const {
  getCurrentMonthKey,
  getPreviousMonthKey,
  addMonthsToMonthKey,
  monthKeyToReferenceDate,
} = require("../utils/subscriptionMonth.util");
const { formatMonthLabel } = require("../utils/billingMonth.util");
const { safeLog } = require("../utils/logSanitize.util");

const SIMULATION_CURSOR_KEY = "monthly_cycle_simulation_cursor";

function isOperationalSubscriptionStatus(status) {
  return status === SUBSCRIPTION_STATUSES.ACTIVE
    || status === SUBSCRIPTION_STATUSES.EXEMPTED
    || status === SUBSCRIPTION_STATUSES.PAYMENT_PENDING;
}

async function getSimulationCursorMonthKey() {
  const doc = await SystemSetting.findOne({ key: SIMULATION_CURSOR_KEY }).lean();
  const stored = doc?.value?.monthKey;
  if (stored && /^\d{4}-\d{2}$/.test(stored)) return stored;
  return getCurrentMonthKey();
}

async function setSimulationCursorMonthKey(monthKey, adminId = null) {
  await SystemSetting.findOneAndUpdate(
    { key: SIMULATION_CURSOR_KEY },
    {
      $set: {
        value: {
          monthKey,
          updatedAt: new Date(),
          updatedBy: adminId || null,
        },
        description: "Admin monthly-cycle simulation cursor (testing only — does not change server clock)",
      },
    },
    { upsert: true },
  );
  return monthKey;
}

async function countIndependentCardsAcrossStores() {
  const stores = await Store.find({}).select("cardInventory").lean();
  let total = 0;
  for (const store of stores) {
    for (const entry of store.cardInventory || []) {
      if (entry?.source === CARD_SOURCES.SUBSCRIPTION) continue;
      total += Math.max(0, Number(entry?.count) || 0);
    }
  }
  return total;
}

async function countStoresRequiringPayment(targetMonthKey) {
  const stores = await Store.find({ isActive: true, subscriptionActive: { $ne: false } })
    .select("_id")
    .lean();
  if (!stores.length) return 0;

  const periods = await StoreSubscriptionPeriod.find({
    store: { $in: stores.map((s) => s._id) },
    monthKey: targetMonthKey,
  }).select("store status").lean();

  const periodByStore = new Map(periods.map((p) => [String(p.store), p]));
  let count = 0;
  for (const store of stores) {
    const period = periodByStore.get(String(store._id));
    if (!period) {
      count += 1;
      continue;
    }
    if (period.status === SUBSCRIPTION_STATUSES.PAYMENT_REJECTED) {
      count += 1;
      continue;
    }
    if (period.status === SUBSCRIPTION_STATUSES.PAYMENT_PENDING) continue;
    if (!isOperationalSubscriptionStatus(period.status)) count += 1;
  }
  return count;
}

async function summarizeExpiredStorePeriods(periodIds = []) {
  if (!periodIds.length) {
    return {
      periodsExpired: 0,
      subscriptionCardsIssuedRemoved: 0,
      stores: [],
    };
  }

  const periods = await StoreSubscriptionPeriod.find({ _id: { $in: periodIds } })
    .populate("store", "name")
    .lean();

  let subscriptionCardsIssuedRemoved = 0;
  const stores = periods.map((period) => {
    const issued = Number(period.digitalCardsIssued || 0) + Number(period.paperCardsIssued || 0);
    subscriptionCardsIssuedRemoved += issued;
    return {
      storeId: period.store?._id || period.store,
      storeName: period.store?.name || "",
      monthKey: period.monthKey,
      monthLabel: formatMonthLabel(period.monthKey),
      status: period.status,
      digitalCardsIssued: period.digitalCardsIssued || 0,
      paperCardsIssued: period.paperCardsIssued || 0,
    };
  });

  return {
    periodsExpired: periods.length,
    subscriptionCardsIssuedRemoved,
    stores,
  };
}

function summarizeFinalizedDeliveryPeriods(periods = []) {
  const rows = (periods || []).filter(Boolean);
  let deliveredOrdersCounted = 0;
  let deliveryAmountsCalculated = 0;

  const companies = rows.map((period) => {
    const count = Number(period.deliveredOrderCount || 0);
    const amount = Number(period.amountDue || 0);
    deliveredOrdersCounted += count;
    deliveryAmountsCalculated += amount;
    return {
      periodId: period._id,
      deliveryCompanyId: period.deliveryCompany,
      monthKey: period.monthKey,
      monthLabel: formatMonthLabel(period.monthKey),
      deliveredOrderCount: count,
      pricePerOrder: period.pricePerOrder,
      amountDue: amount,
      currency: period.currency || "ILS",
      status: period.status,
    };
  });

  return {
    deliveryCompaniesProcessed: companies.length,
    deliveredOrdersCounted,
    deliveryAmountsCalculated,
    paymentsGenerated: companies.filter((row) => row.status === BILLING_STATUSES.AWAITING_PAYMENT).length,
    companies,
  };
}

/**
 * Admin-only monthly cycle simulation.
 * Reuses production month-end services with a reference date (does NOT change server clock).
 */
async function runMonthlyCycleSimulation(adminId = null) {
  const cursorBefore = await getSimulationCursorMonthKey();
  const targetMonthKey = addMonthsToMonthKey(cursorBefore, 1);
  const referenceDate = monthKeyToReferenceDate(targetMonthKey);
  const closedMonthKey = getPreviousMonthKey(referenceDate);

  safeLog("info", "monthly_cycle_simulation_started", {
    adminId: adminId ? String(adminId) : null,
    cursorBefore,
    targetMonthKey,
    closedMonthKey,
    referenceDate: referenceDate.toISOString(),
  });

  const independentCardsBefore = await countIndependentCardsAcrossStores();
  const activeStoresCount = await Store.countDocuments({ isActive: true });
  const activeDeliveryCompaniesCount = await DeliveryCompany.countDocuments({ deletedAt: null });

  try {
    const expiredPeriodIds = await storeSubscriptionService.expireEndedSubscriptionPeriods(referenceDate);
    const storeSummary = await summarizeExpiredStorePeriods(expiredPeriodIds);

    const finalizedPeriods = await deliveryCompanyBillingService.closeCountingPeriodsForPastMonths(referenceDate);
    const deliverySummary = summarizeFinalizedDeliveryPeriods(finalizedPeriods);

    const independentCardsAfter = await countIndependentCardsAcrossStores();
    const storesRequiringPayment = await countStoresRequiringPayment(targetMonthKey);

    const storesExempted = await StoreSubscriptionPeriod.countDocuments({
      monthKey: closedMonthKey,
      status: SUBSCRIPTION_STATUSES.EXEMPTED,
    });

    await setSimulationCursorMonthKey(targetMonthKey, adminId);

    const summary = {
      message: "تمت محاكاة بداية شهر جديد بنجاح",
      simulation: {
        cursorBefore,
        cursorAfter: targetMonthKey,
        simulatedTargetMonthKey: targetMonthKey,
        simulatedTargetMonthLabel: formatMonthLabel(targetMonthKey),
        simulatedClosedMonthKey: closedMonthKey,
        simulatedClosedMonthLabel: formatMonthLabel(closedMonthKey),
        referenceDate: referenceDate.toISOString(),
      },
      storesProcessed: activeStoresCount,
      subscriptionsProcessed: storeSummary.periodsExpired,
      subscriptionPeriodsExpired: storeSummary.periodsExpired,
      subscriptionCardsExpiredOrReset: storeSummary.subscriptionCardsIssuedRemoved,
      subscriptionStoresExpired: storeSummary.stores,
      independentCardsPreserved: independentCardsAfter,
      independentCardsUnchanged: independentCardsBefore === independentCardsAfter,
      storesRequiringPayment,
      storesExemptedInClosedMonth: storesExempted,
      paymentsGenerated: deliverySummary.paymentsGenerated,
      deliveryCompaniesProcessed: deliverySummary.deliveryCompaniesProcessed,
      activeDeliveryCompanies: activeDeliveryCompaniesCount,
      deliveredOrdersCounted: deliverySummary.deliveredOrdersCounted,
      deliveryAmountsCalculated: deliverySummary.deliveryAmountsCalculated,
      deliveryCompanies: deliverySummary.companies,
      idempotentHints: {
        note: "إعادة المحاكاة لنفس الشهر المُغلق سابقاً لن تُكرّر العملية — الخدمات الإنتاجية تتحقق من الحالة.",
        subscriptionExpiredCount: storeSummary.periodsExpired,
        deliveryFinalizedCount: deliverySummary.deliveryCompaniesProcessed,
      },
    };

    safeLog("info", "monthly_cycle_simulation_completed", {
      adminId: adminId ? String(adminId) : null,
      targetMonthKey,
      closedMonthKey,
      subscriptionPeriodsExpired: summary.subscriptionPeriodsExpired,
      deliveryCompaniesProcessed: summary.deliveryCompaniesProcessed,
      storesRequiringPayment: summary.storesRequiringPayment,
      independentCardsPreserved: summary.independentCardsPreserved,
    });

    return summary;
  } catch (err) {
    safeLog("error", "monthly_cycle_simulation_failed", {
      adminId: adminId ? String(adminId) : null,
      targetMonthKey,
      closedMonthKey,
      message: err.message,
    });
    throw err;
  }
}

module.exports = {
  SIMULATION_CURSOR_KEY,
  getSimulationCursorMonthKey,
  setSimulationCursorMonthKey,
  runMonthlyCycleSimulation,
  countIndependentCardsAcrossStores,
};
