/**
 * Post-commit order confirm side effects — run with:
 * node --test --test-force-exit tests/orderConfirmPostCommit.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Order = require("../src/models/order");
const Store = require("../src/models/store");
const User = require("../src/models/user");

const callOrder = [];
let txnCommitted = false;
let userUpdateCalls = 0;
let storeSaveOutsideTxn = 0;

const storeCardInventoryPath = require.resolve("../src/services/storeCardInventory.service");
require.cache[storeCardInventoryPath] = {
  id: storeCardInventoryPath,
  filename: storeCardInventoryPath,
  loaded: true,
  exports: {
    consumeStoreCard: async (_storeId, session) => {
      if (session && !txnCommitted) callOrder.push("consumeCard");
      return { cardType: null, pointsValue: 5, remainingCards: 4 };
    },
    restoreStoreCard: async () => null,
  },
};

const membershipPath = require.resolve("../src/services/storeMembership.service");
require.cache[membershipPath] = {
  id: membershipPath,
  filename: membershipPath,
  loaded: true,
  exports: {
    upgradeToMember: async () => {
      callOrder.push("membership");
      if (!txnCommitted) {
        const err = new Error(
          "Write conflict during plan execution and yielding is disabled. Please retry your operation or multi-document transaction.",
        );
        err.code = 112;
        throw err;
      }
      return { status: "member" };
    },
  },
};

const notificationPath = require.resolve("../src/services/notification.service");
require.cache[notificationPath] = {
  id: notificationPath,
  filename: notificationPath,
  loaded: true,
  exports: {
    create: async (payload) => {
      callOrder.push(`notify:${payload.type}`);
      return { _id: new mongoose.Types.ObjectId() };
    },
  },
};

const deliverySessionServicePath = require.resolve("../src/services/deliverySession.service");
const originalSessionExports = require("../src/services/deliverySession.service");
require.cache[deliverySessionServicePath] = {
  id: deliverySessionServicePath,
  filename: deliverySessionServicePath,
  loaded: true,
  exports: {
    ...originalSessionExports,
    syncOrderInSessions: async () => {
      callOrder.push("sync");
    },
    syncAfterStoreHandover: async () => {},
  },
};

const orderServicePath = require.resolve("../src/services/order.service");
delete require.cache[orderServicePath];

const { updateOrderStatus } = require("../src/services/order.service");

const ownerId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const customerId = new mongoose.Types.ObjectId();

const originalStartSession = mongoose.startSession;
const originalOrderFindOne = Order.findOne;
const originalOrderFindOneAndUpdate = Order.findOneAndUpdate;
const originalStoreFindOne = Store.findOne;
const originalStoreFindById = Store.findById;
const originalUserFindByIdAndUpdate = User.findByIdAndUpdate;

function confirmedOrderDoc(status = "store_accepted") {
  return {
    _id: orderId,
    store: storeId,
    customer: customerId,
    status,
    orderNumber: "WG-CONFIRM",
    deliveryMethod: status === "ready_for_delivery_pickup" ? "delivery" : "pickup",
    statusTimeline: [{ status, at: new Date() }],
    rewardPointsAwarded: 5,
    pointsAwarded: true,
    cardDeducted: true,
  };
}

function resetMocks({ delivery = false } = {}) {
  callOrder.length = 0;
  txnCommitted = false;
  userUpdateCalls = 0;
  storeSaveOutsideTxn = 0;

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
      session: () => ({
        then: (resolve) => resolve({
          _id: storeId,
          name: "Test Store",
          cards: 5,
          bypassCards: false,
        }),
      }),
      then: (resolve) => resolve({
        _id: storeId,
        name: "Test Store",
        cards: 5,
        bypassCards: false,
      }),
    }),
  });

  Store.findById = (id) => ({
    select: () => ({
      session: () => ({
        then: (resolve) => resolve({ _id: id, cards: 4, bypassCards: false }),
      }),
      then: (resolve) => resolve({ _id: id, cards: 4, bypassCards: false }),
    }),
    save: async function save() {
      if (!txnCommitted) storeSaveOutsideTxn += 1;
      return this;
    },
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
              customer: customerId,
              status: "pending",
              deliveryMethod: delivery ? "delivery" : "pickup",
              statusTimeline: [],
            };
          }
          return null;
        };
        return exec().then(resolve, reject);
      },
    };
    return chain;
  };

  Order.findOneAndUpdate = (_query, update, opts) => {
    const acceptedStatus = update?.$set?.status || "store_accepted";
    if (opts?.session && !txnCommitted) {
      callOrder.push("orderUpdate");
    }
    return Promise.resolve(confirmedOrderDoc(acceptedStatus));
  };

  User.findByIdAndUpdate = async () => {
    userUpdateCalls += 1;
    return { _id: customerId };
  };
}

test.beforeEach(() => resetMocks());

test("pickup confirm commits before membership upgrade and notifications", async () => {
  const result = await updateOrderStatus(ownerId, orderId, "store_accepted");

  assert.equal(result.order.status, "store_accepted");
  assert.equal(txnCommitted, true);
  assert.equal(userUpdateCalls, 1);
  assert.equal(storeSaveOutsideTxn, 0);
  assert.deepEqual(callOrder, [
    "consumeCard",
    "orderUpdate",
    "commit",
    "notify:order_point_gift",
    "membership",
    "notify:order_confirmed",
    "sync",
  ]);
});

test("delivery confirm sets ready_for_delivery_pickup and runs post-commit side effects", async () => {
  resetMocks({ delivery: true });
  const result = await updateOrderStatus(ownerId, orderId, "confirmed");

  assert.equal(result.order.status, "ready_for_delivery_pickup");
  assert.ok(callOrder.includes("commit"));
  assert.ok(callOrder.indexOf("commit") < callOrder.indexOf("membership"));
  assert.ok(callOrder.includes("notify:order_confirmed"));
});

test("bypassCards path skips card consumption but still confirms", async () => {
  Store.findOne = () => ({
    select: () => ({
      session: () => ({
        then: (resolve) => resolve({
          _id: storeId,
          name: "Bypass Store",
          cards: 0,
          bypassCards: true,
        }),
      }),
      then: (resolve) => resolve({
        _id: storeId,
        name: "Bypass Store",
        cards: 0,
        bypassCards: true,
      }),
    }),
  });

  Order.findOneAndUpdate = (_query, update) => {
    const acceptedStatus = update?.$set?.status || "store_accepted";
    return Promise.resolve({
      ...confirmedOrderDoc(acceptedStatus),
      rewardPointsAwarded: 0,
      pointsAwarded: false,
      cardDeducted: false,
    });
  };

  const result = await updateOrderStatus(ownerId, orderId, "store_accepted");

  assert.equal(result.order.status, "store_accepted");
  assert.equal(userUpdateCalls, 0);
  assert.ok(!callOrder.includes("consumeCard"));
  assert.ok(!callOrder.includes("membership"));
  assert.ok(callOrder.includes("notify:order_confirmed"));
});

test("WriteConflict 112 on commit retries and succeeds without duplicate post-commit writes", async () => {
  let commitAttempts = 0;
  mongoose.startSession = async () => ({
    startTransaction: async () => {},
    commitTransaction: async () => {
      commitAttempts += 1;
      if (commitAttempts === 1) {
        const err = new Error(
          "Write conflict during plan execution and yielding is disabled. Please retry your operation or multi-document transaction.",
        );
        err.code = 112;
        throw err;
      }
      txnCommitted = true;
      callOrder.push("commit");
    },
    abortTransaction: async () => {},
    endSession: async () => {},
  });

  const result = await updateOrderStatus(ownerId, orderId, "store_accepted");

  assert.equal(result.order.status, "store_accepted");
  assert.equal(commitAttempts, 2);
  assert.equal(callOrder.filter((step) => step === "membership").length, 1);
  assert.equal(callOrder.filter((step) => step === "notify:order_confirmed").length, 1);
});

test.after(() => {
  mongoose.startSession = originalStartSession;
  Order.findOne = originalOrderFindOne;
  Order.findOneAndUpdate = originalOrderFindOneAndUpdate;
  Store.findOne = originalStoreFindOne;
  Store.findById = originalStoreFindById;
  User.findByIdAndUpdate = originalUserFindByIdAndUpdate;
  delete require.cache[orderServicePath];
  delete require.cache[storeCardInventoryPath];
  delete require.cache[membershipPath];
  delete require.cache[notificationPath];
  delete require.cache[deliverySessionServicePath];
});

console.log("orderConfirmPostCommit.test.js — all tests registered");
