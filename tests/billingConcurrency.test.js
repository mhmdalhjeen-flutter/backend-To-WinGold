/**
 * Billing/subscription concurrency — run with: node tests/billingConcurrency.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeliveryCompanyBillingPeriod = require("../src/models/deliveryCompanyBillingPeriod");
const DeliveryCompany = require("../src/models/deliveryCompany");
const DeliveryCompanyOrderHandover = require("../src/models/deliveryCompanyOrderHandover");
const DeliverySession = require("../src/models/deliverySession");
const Order = require("../src/models/order");
const StoreSubscriptionPeriod = require("../src/models/storeSubscriptionPeriod");

const { BILLING_STATUSES, DEFAULT_PRICE_PER_ORDER } = require("../src/constants/deliveryBilling.constants");
const { SUBSCRIPTION_STATUSES } = require("../src/constants/storeSubscription.constants");

const {
  findOrCreateCountingPeriod,
  incrementHandoverCount,
} = require("../src/services/deliveryCompanyBilling.service");

require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingRequired = async () => {};

const billingServicePath = require.resolve("../src/services/deliveryCompanyBilling.service");
const handoverServicePath = require.resolve("../src/services/deliveryCompanyHandover.service");
delete require.cache[handoverServicePath];

const { recordStoreHandoverToDeliveryCompany, HANDOVER_STATUS, REQUIRED_PREVIOUS_STATUS } =
  require("../src/services/deliveryCompanyHandover.service");

const storeSubscriptionServicePath = require.resolve("../src/services/storeSubscription.service");
delete require.cache[storeSubscriptionServicePath];

const storeSubscriptionService = require("../src/services/storeSubscription.service");

const companyId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const sessionId = new mongoose.Types.ObjectId();

const periods = new Map();
const subscriptionPeriods = new Map();
const handoverRecords = new Map();
let billingIncrementCalls = 0;

function periodKey(company, monthKey) {
  return `${String(company)}:${monthKey}`;
}

function subscriptionKey(store, monthKey) {
  return `${String(store)}:${monthKey}`;
}

function resetBillingMocks() {
  periods.clear();
  billingIncrementCalls = 0;

  DeliveryCompany.findById = (id) => ({
    select: () => ({
      lean: async () => ({
        _id: id,
        name: "Test Delivery Co",
        pricePerDeliveredOrder: DEFAULT_PRICE_PER_ORDER,
        currency: "ILS",
        isActive: true,
      }),
    }),
  });

  DeliveryCompanyOrderHandover.countDocuments = async () => 0;

  DeliveryCompanyBillingPeriod.findOne = (query) => {
    const exec = async () => {
      if (query._id) return periods.get(String(query._id)) || null;
      if (query.deliveryCompany && query.monthKey) {
        return periods.get(periodKey(query.deliveryCompany, query.monthKey)) || null;
      }
      return null;
    };
    const chain = {
      session: () => chain,
      sort: () => chain,
      lean: () => ({ then: (resolve) => resolve(exec()) }),
      then: (resolve, reject) => exec().then(resolve, reject),
    };
    return chain;
  };

  DeliveryCompanyBillingPeriod.updateOne = async (query, update) => {
    const period = periods.get(String(query._id));
    if (!period) return { modifiedCount: 0 };
    if (query.status && period.status !== query.status) return { modifiedCount: 0 };
    if (update.$inc?.deliveredOrderCount) {
      period.deliveredOrderCount = (period.deliveredOrderCount || 0) + update.$inc.deliveredOrderCount;
      billingIncrementCalls += 1;
    }
    return { modifiedCount: 1 };
  };

  DeliveryCompanyBillingPeriod.findOneAndUpdate = async (query, update) => {
    if (!(query.deliveryCompany && query.monthKey && update?.$setOnInsert)) return null;

    const key = periodKey(query.deliveryCompany, query.monthKey);
    let period = periods.get(key);
    if (!period) {
      const id = new mongoose.Types.ObjectId();
      period = { ...update.$setOnInsert, _id: id };
      periods.set(String(id), period);
      periods.set(key, period);
    }
    return period;
  };
}

function resetHandoverMocks() {
  handoverRecords.clear();
  DeliveryCompany.updateOne = async (query, update) => {
    if (update?.$inc?.handedOverOrderCount) {
      // no-op for this suite
    }
    return { acknowledged: true };
  };
  Order.updateOne = async () => ({ acknowledged: true });

  Order.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: orderId,
        status: HANDOVER_STATUS,
        deliveryGroup: sessionId,
        statusTimeline: [{ status: HANDOVER_STATUS, at: new Date("2026-08-15T10:00:00Z") }],
      }),
    }),
  });

  DeliverySession.findById = () => ({
    select: () => ({
      lean: async () => ({ deliveryCompany: companyId }),
    }),
  });

  DeliveryCompanyOrderHandover.findOne = (query) => ({
    select: () => ({
      lean: async () => handoverRecords.get(String(query.order)) || null,
    }),
  });

  DeliveryCompanyOrderHandover.findOneAndUpdate = async (query, update) => {
    const key = String(query.order);
    const row = handoverRecords.get(key);
    if (!row) return null;
    const billingQuery = query.billingCountApplied;
    if (billingQuery === false && row.billingCountApplied !== false) return null;
    if (billingQuery?.$ne === true && row.billingCountApplied === true) return null;
    if (update?.$set?.billingCountApplied != null) {
      row.billingCountApplied = update.$set.billingCountApplied;
    }
    return row;
  };

  DeliveryCompanyOrderHandover.updateOne = async (query, update) => {
    const key = String(query.order);
    const row = handoverRecords.get(key);
    if (!row) return { acknowledged: true };
    if (update?.$set?.billingCountApplied != null) {
      row.billingCountApplied = update.$set.billingCountApplied;
    }
    return { acknowledged: true };
  };

  DeliveryCompanyOrderHandover.create = async (doc) => {
    const key = String(doc.order);
    if (handoverRecords.has(key)) {
      const err = new Error("duplicate handover");
      err.code = 11000;
      throw err;
    }
    handoverRecords.set(key, {
      ...doc,
      _id: new mongoose.Types.ObjectId(),
      billingCountApplied: doc.billingCountApplied ?? false,
    });
    return doc;
  };
}

function resetSubscriptionMocks() {
  subscriptionPeriods.clear();

  StoreSubscriptionPeriod.findOne = async (query) => {
    if (query.store && query.monthKey) {
      return subscriptionPeriods.get(subscriptionKey(query.store, query.monthKey)) || null;
    }
    return null;
  };

  StoreSubscriptionPeriod.create = async (doc) => {
    const key = subscriptionKey(doc.store, doc.monthKey);
    if (subscriptionPeriods.has(key)) {
      const err = new Error("duplicate subscription period");
      err.code = 11000;
      throw err;
    }
    const row = { ...doc, _id: new mongoose.Types.ObjectId() };
    subscriptionPeriods.set(key, row);
    return row;
  };
}

test("findOrCreateCountingPeriod resolves E11000 by re-fetching the existing period", async () => {
  resetBillingMocks();

  let upsertCalls = 0;
  const originalUpsert = DeliveryCompanyBillingPeriod.findOneAndUpdate;
  DeliveryCompanyBillingPeriod.findOneAndUpdate = async (query, update) => {
    if (query.deliveryCompany && query.monthKey && update?.$setOnInsert) {
      upsertCalls += 1;
      if (upsertCalls === 1) {
        const id = new mongoose.Types.ObjectId();
        const period = { ...update.$setOnInsert, _id: id };
        periods.set(String(id), period);
        periods.set(periodKey(query.deliveryCompany, query.monthKey), period);
        return period;
      }
      const err = new Error("duplicate billing period");
      err.code = 11000;
      throw err;
    }
    return originalUpsert(query, update);
  };

  const [first, second] = await Promise.all([
    findOrCreateCountingPeriod(companyId, "2026-08"),
    findOrCreateCountingPeriod(companyId, "2026-08"),
  ]);

  assert.equal(String(first._id), String(second._id));
  assert.ok(periods.get(periodKey(companyId, "2026-08")));
});

test("concurrent period creation with two handovers increments deliveredOrderCount exactly twice", async () => {
  resetBillingMocks();

  let upsertCalls = 0;
  DeliveryCompanyBillingPeriod.findOneAndUpdate = async (query, update) => {
    if (query.deliveryCompany && query.monthKey && update?.$setOnInsert) {
      upsertCalls += 1;
      if (upsertCalls > 1) {
        const err = new Error("duplicate billing period");
        err.code = 11000;
        throw err;
      }
      const id = new mongoose.Types.ObjectId();
      const period = { ...update.$setOnInsert, _id: id };
      periods.set(String(id), period);
      periods.set(periodKey(query.deliveryCompany, query.monthKey), period);
      return period;
    }
    return null;
  };

  const handoverAt = new Date("2026-08-15T10:00:00Z");
  const [first, second] = await Promise.all([
    incrementHandoverCount(companyId, handoverAt),
    incrementHandoverCount(companyId, handoverAt),
  ]);

  assert.equal(first.incremented, true);
  assert.equal(second.incremented, true);

  const period = periods.get(periodKey(companyId, "2026-08"));
  assert.equal(period.deliveredOrderCount, 2);
  assert.equal(billingIncrementCalls, 2);
});

test("same order handed over twice increments billing counter only once", async () => {
  resetBillingMocks();
  resetHandoverMocks();

  const first = await recordStoreHandoverToDeliveryCompany(orderId, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  const second = await recordStoreHandoverToDeliveryCompany(orderId, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });

  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false);
  assert.ok(["already_recorded", "duplicate"].includes(second.reason));

  const period = periods.get(periodKey(companyId, "2026-08"));
  assert.ok(period);
  assert.equal(period.deliveredOrderCount, 1);
  assert.equal(billingIncrementCalls, 1);
});

test("concurrent duplicate handover create (E11000) does not increment billing twice", async () => {
  resetBillingMocks();
  resetHandoverMocks();

  const results = await Promise.all([
    recordStoreHandoverToDeliveryCompany(orderId, { previousStatus: REQUIRED_PREVIOUS_STATUS }),
    recordStoreHandoverToDeliveryCompany(orderId, { previousStatus: REQUIRED_PREVIOUS_STATUS }),
  ]);

  const recordedCount = results.filter((r) => r.recorded).length;
  const duplicateCount = results.filter((r) => !r.recorded).length;
  assert.equal(recordedCount, 1);
  assert.equal(duplicateCount, 1);

  const period = periods.get(periodKey(companyId, "2026-08"));
  assert.ok(period);
  assert.equal(period.deliveredOrderCount, 1);
  assert.equal(billingIncrementCalls, 1);
});

test("retry after failed billing increment recovers company count without double-counting", async () => {
  resetBillingMocks();
  resetHandoverMocks();

  let failIncrements = true;
  const originalUpdateOne = DeliveryCompanyBillingPeriod.updateOne;
  DeliveryCompanyBillingPeriod.updateOne = async (query, update) => {
    if (update.$inc?.deliveredOrderCount && failIncrements) {
      return { modifiedCount: 0 };
    }
    return originalUpdateOne(query, update);
  };

  const first = await recordStoreHandoverToDeliveryCompany(orderId, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  assert.equal(first.recorded, true);
  assert.equal(first.billingApplied, false);

  const periodAfterFailure = periods.get(periodKey(companyId, "2026-08"));
  assert.equal(periodAfterFailure?.deliveredOrderCount || 0, 0);
  assert.equal(handoverRecords.get(String(orderId))?.billingCountApplied, false);

  failIncrements = false;

  const retry = await recordStoreHandoverToDeliveryCompany(orderId, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  assert.equal(retry.recorded, false);
  assert.equal(retry.reason, "already_recorded");
  assert.equal(retry.billingRecovered, true);

  const period = periods.get(periodKey(companyId, "2026-08"));
  assert.equal(period.deliveredOrderCount, 1);
  assert.equal(billingIncrementCalls, 1);
  assert.equal(handoverRecords.get(String(orderId))?.billingCountApplied, true);

  DeliveryCompanyBillingPeriod.updateOne = originalUpdateOne;
});

test("handover to company A does not increment company B billing period", async () => {
  resetBillingMocks();
  resetHandoverMocks();

  const companyB = new mongoose.Types.ObjectId();
  const orderB = new mongoose.Types.ObjectId();
  const sessionB = new mongoose.Types.ObjectId();

  Order.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: orderB,
        status: HANDOVER_STATUS,
        deliveryGroup: sessionB,
        statusTimeline: [{ status: HANDOVER_STATUS, at: new Date("2026-08-16T10:00:00Z") }],
      }),
    }),
  });

  DeliverySession.findById = () => ({
    select: () => ({
      lean: async () => ({ deliveryCompany: companyB }),
    }),
  });

  await recordStoreHandoverToDeliveryCompany(orderB, { previousStatus: REQUIRED_PREVIOUS_STATUS });

  assert.ok(periods.get(periodKey(companyB, "2026-08")));
  assert.equal(periods.get(periodKey(companyB, "2026-08")).deliveredOrderCount, 1);
  assert.equal(periods.get(periodKey(companyId, "2026-08"))?.deliveredOrderCount || 0, 0);
});

test("concurrent store subscription period creation resolves to one document", async () => {
  resetSubscriptionMocks();

  const monthKey = "2026-08";
  const cardConfig = { digital: { quantity: 1, pointsPerCard: 1 }, paper: { quantity: 0, pointsPerCard: 1 } };

  let createCalls = 0;
  const originalCreate = StoreSubscriptionPeriod.create;
  StoreSubscriptionPeriod.create = async (doc) => {
    createCalls += 1;
    if (createCalls > 1) {
      const err = new Error("duplicate subscription period");
      err.code = 11000;
      throw err;
    }
    return originalCreate(doc);
  };

  const insertFields = {
    status: SUBSCRIPTION_STATUSES.PAYMENT_PENDING,
    cardConfig,
  };

  const [first, second] = await Promise.all([
    storeSubscriptionService.findOrCreateStoreSubscriptionPeriod(storeId, monthKey, insertFields),
    storeSubscriptionService.findOrCreateStoreSubscriptionPeriod(storeId, monthKey, insertFields),
  ]);

  assert.equal(String(first._id), String(second._id));
  assert.equal(subscriptionPeriods.size, 1);
  assert.equal(first.status, SUBSCRIPTION_STATUSES.PAYMENT_PENDING);
});

test.after(() => {
  setTimeout(() => process.exit(0), 50);
});

console.log("billingConcurrency.test.js — all tests registered");
