/**
 * Post-commit handover recording — run with:
 * node --test --test-force-exit tests/orderHandoverPostCommit.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Order = require("../src/models/order");
const Store = require("../src/models/store");
const DeliverySession = require("../src/models/deliverySession");

const billingServicePath = require.resolve("../src/services/deliveryCompanyBilling.service");
require.cache[billingServicePath] = {
  id: billingServicePath,
  filename: billingServicePath,
  loaded: true,
  exports: {
    incrementHandoverCount: async () => ({ incremented: true, monthKey: "2026-08" }),
    reconcileCountingPeriodFromLedger: async () => null,
  },
};

const handoverServicePath = require.resolve("../src/services/deliveryCompanyHandover.service");
delete require.cache[handoverServicePath];

const deliverySessionServicePath = require.resolve("../src/services/deliverySession.service");
const originalSessionExports = require("../src/services/deliverySession.service");
require.cache[deliverySessionServicePath] = {
  id: deliverySessionServicePath,
  filename: deliverySessionServicePath,
  loaded: true,
  exports: {
    ...originalSessionExports,
    syncAfterStoreHandover: async () => {
      callOrder.push("sync");
    },
    syncOrderInSessions: async () => {},
  },
};

const orderServicePath = require.resolve("../src/services/order.service");
delete require.cache[orderServicePath];

const { updateOrderStatus } = require("../src/services/order.service");

const ownerId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const sessionId = new mongoose.Types.ObjectId();
const companyId = new mongoose.Types.ObjectId();
const driverId = new mongoose.Types.ObjectId();

const handoverRecords = new Map();
const callOrder = [];
let txnCommitted = false;
let orderUpdateOneCalls = 0;

const originalStartSession = mongoose.startSession;
const originalOrderFindOne = Order.findOne;
const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
const originalOrderUpdateOne = Order.updateOne;
const originalStoreFindOne = Store.findOne;
const originalSessionFindById = DeliverySession.findById;

function handoverOrderDoc() {
  return {
    _id: orderId,
    store: storeId,
    status: "delivery_handover_complete",
    deliveryGroup: sessionId,
    statusTimeline: [
      { status: "ready_for_driver_pickup", at: new Date("2026-08-14T17:29:34.234Z") },
      { status: "delivery_handover_complete", at: new Date("2026-08-14T17:30:58.016Z") },
    ],
    orderNumber: "WG-TEST",
  };
}

function resetMocks() {
  callOrder.length = 0;
  handoverRecords.clear();
  txnCommitted = false;
  orderUpdateOneCalls = 0;

  mongoose.startSession = async () => ({
    startTransaction: async () => {},
    commitTransaction: async () => {
      txnCommitted = true;
      callOrder.push("commit");
    },
    abortTransaction: async () => {},
    endSession: async () => {},
  });

  Store.findOne = () => ({
    select: () => ({
      then: (resolve) => resolve({
        _id: storeId,
        name: "Test Store",
        cards: {},
        bypassCards: false,
      }),
    }),
  });

  Order.findOne = (query) => {
    const chain = {
      session: () => chain,
      then: (resolve, reject) => {
        const exec = async () => {
          if (query._id && query.store) {
            return {
              _id: orderId,
              store: storeId,
              status: "ready_for_driver_pickup",
              deliveryGroup: sessionId,
              statusTimeline: [{ status: "ready_for_driver_pickup", at: new Date() }],
              deliveryMethod: "delivery",
            };
          }
          return null;
        };
        return exec().then(resolve, reject);
      },
    };
    return chain;
  };

  Order.findOneAndUpdate = (_query, _update, opts) => {
    if (opts?.session && !txnCommitted) {
      return Promise.resolve(handoverOrderDoc());
    }
    return Promise.resolve(handoverOrderDoc());
  };

  Order.updateOne = async () => {
    orderUpdateOneCalls += 1;
    if (!txnCommitted) {
      const err = new Error(
        "Write conflict during plan execution and yielding is disabled. Please retry your operation or multi-document transaction.",
      );
      err.code = 112;
      throw err;
    }
    return { acknowledged: true };
  };

  DeliverySession.findById = () => {
    const doc = {
      _id: sessionId,
      deliveryCompany: companyId,
      assignedDriver: { driverId },
      status: "driver_assigned",
    };
    return {
      select: () => ({
        lean: async () => doc,
        then: (resolve) => resolve(doc),
      }),
    };
  };

  const DeliveryCompanyOrderHandover = require("../src/models/deliveryCompanyOrderHandover");
  const DeliveryCompany = require("../src/models/deliveryCompany");

  DeliveryCompanyOrderHandover.findOne = (query) => ({
    select: () => ({
      lean: async () => handoverRecords.get(String(query.order)) || null,
    }),
  });

  DeliveryCompanyOrderHandover.findOneAndUpdate = async (query, update) => {
    const key = String(query.order);
    const row = handoverRecords.get(key);
    if (!row) return null;
    if (query.billingCountApplied?.$ne === true && row.billingCountApplied === true) return null;
    if (update?.$set?.billingCountApplied != null) {
      row.billingCountApplied = update.$set.billingCountApplied;
    }
    return row;
  };

  DeliveryCompanyOrderHandover.updateOne = async (query, update) => {
    const row = handoverRecords.get(String(query.order));
    if (row && update?.$set?.billingCountApplied != null) {
      row.billingCountApplied = update.$set.billingCountApplied;
    }
    return { acknowledged: true };
  };

  DeliveryCompanyOrderHandover.create = async (doc) => {
    callOrder.push("handover");
    handoverRecords.set(String(doc.order), {
      ...doc,
      _id: new mongoose.Types.ObjectId(),
      billingCountApplied: doc.billingCountApplied ?? false,
    });
    return doc;
  };

  DeliveryCompany.updateOne = async () => ({ acknowledged: true });
}

test.beforeEach(() => resetMocks());

test("updateOrderStatus commits before handover recording and creates ledger", async () => {
  const staleOrderFindById = Order.findById;
  Order.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: orderId,
        status: "ready_for_driver_pickup",
        deliveryGroup: sessionId,
        statusTimeline: [{ status: "ready_for_driver_pickup", at: new Date() }],
      }),
    }),
  });

  const result = await updateOrderStatus(ownerId, orderId, "delivery_handover_complete");

  assert.equal(result.order.status, "delivery_handover_complete");
  assert.equal(txnCommitted, true);
  assert.equal(handoverRecords.size, 1);
  assert.equal(orderUpdateOneCalls, 1);
  assert.deepEqual(callOrder, ["commit", "handover", "sync"]);
  assert.equal(handoverRecords.get(String(orderId))?.billingCountApplied, true);

  Order.findById = staleOrderFindById;
});

test("duplicate post-commit handover call does not create a second ledger row", async () => {
  await updateOrderStatus(ownerId, orderId, "delivery_handover_complete");
  const handoverService = require("../src/services/deliveryCompanyHandover.service");
  const second = await handoverService.recordStoreHandoverToDeliveryCompany(orderId, {
    previousStatus: "ready_for_driver_pickup",
    committedOrder: handoverOrderDoc(),
  });

  assert.equal(handoverRecords.size, 1);
  assert.equal(second.recorded, false);
  assert.ok(["already_recorded", "duplicate"].includes(second.reason));
});

test.after(() => {
  mongoose.startSession = originalStartSession;
  Order.findOne = originalOrderFindOne;
  Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
  Order.updateOne = originalOrderUpdateOne;
  Store.findOne = originalStoreFindOne;
  DeliverySession.findById = originalSessionFindById;
  delete require.cache[orderServicePath];
  delete require.cache[handoverServicePath];
  delete require.cache[deliverySessionServicePath];
});

console.log("orderHandoverPostCommit.test.js — all tests registered");
