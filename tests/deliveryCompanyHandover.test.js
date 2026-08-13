/**
 * Delivery company handover counting — run with: node tests/deliveryCompanyHandover.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeliveryCompanyOrderHandover = require("../src/models/deliveryCompanyOrderHandover");
const DeliveryCompany = require("../src/models/deliveryCompany");
const DeliverySession = require("../src/models/deliverySession");
const Order = require("../src/models/order");

const billingServicePath = require.resolve("../src/services/deliveryCompanyBilling.service");
require.cache[billingServicePath] = {
  id: billingServicePath,
  filename: billingServicePath,
  loaded: true,
  exports: {
    incrementHandoverCount: async () => ({ incremented: true }),
  },
};

const handoverServicePath = require.resolve("../src/services/deliveryCompanyHandover.service");
delete require.cache[handoverServicePath];

const {
  recordStoreHandoverToDeliveryCompany,
  findHandoverTimestamp,
  HANDOVER_STATUS,
  REQUIRED_PREVIOUS_STATUS,
} = require("../src/services/deliveryCompanyHandover.service");

const companyA = new mongoose.Types.ObjectId();
const companyB = new mongoose.Types.ObjectId();
const order1 = new mongoose.Types.ObjectId();
const order2 = new mongoose.Types.ObjectId();
const order3 = new mongoose.Types.ObjectId();
const sessionA1 = new mongoose.Types.ObjectId();
const sessionB1 = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();

const handoverCounts = new Map();
const handoverRecords = new Map();

const originalHandoverFindOne = DeliveryCompanyOrderHandover.findOne;
const originalHandoverCreate = DeliveryCompanyOrderHandover.create;
const originalOrderFindById = Order.findById;
const originalOrderUpdateOne = Order.updateOne;
const originalSessionFindById = DeliverySession.findById;
const originalCompanyUpdateOne = DeliveryCompany.updateOne;

function resetState() {
  handoverCounts.set(String(companyA), 0);
  handoverCounts.set(String(companyB), 0);
  handoverRecords.clear();
}

function mockOrder(orderId, {
  status = HANDOVER_STATUS,
  deliveryGroup = sessionA1,
  statusTimeline = [{ status: HANDOVER_STATUS, at: new Date("2026-01-15T10:00:00Z") }],
  deliveryCompanyHandoverCompany = null,
} = {}) {
  return {
    _id: orderId,
    status,
    deliveryGroup,
    statusTimeline,
    deliveryCompanyHandoverCompany,
  };
}

DeliveryCompanyOrderHandover.findOne = (query) => ({
  select: () => ({
    lean: async () => handoverRecords.get(String(query.order)) || null,
  }),
});

DeliveryCompanyOrderHandover.create = async (doc) => {
  const key = String(doc.order);
  if (handoverRecords.has(key)) {
    const err = new Error("duplicate");
    err.code = 11000;
    throw err;
  }
  handoverRecords.set(key, { ...doc, _id: new mongoose.Types.ObjectId() });
  return doc;
};

Order.findById = (id) => {
  const orders = {
    [String(order1)]: mockOrder(order1, { deliveryGroup: sessionA1 }),
    [String(order2)]: mockOrder(order2, { deliveryGroup: sessionA1 }),
    [String(order3)]: mockOrder(order3, { deliveryGroup: sessionB1 }),
  };
  const base = orders[String(id)] || null;
  return {
    select: () => ({
      lean: async () => base,
    }),
  };
};

Order.updateOne = async () => ({ acknowledged: true });

DeliverySession.findById = (id) => {
  const sessions = {
    [String(sessionA1)]: { deliveryCompany: companyA },
    [String(sessionB1)]: { deliveryCompany: companyB },
  };
  const session = sessions[String(id)] || null;
  return {
    select: () => ({
      lean: async () => session,
    }),
  };
};

DeliveryCompany.updateOne = async (query, update) => {
  const key = String(query._id);
  if (update?.$inc?.handedOverOrderCount) {
    handoverCounts.set(key, (handoverCounts.get(key) || 0) + update.$inc.handedOverOrderCount);
  }
  if (update?.$set?.handedOverOrderCount != null) {
    handoverCounts.set(key, update.$set.handedOverOrderCount);
  }
  return { acknowledged: true };
};

test("findHandoverTimestamp reads delivery_handover_complete from timeline", () => {
  const at = findHandoverTimestamp([
    { status: "ready_for_driver_pickup", at: new Date("2026-01-15T09:00:00Z") },
    { status: HANDOVER_STATUS, at: new Date("2026-01-15T10:00:00Z") },
  ]);
  assert.equal(at.toISOString(), new Date("2026-01-15T10:00:00Z").toISOString());
});

test("store hands order to Company A → Company A count +1", async () => {
  resetState();
  const result = await recordStoreHandoverToDeliveryCompany(order1, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
    storeId,
    confirmedBy: ownerId,
  });
  assert.equal(result.recorded, true);
  assert.equal(String(result.companyId), String(companyA));
  assert.equal(handoverCounts.get(String(companyA)), 1);
});

test("Company B remains unchanged when order goes to Company A", async () => {
  resetState();
  await recordStoreHandoverToDeliveryCompany(order1, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  assert.equal(handoverCounts.get(String(companyA)), 1);
  assert.equal(handoverCounts.get(String(companyB)), 0);
});

test("repeating the same handover request does not increase count again", async () => {
  resetState();
  const first = await recordStoreHandoverToDeliveryCompany(order1, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  const second = await recordStoreHandoverToDeliveryCompany(order1, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "already_recorded");
  assert.equal(handoverCounts.get(String(companyA)), 1);
});

test("concurrent duplicate handover insert (E11000) is treated as already recorded", async () => {
  resetState();
  const results = await Promise.all([
    recordStoreHandoverToDeliveryCompany(order1, { previousStatus: REQUIRED_PREVIOUS_STATUS }),
    recordStoreHandoverToDeliveryCompany(order1, { previousStatus: REQUIRED_PREVIOUS_STATUS }),
  ]);
  const recorded = results.filter((r) => r.recorded);
  const duplicates = results.filter((r) => !r.recorded);
  assert.equal(recorded.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].reason, "duplicate");
  assert.equal(handoverCounts.get(String(companyA)), 1);
});

test("different order handed to Company A → Company A count +1", async () => {
  resetState();
  await recordStoreHandoverToDeliveryCompany(order1, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  await recordStoreHandoverToDeliveryCompany(order2, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  assert.equal(handoverCounts.get(String(companyA)), 2);
});

test("order handed to Company B → Company B count +1 only", async () => {
  resetState();
  await recordStoreHandoverToDeliveryCompany(order1, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  await recordStoreHandoverToDeliveryCompany(order3, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  assert.equal(handoverCounts.get(String(companyA)), 1);
  assert.equal(handoverCounts.get(String(companyB)), 1);
});

test("does not count when previous status is not ready_for_driver_pickup", async () => {
  resetState();
  const result = await recordStoreHandoverToDeliveryCompany(order1, {
    previousStatus: "ready_for_delivery_pickup",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "invalid_previous_status");
  assert.equal(handoverCounts.get(String(companyA)), 0);
});

test("does not count when order has no delivery session", async () => {
  resetState();
  const orphanOrder = new mongoose.Types.ObjectId();
  Order.findById = () => ({
    select: () => ({
      lean: async () => mockOrder(orphanOrder, { deliveryGroup: null }),
    }),
  });
  const result = await recordStoreHandoverToDeliveryCompany(orphanOrder, {
    previousStatus: REQUIRED_PREVIOUS_STATUS,
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "no_delivery_company");
  Order.findById = (id) => {
    const orders = {
      [String(order1)]: mockOrder(order1, { deliveryGroup: sessionA1 }),
      [String(order2)]: mockOrder(order2, { deliveryGroup: sessionA1 }),
      [String(order3)]: mockOrder(order3, { deliveryGroup: sessionB1 }),
    };
    const base = orders[String(id)] || null;
    return {
      select: () => ({
        lean: async () => base,
      }),
    };
  };
});

test.after(() => {
  DeliveryCompanyOrderHandover.findOne = originalHandoverFindOne;
  DeliveryCompanyOrderHandover.create = originalHandoverCreate;
  Order.findById = originalOrderFindById;
  Order.updateOne = originalOrderUpdateOne;
  DeliverySession.findById = originalSessionFindById;
  DeliveryCompany.updateOne = originalCompanyUpdateOne;
});
