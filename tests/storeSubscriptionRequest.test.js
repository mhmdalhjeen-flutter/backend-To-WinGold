/**
 * Store subscription admin request cycle — run with: node tests/storeSubscriptionRequest.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Store = require("../src/models/store");
const StoreSubscriptionPeriod = require("../src/models/storeSubscriptionPeriod");
const {
  SUBSCRIPTION_STATUSES,
  DEFAULT_SUBSCRIPTION_CARD_CONFIG,
} = require("../src/constants/storeSubscription.constants");

require("../src/services/storeCardInventory.service").addCardsToStore = async () => ({});
require("../src/services/storeCardInventory.service").removeSubscriptionDigitalCards = async () => {};
require("../src/services/storeCardInventory.service").removeSubscriptionPaperCodes = async () => {};
require("../src/models/promoCode").insertMany = async (rows) => rows.map(() => ({ _id: new mongoose.Types.ObjectId() }));
require("../src/utils/storeSubscriptionPayment.util").parseSubscriptionPaymentSubmission = async () => ({
  paymentMethod: "bank_palestine",
  transferInformation: { senderName: "Ali", contactNumber: "059", referenceNumber: "1", note: "" },
  paymentProof: "",
  paymentProofImage: "",
});

const {
  requestSubscriptionForStore,
  requestStoreSubscriptions,
  submitSubscriptionPayment,
  approveSubscriptionPayment,
  rejectSubscriptionPayment,
  exemptStoreForMonth,
  getStoreSubscriptionStatus,
  blocksStoreAccess,
  needsSubscriptionPayment,
  isOperationalStatus,
  findOrCreateCountingPeriod,
} = require("../src/services/storeSubscription.service");

const storeId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const periods = new Map();
const stores = new Map();

function periodKey(store, monthKey) {
  return `${String(store)}:${monthKey}`;
}

function resetState() {
  periods.clear();
  stores.set(String(storeId), {
    _id: storeId,
    name: "Test Store",
    isActive: true,
    subscriptionActive: true,
    codePrefix: "TST",
    subscriptionCardConfig: {
      digital: { quantity: 50, pointsPerCard: 2 },
      paper: { quantity: 150, pointsPerCard: 1 },
    },
  });
}

function attachSave(row) {
  row.save = async function save() {
    periods.set(String(this._id), this);
    periods.set(periodKey(this.store, this.monthKey), this);
    return this;
  };
  return row;
}

Store.findById = (id) => {
  const store = stores.get(String(id));
  if (!store) {
    return {
      select: () => ({ lean: async () => null }),
    };
  }
  return {
    select: () => ({ lean: async () => store }),
    markModified() {},
    save: async () => store,
    ...store,
  };
};

Store.find = () => ({
  select: () => ({
    sort: () => ({
      lean: async () => Array.from(stores.values()).filter((row) => row.isActive !== false),
    }),
  }),
});

function buildFindOneQuery(run) {
  const query = {
    sort: () => query,
    lean: () => query,
    select: () => query,
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  };
  return query;
}

StoreSubscriptionPeriod.findOne = (query) => buildFindOneQuery(async () => {
  if (query._id) return periods.get(String(query._id)) || null;
  if (query.store && query.monthKey) {
    return periods.get(periodKey(query.store, query.monthKey)) || null;
  }
  if (query.store && query.status === SUBSCRIPTION_STATUSES.COUNTING && query.expiredAt === null && !query.monthKey) {
    const rows = Array.from(periods.values())
      .filter((row) => String(row.store) === String(query.store)
        && row.status === SUBSCRIPTION_STATUSES.COUNTING
        && !row.expiredAt)
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
    return rows[0] || null;
  }
  if (query.store && query.status?.$in && query.expiredAt === null) {
    const rows = Array.from(periods.values())
      .filter((row) => String(row.store) === String(query.store)
        && query.status.$in.includes(row.status)
        && !row.expiredAt)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey));
    return rows[0] || null;
  }
  if (query.store && query.expiredAt === null && query.monthKey?.$gt) {
    const rows = Array.from(periods.values())
      .filter((row) => String(row.store) === String(query.store)
        && row.monthKey > query.monthKey.$gt
        && !row.expiredAt);
    return rows[0] || null;
  }
  if (query.store && query.expiredAt === null && !query.status && !query.monthKey) {
    const rows = Array.from(periods.values())
      .filter((row) => String(row.store) === String(query.store) && !row.expiredAt)
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
    return rows[0] || null;
  }
  return null;
});

StoreSubscriptionPeriod.findById = async (id) => periods.get(String(id)) || null;

StoreSubscriptionPeriod.findOneAndUpdate = async (query, update, opts = {}) => {
  const row = periods.get(String(query._id));
  if (!row) return null;
  if (query.status && row.status !== query.status) return null;
  if (update?.$set) Object.assign(row, update.$set);
  periods.set(String(row._id), row);
  periods.set(periodKey(row.store, row.monthKey), row);
  return opts.new ? row : row;
};

StoreSubscriptionPeriod.create = async (doc) => {
  const key = periodKey(doc.store, doc.monthKey);
  if (periods.has(key)) {
    const err = new Error("duplicate");
    err.code = 11000;
    throw err;
  }
  const row = attachSave({ ...doc, _id: new mongoose.Types.ObjectId(), expiredAt: null });
  periods.set(key, row);
  periods.set(String(row._id), row);
  return row;
};

StoreSubscriptionPeriod.find = (query) => ({
  select: () => ({
    lean: async () => Array.from(periods.values()).filter((row) => {
      if (query.monthKey && row.monthKey !== query.monthKey) return false;
      if (query.status?.$in && !query.status.$in.includes(row.status)) return false;
      if (query.expiredAt === null && row.expiredAt) return false;
      if (query.cardsIssuedAt?.$ne === null && !row.cardsIssuedAt) return false;
      return true;
    }),
  }),
});

test.beforeEach(() => {
  resetState();
});

test("first admin request finalizes counting to awaiting_payment with frozen card config", async () => {
  const counting = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.COUNTING,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), counting);
  periods.set(String(counting._id), counting);

  const result = await requestSubscriptionForStore(storeId);
  assert.equal(result.finalized, true);
  assert.equal(result.monthKey, "2026-08");
  assert.equal(result.status, SUBSCRIPTION_STATUSES.AWAITING_PAYMENT);
  assert.equal(result.cardConfig.digital.quantity, 50);

  const period = periods.get(periodKey(storeId, "2026-08"));
  assert.equal(period.status, SUBSCRIPTION_STATUSES.AWAITING_PAYMENT);
  assert.equal(periods.get(periodKey(storeId, "2026-09")), undefined);
});

test("second admin request stays on same month and returns alreadyRequested", async () => {
  const awaiting = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.AWAITING_PAYMENT,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), awaiting);
  periods.set(String(awaiting._id), awaiting);

  const result = await requestSubscriptionForStore(storeId);
  assert.equal(result.alreadyRequested, true);
  assert.equal(result.monthKey, "2026-08");
  assert.equal(periods.get(periodKey(storeId, "2026-09")), undefined);
});

test("third admin request still does not create next month", async () => {
  const awaiting = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.PAYMENT_PENDING,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), awaiting);
  periods.set(String(awaiting._id), awaiting);

  const result = await requestSubscriptionForStore(storeId);
  assert.equal(result.alreadyRequested, true);
  assert.equal(result.monthKey, "2026-08");
  assert.equal(periods.get(periodKey(storeId, "2026-09")), undefined);
});

test("reject keeps same month and resubmit stays on same month", async () => {
  const pending = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.PAYMENT_PENDING,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), pending);
  periods.set(String(pending._id), pending);

  await rejectSubscriptionPayment(pending._id, adminId, "invalid");
  assert.equal(periods.get(periodKey(storeId, "2026-08")).status, SUBSCRIPTION_STATUSES.PAYMENT_REJECTED);

  const status = await submitSubscriptionPayment(storeId, {});
  assert.equal(status.monthKey, "2026-08");
  assert.equal(status.status, SUBSCRIPTION_STATUSES.PAYMENT_PENDING);
});

test("approve creates next counting cycle only after completion", async () => {
  const pending = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.PAYMENT_PENDING,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), pending);
  periods.set(String(pending._id), pending);

  await approveSubscriptionPayment(pending._id, adminId);
  assert.equal(periods.get(periodKey(storeId, "2026-08")).status, SUBSCRIPTION_STATUSES.ACTIVE);

  const next = periods.get(periodKey(storeId, "2026-09"));
  assert.ok(next);
  assert.equal(next.status, SUBSCRIPTION_STATUSES.COUNTING);
});

test("exemption creates next counting cycle", async () => {
  const awaiting = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.AWAITING_PAYMENT,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), awaiting);
  periods.set(String(awaiting._id), awaiting);

  await exemptStoreForMonth(storeId, adminId, "2026-08");
  assert.equal(periods.get(periodKey(storeId, "2026-08")).status, SUBSCRIPTION_STATUSES.EXEMPTED);
  assert.equal(periods.get(periodKey(storeId, "2026-09")).status, SUBSCRIPTION_STATUSES.COUNTING);
});

test("awaiting_payment blocks portal access flags", async () => {
  assert.equal(blocksStoreAccess(SUBSCRIPTION_STATUSES.AWAITING_PAYMENT), true);
  assert.equal(needsSubscriptionPayment(SUBSCRIPTION_STATUSES.AWAITING_PAYMENT), true);
  assert.equal(isOperationalStatus(SUBSCRIPTION_STATUSES.AWAITING_PAYMENT), false);
});

test("payment_pending allows portal access", async () => {
  assert.equal(isOperationalStatus(SUBSCRIPTION_STATUSES.PAYMENT_PENDING), true);
  assert.equal(blocksStoreAccess(SUBSCRIPTION_STATUSES.PAYMENT_PENDING), false);
});

test("requestStoreSubscriptions reports alreadyExecuted on repeat", async () => {
  const awaiting = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.AWAITING_PAYMENT,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), awaiting);
  periods.set(String(awaiting._id), awaiting);

  const payload = await requestStoreSubscriptions(adminId);
  assert.equal(payload.alreadyExecuted, true);
  assert.deepEqual(payload.finalizedMonths, ["2026-08"]);
});

test("concurrent admin requests resolve to one awaiting_payment period", async () => {
  const counting = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.COUNTING,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), counting);
  periods.set(String(counting._id), counting);

  let finalizeCalls = 0;
  const originalUpdate = StoreSubscriptionPeriod.findOneAndUpdate;
  StoreSubscriptionPeriod.findOneAndUpdate = async (query, update, opts) => {
    if (query.status === SUBSCRIPTION_STATUSES.COUNTING) {
      finalizeCalls += 1;
      if (finalizeCalls > 1) return null;
    }
    return originalUpdate(query, update, opts);
  };

  const [first, second] = await Promise.all([
    requestSubscriptionForStore(storeId),
    requestSubscriptionForStore(storeId),
  ]);

  const finalizedCount = [first, second].filter((row) => row.finalized).length;
  const alreadyCount = [first, second].filter((row) => row.alreadyRequested).length;
  assert.equal(finalizedCount + alreadyCount, 2);
  assert.equal(periods.get(periodKey(storeId, "2026-08")).status, SUBSCRIPTION_STATUSES.AWAITING_PAYMENT);
  assert.equal(periods.get(periodKey(storeId, "2026-09")), undefined);
});

test("getStoreSubscriptionStatus exposes needsPayment for awaiting_payment", async () => {
  const awaiting = attachSave({
    _id: new mongoose.Types.ObjectId(),
    store: storeId,
    monthKey: "2026-08",
    status: SUBSCRIPTION_STATUSES.AWAITING_PAYMENT,
    cardConfig: DEFAULT_SUBSCRIPTION_CARD_CONFIG,
    expiredAt: null,
  });
  periods.set(periodKey(storeId, "2026-08"), awaiting);
  periods.set(String(awaiting._id), awaiting);

  const status = await getStoreSubscriptionStatus(storeId);
  assert.equal(status.needsPayment, true);
  assert.equal(status.awaitingPayment, true);
  assert.equal(status.canOperate, false);
  assert.equal(status.monthKey, "2026-08");
});

test("findOrCreateCountingPeriod is idempotent", async () => {
  const first = await findOrCreateCountingPeriod(storeId, "2026-08", stores.get(String(storeId)));
  const second = await findOrCreateCountingPeriod(storeId, "2026-08", stores.get(String(storeId)));
  assert.equal(String(first._id), String(second._id));
});

test.after(() => {
  setTimeout(() => process.exit(0), 50);
});

console.log("storeSubscriptionRequest.test.js — all tests registered");
