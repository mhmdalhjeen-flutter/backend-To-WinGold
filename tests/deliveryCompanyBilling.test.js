/**
 * Delivery company monthly billing — run with: node tests/deliveryCompanyBilling.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeliveryCompanyBillingPeriod = require("../src/models/deliveryCompanyBillingPeriod");
const DeliveryCompany = require("../src/models/deliveryCompany");
const DeliveryCompanyOrderHandover = require("../src/models/deliveryCompanyOrderHandover");

const {
  BILLING_STATUSES,
  DEFAULT_PRICE_PER_ORDER,
} = require("../src/constants/deliveryBilling.constants");

const {
  incrementHandoverCount,
  finalizePeriodForBilling,
  approveBillingPayment,
  rejectBillingPayment,
  exemptBillingPeriod,
  computeAmountDue,
  findOrCreateCountingPeriod,
  findBillingPeriod,
} = require("../src/services/deliveryCompanyBilling.service");
const { getCurrentMonthKey, addMonthsToMonthKey } = require("../src/utils/subscriptionMonth.util");

require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingRequired = async () => {};
require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingSubmitted = async () => {};
require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingVerified = async () => {};
require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingRejected = async () => {};
require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingExempted = async () => {};

const originalStartSession = mongoose.startSession;
mongoose.startSession = async () => ({
  startTransaction() {},
  async commitTransaction() {},
  async abortTransaction() {},
  endSession() {},
});

const companyId = new mongoose.Types.ObjectId();
const periodId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();

const periods = new Map();
const companies = new Map();
let handoverCount = 0;

const originalPeriodFindOne = DeliveryCompanyBillingPeriod.findOne;
const originalPeriodFindOneAndUpdate = DeliveryCompanyBillingPeriod.findOneAndUpdate;
const originalPeriodUpdateOne = DeliveryCompanyBillingPeriod.updateOne;
const originalPeriodCreate = DeliveryCompanyBillingPeriod.create;
const originalPeriodFind = DeliveryCompanyBillingPeriod.find;
const originalCompanyFindById = DeliveryCompany.findById;
const originalHandoverCount = DeliveryCompanyOrderHandover.countDocuments;

function periodKey(company, monthKey) {
  return `${String(company)}:${monthKey}`;
}

function resetState() {
  periods.clear();
  companies.set(String(companyId), {
    _id: companyId,
    name: "Test Delivery Co",
    pricePerDeliveredOrder: DEFAULT_PRICE_PER_ORDER,
    currency: "ILS",
    isActive: true,
    handedOverOrderCount: 0,
  });
  handoverCount = 0;
}

DeliveryCompany.findById = (id) => ({
  select: () => ({
    lean: async () => companies.get(String(id)) || null,
  }),
});

DeliveryCompanyOrderHandover.countDocuments = async () => handoverCount;

DeliveryCompanyBillingPeriod.findOne = (query) => {
  const exec = async () => {
    if (query._id) return periods.get(String(query._id)) || null;
    if (query.deliveryCompany && query.monthKey && !query.status) {
      return periods.get(periodKey(query.deliveryCompany, query.monthKey)) || null;
    }
    if (query.deliveryCompany && query.monthKey && query.status === BILLING_STATUSES.COUNTING) {
      const row = periods.get(periodKey(query.deliveryCompany, query.monthKey));
      return row?.status === BILLING_STATUSES.COUNTING ? row : null;
    }
    if (query.deliveryCompany && query.status?.$in) {
      for (const p of periods.values()) {
        if (String(p.deliveryCompany) === String(query.deliveryCompany)
          && query.status.$in.includes(p.status)
          && !p.closedAt) {
          return p;
        }
      }
    }
    if (query.deliveryCompany && query.status?.$nin) {
      for (const p of periods.values()) {
        if (String(p.deliveryCompany) === String(query.deliveryCompany)
          && !query.status.$nin.includes(p.status)) {
          return p;
        }
      }
    }
    if (query.deliveryCompany && query.status === BILLING_STATUSES.PAYMENT_REJECTED) {
      for (const p of periods.values()) {
        if (String(p.deliveryCompany) === String(query.deliveryCompany)
          && p.status === BILLING_STATUSES.PAYMENT_REJECTED
          && !p.closedAt) {
          return p;
        }
      }
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

DeliveryCompanyBillingPeriod.find = (query) => ({
  sort: () => ({
    limit: () => ({
      lean: async () => [],
    }),
    lean: async () => [],
  }),
});

DeliveryCompanyBillingPeriod.create = async (docs, _opts) => {
  const rows = Array.isArray(docs) ? docs : [docs];
  return rows.map((doc) => {
    const id = new mongoose.Types.ObjectId();
    const row = { ...doc, _id: id, closedAt: null };
    periods.set(String(id), row);
    periods.set(periodKey(row.deliveryCompany, row.monthKey), row);
    return row;
  });
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

DeliveryCompanyBillingPeriod.findOneAndUpdate = async (query, update, _opts) => {
  if (query.deliveryCompany && query.monthKey && update?.$setOnInsert) {
    let period = periods.get(periodKey(query.deliveryCompany, query.monthKey));
    if (!period) {
      const id = new mongoose.Types.ObjectId();
      period = { ...update.$setOnInsert, _id: id };
      periods.set(String(id), period);
      periods.set(periodKey(period.deliveryCompany, period.monthKey), period);
    }
    return period;
  }

  const period = query._id ? periods.get(String(query._id)) : null;
  if (!period) return null;
  if (query.status?.$in && !query.status.$in.includes(period.status)) return null;
  if (query.status && !query.status.$in && period.status !== query.status) return null;
  if (query.closedAt === null && period.closedAt) return null;
  if (update.$set) Object.assign(period, update.$set);
  return period;
};

test.beforeEach(() => {
  resetState();
});

test("computeAmountDue multiplies count by price", () => {
  assert.equal(computeAmountDue(120, 1), 120);
  assert.equal(computeAmountDue(5, 2.5), 12.5);
});

test("incrementHandoverCount creates counting period and increments", async () => {
  const result = await incrementHandoverCount(companyId, new Date("2026-08-15T10:00:00Z"));
  assert.equal(result.incremented, true);
  assert.equal(result.monthKey, "2026-08");

  const period = periods.get(periodKey(companyId, "2026-08"));
  assert.equal(period.deliveredOrderCount, 1);
  assert.equal(period.status, BILLING_STATUSES.COUNTING);
});

test("incrementHandoverCount does not increment frozen billing period", async () => {
  const frozen = {
    _id: periodId,
    deliveryCompany: companyId,
    monthKey: "2026-08",
    status: BILLING_STATUSES.PAYMENT_PENDING,
    deliveredOrderCount: 10,
    closedAt: null,
  };
  periods.set(String(periodId), frozen);
  periods.set(periodKey(companyId, "2026-08"), frozen);

  const result = await incrementHandoverCount(companyId, new Date("2026-08-20T10:00:00Z"));
  assert.equal(result.incremented, false);
  assert.equal(frozen.deliveredOrderCount, 10);
});

test("finalizePeriodForBilling calculates amount and sets awaiting_payment", async () => {
  handoverCount = 42;
  const period = {
    _id: periodId,
    deliveryCompany: companyId,
    monthKey: "2026-07",
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 0,
    save: async function save() { periods.set(String(this._id), this); },
  };
  periods.set(String(periodId), period);

  const finalized = await finalizePeriodForBilling(period);
  assert.equal(finalized.status, BILLING_STATUSES.AWAITING_PAYMENT);
  assert.equal(finalized.deliveredOrderCount, 42);
  assert.equal(finalized.amountDue, 42);
});

test("approveBillingPayment closes period and starts new counting cycle", async () => {
  const pending = {
    _id: periodId,
    deliveryCompany: companyId,
    monthKey: "2026-07",
    status: BILLING_STATUSES.PAYMENT_PENDING,
    deliveredOrderCount: 10,
    amountDue: 10,
    closedAt: null,
  };
  periods.set(String(periodId), pending);
  periods.set(periodKey(companyId, "2026-07"), pending);

  const approved = await approveBillingPayment(periodId, adminId);
  assert.equal(approved.status, BILLING_STATUSES.PAID);
  assert.ok(approved.closedAt);

  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const newPeriod = periods.get(periodKey(companyId, currentMonthKey));
  assert.ok(newPeriod);
  assert.equal(newPeriod.status, BILLING_STATUSES.COUNTING);
  assert.equal(newPeriod.deliveredOrderCount, 0);
});

test("rejectBillingPayment keeps billing data intact", async () => {
  const pending = {
    _id: periodId,
    deliveryCompany: companyId,
    monthKey: "2026-07",
    status: BILLING_STATUSES.PAYMENT_PENDING,
    deliveredOrderCount: 8,
    amountDue: 8,
    paymentMethod: "bank_palestine",
    closedAt: null,
  };
  periods.set(String(periodId), pending);

  const rejected = await rejectBillingPayment(periodId, adminId, "إيصال غير واضح");
  assert.equal(rejected.status, BILLING_STATUSES.PAYMENT_REJECTED);
  assert.equal(rejected.deliveredOrderCount, 8);
  assert.equal(rejected.amountDue, 8);
  assert.equal(rejected.rejectionReason, "إيصال غير واضح");
  assert.equal(rejected.closedAt, null);
});

test("exemptBillingPeriod closes cycle like approval", async () => {
  const awaiting = {
    _id: periodId,
    deliveryCompany: companyId,
    monthKey: "2026-07",
    status: BILLING_STATUSES.AWAITING_PAYMENT,
    deliveredOrderCount: 3,
    amountDue: 3,
    closedAt: null,
  };
  periods.set(String(periodId), awaiting);
  periods.set(periodKey(companyId, "2026-07"), awaiting);

  const exempted = await exemptBillingPeriod(periodId, adminId);
  assert.equal(exempted.status, BILLING_STATUSES.EXEMPTED);
  assert.ok(exempted.closedAt);
});

test("findOrCreateCountingPeriod is idempotent for same company and month", async () => {
  const first = await findOrCreateCountingPeriod(companyId, "2026-08");
  const second = await findOrCreateCountingPeriod(companyId, "2026-08");
  assert.equal(String(first._id), String(second._id));
  assert.ok(periods.get(periodKey(companyId, "2026-08")));
});

test("closing current month does not create duplicate month document", async () => {
  const currentMonthKey = getCurrentMonthKey();
  const closedPeriod = {
    _id: periodId,
    deliveryCompany: companyId,
    monthKey: currentMonthKey,
    status: BILLING_STATUSES.PAYMENT_PENDING,
    deliveredOrderCount: 5,
    amountDue: 5,
    closedAt: null,
  };
  periods.set(String(periodId), closedPeriod);
  periods.set(periodKey(companyId, currentMonthKey), closedPeriod);

  await approveBillingPayment(periodId, adminId);

  const closed = periods.get(periodKey(companyId, currentMonthKey));
  assert.equal(closed.status, BILLING_STATUSES.PAID);
  assert.ok(closed.closedAt);

  const nextMonthKey = addMonthsToMonthKey(currentMonthKey, 1);
  const nextPeriod = periods.get(periodKey(companyId, nextMonthKey));
  assert.ok(nextPeriod);
  assert.equal(nextPeriod.status, BILLING_STATUSES.COUNTING);
  assert.equal(periods.get(periodKey(companyId, currentMonthKey))._id, closed._id);
});

test.after(() => {
  DeliveryCompanyBillingPeriod.findOne = originalPeriodFindOne;
  DeliveryCompanyBillingPeriod.findOneAndUpdate = originalPeriodFindOneAndUpdate;
  DeliveryCompanyBillingPeriod.updateOne = originalPeriodUpdateOne;
  DeliveryCompanyBillingPeriod.create = originalPeriodCreate;
  DeliveryCompanyBillingPeriod.find = originalPeriodFind;
  DeliveryCompany.findById = originalCompanyFindById;
  DeliveryCompanyOrderHandover.countDocuments = originalHandoverCount;
  mongoose.startSession = originalStartSession;
});

console.log("deliveryCompanyBilling.test.js — all tests registered");
