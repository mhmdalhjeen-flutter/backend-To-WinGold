/**
 * Delivery company billing reconcile + company portal read — run with:
 * node --test --test-force-exit tests/deliveryCompanyBillingReconcile.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeliveryCompany = require("../src/models/deliveryCompany");
const DeliveryCompanyBillingPeriod = require("../src/models/deliveryCompanyBillingPeriod");
const DeliveryCompanyOrderHandover = require("../src/models/deliveryCompanyOrderHandover");

const { BILLING_STATUSES, DEFAULT_PRICE_PER_ORDER } = require("../src/constants/deliveryBilling.constants");
const {
  reconcileCountingPeriodFromLedger,
  getCompanyBillingStatus,
  incrementHandoverCount,
} = require("../src/services/deliveryCompanyBilling.service");
const { markDriverConfirmedForOrders } = require("../src/services/deliveryCompanyHandover.service");

require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingRequired = async () => {};

const companyId = new mongoose.Types.ObjectId();
const order1 = new mongoose.Types.ObjectId();
const order2 = new mongoose.Types.ObjectId();
const monthKey = "2026-08";
const handoverAt = new Date("2026-08-15T10:00:00Z");

const periods = new Map();
const handovers = [];

function periodStorageKey(company, key) {
  return `${String(company)}:${key}`;
}

function resetState() {
  periods.clear();
  handovers.length = 0;
}

function seedCountingPeriod(count = 0) {
  const id = new mongoose.Types.ObjectId();
  const period = {
    _id: id,
    deliveryCompany: companyId,
    monthKey,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: count,
    pricePerOrder: DEFAULT_PRICE_PER_ORDER,
    amountDue: count * DEFAULT_PRICE_PER_ORDER,
    currency: "ILS",
    closedAt: null,
  };
  periods.set(String(id), period);
  periods.set(periodStorageKey(companyId, monthKey), period);
  return period;
}

function seedHandover(orderId, at = handoverAt) {
  handovers.push({
    _id: new mongoose.Types.ObjectId(),
    order: orderId,
    deliveryCompany: companyId,
    handoverAt: at,
    billingCountApplied: true,
  });
}

DeliveryCompany.findById = (id) => ({
  select: () => ({
    lean: async () => ({
      _id: id,
      name: "Test Co",
      pricePerDeliveredOrder: DEFAULT_PRICE_PER_ORDER,
      currency: "ILS",
      isActive: true,
      handedOverOrderCount: handovers.length,
    }),
  }),
});

DeliveryCompanyBillingPeriod.findOne = (query) => {
  const exec = async () => {
    if (query.deliveryCompany && query.status === BILLING_STATUSES.COUNTING && query.closedAt === null && !query.monthKey) {
      const rows = Array.from(periods.values())
        .filter((p) => String(p.deliveryCompany) === String(query.deliveryCompany)
          && p.status === BILLING_STATUSES.COUNTING
          && !p.closedAt)
        .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
      return rows[0] || null;
    }
    if (query.deliveryCompany && query.monthKey) {
      return periods.get(periodStorageKey(query.deliveryCompany, query.monthKey)) || null;
    }
    if (query.deliveryCompany && query.status) {
      const rows = Array.from(periods.values()).filter(
        (p) => String(p.deliveryCompany) === String(query.deliveryCompany)
          && (query.status.$in ? query.status.$in.includes(p.status) : p.status === query.status)
          && (query.closedAt === null ? !p.closedAt : true),
      );
      if (query.status.$in) {
        return rows.sort((a, b) => a.monthKey.localeCompare(b.monthKey))[0] || null;
      }
      return rows.sort((a, b) => b.monthKey.localeCompare(a.monthKey))[0] || null;
    }
    return null;
  };
  const chain = {
    sort: () => chain,
    lean: () => ({ then: (resolve) => resolve(exec()) }),
    session: () => chain,
    then: (resolve, reject) => exec().then(resolve, reject),
  };
  return chain;
};

DeliveryCompanyBillingPeriod.findOneAndUpdate = async (query, update) => {
  if (!(query.deliveryCompany && query.monthKey && update?.$setOnInsert)) return null;
  const key = periodStorageKey(query.deliveryCompany, query.monthKey);
  let period = periods.get(key);
  if (!period) {
    const id = new mongoose.Types.ObjectId();
    period = { ...update.$setOnInsert, _id: id };
    periods.set(String(id), period);
    periods.set(key, period);
  }
  return period;
};

DeliveryCompanyBillingPeriod.updateOne = async (query, update) => {
  const period = periods.get(String(query._id));
  if (!period) return { modifiedCount: 0 };
  if (query.status && period.status !== query.status) return { modifiedCount: 0 };
  if (update.$inc?.deliveredOrderCount) {
    period.deliveredOrderCount = (period.deliveredOrderCount || 0) + update.$inc.deliveredOrderCount;
  }
  if (update.$set) Object.assign(period, update.$set);
  return { modifiedCount: 1 };
};

DeliveryCompanyOrderHandover.countDocuments = async (query) => {
  const { getMonthBounds } = require("../src/utils/billingMonth.util");
  let rows = [...handovers];
  if (query.deliveryCompany) {
    rows = rows.filter((h) => String(h.deliveryCompany) === String(query.deliveryCompany));
  }
  if (query.handoverAt?.$gte || query.handoverAt?.$lt) {
    rows = rows.filter((h) => {
      const at = new Date(h.handoverAt).getTime();
      if (query.handoverAt.$gte && at < new Date(query.handoverAt.$gte).getTime()) return false;
      if (query.handoverAt.$lt && at >= new Date(query.handoverAt.$lt).getTime()) return false;
      return true;
    });
  }
  return rows.length;
};

DeliveryCompanyOrderHandover.updateMany = async () => ({ modifiedCount: 1 });

test.beforeEach(() => resetState());

test("reconcileCountingPeriodFromLedger sets stale counting period to ledger count", async () => {
  seedCountingPeriod(0);
  seedHandover(order1);

  await reconcileCountingPeriodFromLedger(companyId, monthKey);

  const period = periods.get(periodStorageKey(companyId, monthKey));
  assert.equal(period.deliveredOrderCount, 1);
  assert.equal(period.amountDue, DEFAULT_PRICE_PER_ORDER);
});

test("reconcileCountingPeriodFromLedger is idempotent on second run", async () => {
  seedCountingPeriod(0);
  seedHandover(order1);
  seedHandover(order2);

  await reconcileCountingPeriodFromLedger(companyId, monthKey);
  await reconcileCountingPeriodFromLedger(companyId, monthKey);

  const period = periods.get(periodStorageKey(companyId, monthKey));
  assert.equal(period.deliveredOrderCount, 2);
});

test("reconcileCountingPeriodFromLedger does not modify paid periods", async () => {
  const id = new mongoose.Types.ObjectId();
  const closed = {
    _id: id,
    deliveryCompany: companyId,
    monthKey: "2026-07",
    status: BILLING_STATUSES.PAID,
    deliveredOrderCount: 4,
    pricePerOrder: DEFAULT_PRICE_PER_ORDER,
    amountDue: 4 * DEFAULT_PRICE_PER_ORDER,
    currency: "ILS",
    closedAt: new Date(),
  };
  periods.set(String(id), closed);
  periods.set(periodStorageKey(companyId, "2026-07"), closed);
  seedHandover(order1, new Date("2026-07-10T10:00:00Z"));

  await reconcileCountingPeriodFromLedger(companyId, "2026-07");

  assert.equal(closed.deliveredOrderCount, 4);
  assert.equal(closed.amountDue, 4 * DEFAULT_PRICE_PER_ORDER);
});

test("getCompanyBillingStatus shows ledger count when period field is stale", async () => {
  seedCountingPeriod(0);
  seedHandover(order1);

  const status = await getCompanyBillingStatus(companyId, handoverAt);

  assert.equal(status.currentPeriod.deliveredOrderCount, 1);
  assert.equal(periods.get(periodStorageKey(companyId, monthKey)).deliveredOrderCount, 0);
});

test("driver delivery confirmation does not decrement monthly billing counter", async () => {
  seedCountingPeriod(1);
  seedHandover(order1);

  await markDriverConfirmedForOrders([order1], new mongoose.Types.ObjectId());

  const period = periods.get(periodStorageKey(companyId, monthKey));
  assert.equal(period.deliveredOrderCount, 1);
});

test("new month handover starts at zero without changing previous month", async () => {
  const prevKey = "2026-07";
  const prevId = new mongoose.Types.ObjectId();
  const previous = {
    _id: prevId,
    deliveryCompany: companyId,
    monthKey: prevKey,
    status: BILLING_STATUSES.AWAITING_PAYMENT,
    deliveredOrderCount: 5,
    pricePerOrder: DEFAULT_PRICE_PER_ORDER,
    amountDue: 5 * DEFAULT_PRICE_PER_ORDER,
    currency: "ILS",
    closedAt: null,
  };
  periods.set(String(prevId), previous);
  periods.set(periodStorageKey(companyId, prevKey), previous);

  const result = await incrementHandoverCount(companyId, handoverAt);
  assert.equal(result.incremented, true);

  const current = periods.get(periodStorageKey(companyId, monthKey));
  assert.ok(current);
  assert.equal(current.deliveredOrderCount, 1);
  assert.equal(previous.deliveredOrderCount, 5);
});

console.log("deliveryCompanyBillingReconcile.test.js — all tests registered");
