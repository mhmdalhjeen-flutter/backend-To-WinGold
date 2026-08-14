/**
 * Delivery billing simulation isolation — run with: node tests/deliveryBillingSimulation.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

process.env.ALLOW_DELIVERY_BILLING_SIMULATION = "true";

const DeliveryCompanyBillingPeriod = require("../src/models/deliveryCompanyBillingPeriod");
const DeliveryCompanyBillingSimulation = require("../src/models/deliveryCompanyBillingSimulation");
const DeliveryCompany = require("../src/models/deliveryCompany");
const DeliveryCompanyOrderHandover = require("../src/models/deliveryCompanyOrderHandover");
const { BILLING_STATUSES, DEFAULT_PRICE_PER_ORDER } = require("../src/constants/deliveryBilling.constants");
const { getCurrentMonthKey, addMonthsToMonthKey } = require("../src/utils/subscriptionMonth.util");
const {
  approveBillingPayment,
  rejectBillingPayment,
  exemptBillingPeriod,
  submitBillingPayment,
  computeAmountDue,
  getCompanyBillingStatus,
} = require("../src/services/deliveryCompanyBilling.service");
const {
  startBillingSimulation,
  resetBillingSimulation,
  isBillingSimulationAllowed,
} = require("../src/services/deliveryCompanyBillingSimulation.service");

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
const adminId = new mongoose.Types.ObjectId();
const realPeriodId = new mongoose.Types.ObjectId();

const realPeriods = new Map();
const simPeriods = new Map();
const simulations = new Map();
let handoverCount = 0;

function realKey(company, monthKey) {
  return `real:${company}:${monthKey}`;
}

function simKey(sessionId, company, monthKey) {
  return `sim:${sessionId}:${company}:${monthKey}`;
}

function resetState() {
  realPeriods.clear();
  simPeriods.clear();
  simulations.clear();
  handoverCount = 100;
  const currentMonthKey = getCurrentMonthKey();
  realPeriods.set(String(realPeriodId), {
    _id: realPeriodId,
    deliveryCompany: companyId,
    monthKey: currentMonthKey,
    status: BILLING_STATUSES.COUNTING,
    deliveredOrderCount: 100,
    pricePerOrder: DEFAULT_PRICE_PER_ORDER,
    amountDue: 100,
    currency: "ILS",
    simulationSessionId: null,
    closedAt: null,
  });
  realPeriods.set(realKey(companyId, currentMonthKey), realPeriods.get(String(realPeriodId)));
}

DeliveryCompany.findById = () => ({
  select: () => ({
    lean: async () => ({
      _id: companyId,
      name: "Sim Co",
      pricePerDeliveredOrder: DEFAULT_PRICE_PER_ORDER,
      currency: "ILS",
      handedOverOrderCount: 100,
    }),
  }),
});

DeliveryCompanyOrderHandover.countDocuments = async () => handoverCount;

DeliveryCompanyBillingSimulation.findOne = (query) => {
  const exec = async () => {
    for (const session of simulations.values()) {
      if (query.deliveryCompany && String(session.deliveryCompany) !== String(query.deliveryCompany)) continue;
      if (query.active === true && !session.active) continue;
      return session;
    }
    return null;
  };
  return {
    lean: exec,
    then: (resolve, reject) => exec().then(resolve, reject),
  };
};

DeliveryCompanyBillingSimulation.create = async (doc) => {
  const id = new mongoose.Types.ObjectId();
  const session = { ...doc, _id: id };
  simulations.set(String(id), session);
  return session;
};

DeliveryCompanyBillingSimulation.deleteOne = async (query) => {
  simulations.delete(String(query._id));
  return { deletedCount: 1 };
};

DeliveryCompanyBillingPeriod.create = async (docs) => {
  const rows = Array.isArray(docs) ? docs : [docs];
  return rows.map((doc) => {
    const id = new mongoose.Types.ObjectId();
    const row = { ...doc, _id: id, save: async function save() { return this; } };
    if (row.simulationSessionId) {
      simPeriods.set(String(id), row);
      simPeriods.set(simKey(row.simulationSessionId, row.deliveryCompany, row.monthKey), row);
    } else {
      realPeriods.set(String(id), row);
      realPeriods.set(realKey(row.deliveryCompany, row.monthKey), row);
    }
    return row;
  });
};

DeliveryCompanyBillingPeriod.deleteMany = async (query) => {
  if (query.simulationSessionId) {
    for (const [key, row] of [...simPeriods.entries()]) {
      if (String(row.simulationSessionId) === String(query.simulationSessionId)) {
        simPeriods.delete(key);
      }
    }
  }
  return { deletedCount: 1 };
};

DeliveryCompanyBillingPeriod.findOne = (query) => {
  const exec = async () => {
    if (query._id) {
      return realPeriods.get(String(query._id)) || simPeriods.get(String(query._id)) || null;
    }
    const sessionId = query.simulationSessionId;
    const monthKey = query.monthKey;
    const company = query.deliveryCompany;
    if (sessionId) {
      return simPeriods.get(simKey(sessionId, company, monthKey)) || null;
    }
    if (query.$or) {
      return realPeriods.get(realKey(company, monthKey)) || null;
    }
    if (company && monthKey) {
      return realPeriods.get(realKey(company, monthKey)) || null;
    }
    if (company && query.status?.$in) {
      const pool = sessionId ? simPeriods : realPeriods;
      for (const p of pool.values()) {
        if (String(p.deliveryCompany) === String(company)
          && query.status.$in.includes(p.status)
          && !p.closedAt) {
          return p;
        }
      }
    }
    if (company && query.status === BILLING_STATUSES.PAYMENT_REJECTED) {
      const pool = query.simulationSessionId ? simPeriods : realPeriods;
      for (const p of pool.values()) {
        if (String(p.deliveryCompany) === String(company)
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

DeliveryCompanyBillingPeriod.findOneAndUpdate = async (query, update, _opts) => {
  let period = null;
  if (query._id) period = realPeriods.get(String(query._id)) || simPeriods.get(String(query._id));
  if (!period && query.deliveryCompany && query.monthKey) {
    if (query.simulationSessionId) {
      period = simPeriods.get(simKey(query.simulationSessionId, query.deliveryCompany, query.monthKey));
    } else if (query.$or) {
      period = realPeriods.get(realKey(query.deliveryCompany, query.monthKey));
    }
  }
  if (!period) return null;
  if (query.status?.$in && !query.status.$in.includes(period.status)) return null;
  if (query.status && !query.status.$in && period.status !== query.status) return null;
  if (query.closedAt === null && period.closedAt) return null;
  if (update.$set) Object.assign(period, update.$set);
  return period;
};

DeliveryCompanyBillingPeriod.find = (query) => ({
  sort: () => ({
    limit: () => ({ lean: async () => [] }),
    lean: async () => [],
  }),
  lean: async () => {
    if (query.status && query.monthKey?.$lt) {
      return [...realPeriods.values()].filter((p) => p.status === query.status && !p.simulationSessionId);
    }
    return [];
  },
});

test.beforeEach(() => {
  resetState();
});

test("simulation guard requires env flag", () => {
  assert.equal(isBillingSimulationAllowed(), true);
});

test("simulation enters awaiting_payment correctly", async () => {
  const session = await startBillingSimulation(companyId, adminId);
  const closedMonthKey = getCurrentMonthKey();
  const countingMonthKey = addMonthsToMonthKey(closedMonthKey, 1);
  const bill = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  const counting = simPeriods.get(simKey(session._id, companyId, countingMonthKey));
  assert.equal(bill.status, BILLING_STATUSES.AWAITING_PAYMENT);
  assert.equal(bill.deliveredOrderCount, 100);
  assert.equal(bill.amountDue, computeAmountDue(100, DEFAULT_PRICE_PER_ORDER));
  assert.equal(counting.status, BILLING_STATUSES.COUNTING);
  assert.equal(counting.deliveredOrderCount, 0);
});

test("simulation never changes real billing counters", async () => {
  const currentMonthKey = getCurrentMonthKey();
  const realBefore = realPeriods.get(realKey(companyId, currentMonthKey));
  await startBillingSimulation(companyId, adminId);
  const realAfter = realPeriods.get(realKey(companyId, currentMonthKey));
  assert.equal(realAfter.status, BILLING_STATUSES.COUNTING);
  assert.equal(realAfter.deliveredOrderCount, realBefore.deliveredOrderCount);
});

test("simulation payment_pending works", async () => {
  const session = await startBillingSimulation(companyId, adminId);
  const closedMonthKey = getCurrentMonthKey();
  const bill = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  const submitted = await submitBillingPayment(companyId, {
    paymentMethod: "bank_palestine",
    transferName: "Test",
    transferNumber: "123",
  }, bill._id);
  assert.equal(submitted.status, BILLING_STATUSES.PAYMENT_PENDING);
});

test("simulation rejection works", async () => {
  const session = await startBillingSimulation(companyId, adminId);
  const closedMonthKey = getCurrentMonthKey();
  const bill = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  await submitBillingPayment(companyId, { paymentMethod: "bank_palestine", transferNumber: "1" }, bill._id);
  const pending = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  const rejected = await rejectBillingPayment(pending._id, adminId, "bad proof");
  assert.equal(rejected.status, BILLING_STATUSES.PAYMENT_REJECTED);
});

test("simulation approval works", async () => {
  const session = await startBillingSimulation(companyId, adminId);
  const closedMonthKey = getCurrentMonthKey();
  const bill = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  await submitBillingPayment(companyId, { paymentMethod: "bank_palestine", transferNumber: "1" }, bill._id);
  const pending = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  const paid = await approveBillingPayment(pending._id, adminId);
  assert.equal(paid.status, BILLING_STATUSES.PAID);
  assert.ok(paid.closedAt);
});

test("simulation exemption works", async () => {
  const session = await startBillingSimulation(companyId, adminId);
  const closedMonthKey = getCurrentMonthKey();
  const bill = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  const exempted = await exemptBillingPeriod(bill._id, adminId);
  assert.equal(exempted.status, BILLING_STATUSES.EXEMPTED);
});

test("deleting simulation restores exact real state", async () => {
  const currentMonthKey = getCurrentMonthKey();
  const realBefore = { ...realPeriods.get(realKey(companyId, currentMonthKey)) };
  const session = await startBillingSimulation(companyId, adminId);
  const closedMonthKey = getCurrentMonthKey();
  const bill = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  await submitBillingPayment(companyId, { paymentMethod: "bank_palestine", transferNumber: "1" }, bill._id);
  const pending = simPeriods.get(simKey(session._id, companyId, closedMonthKey));
  await approveBillingPayment(pending._id, adminId);
  await resetBillingSimulation(companyId);
  const realAfter = realPeriods.get(realKey(companyId, currentMonthKey));
  assert.equal(realAfter.status, realBefore.status);
  assert.equal(realAfter.deliveredOrderCount, realBefore.deliveredOrderCount);
  assert.equal(simulations.size, 0);
});

test("simulation cannot start when env disabled", async () => {
  const prev = process.env.ALLOW_DELIVERY_BILLING_SIMULATION;
  process.env.ALLOW_DELIVERY_BILLING_SIMULATION = "false";
  await assert.rejects(
    () => startBillingSimulation(companyId, adminId),
    (err) => err.status === 403,
  );
  process.env.ALLOW_DELIVERY_BILLING_SIMULATION = prev;
});

test.after(() => {
  mongoose.startSession = originalStartSession;
});

console.log("deliveryBillingSimulation.test.js — all tests registered");
