/**
 * Store handover → out_for_delivery transition — run with:
 * node tests/deliverySessionHandover.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DeliverySession = require("../src/models/deliverySession");
const DeliveryCompany = require("../src/models/deliveryCompany");
const Order = require("../src/models/order");

require("../src/services/deliveryCompanyBillingNotification.service").notifyBillingRequired = async () => {};
require("../src/services/deliveryNotification.service").dispatchStatusChange = async () => {};

const servicePath = require.resolve("../src/services/deliverySession.service");
delete require.cache[servicePath];

const {
  syncAfterStoreHandover,
} = require("../src/services/deliverySession.service");
const { SESSION_STATUSES } = require("../src/constants/deliverySession.constants");

const companyId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const orderId2 = new mongoose.Types.ObjectId();
const sessionId = new mongoose.Types.ObjectId();
const driverId = new mongoose.Types.ObjectId();

const sessions = new Map();

function makeSession({
  id = sessionId,
  status = SESSION_STATUSES.DRIVER_ASSIGNED,
  orders = [orderId],
  storeStops = [{ order: orderId, collectionStatus: "pending", orderStatus: "ready_for_driver_pickup" }],
} = {}) {
  const doc = {
    _id: id,
    deliveryCompany: companyId,
    status,
    statusTimeline: [{ status, at: new Date() }],
    assignedDriver: { driverId, name: "Driver" },
    orders,
    storeStops: storeStops.map((s) => ({ ...s })),
    markModified() {},
    save: async function save() {
      sessions.set(String(this._id), this);
      return this;
    },
  };
  sessions.set(String(id), doc);
  return doc;
}

function mockOrder(id, status, deliveryGroup = sessionId) {
  return {
    _id: id,
    status,
    deliveryGroup,
    deliveryMethod: "delivery",
    store: new mongoose.Types.ObjectId(),
  };
}

DeliverySession.findById = async (id) => sessions.get(String(id)) || null;

DeliveryCompany.findById = () => ({
  select: () => ({
    lean: async () => ({ _id: companyId, name: "Co", phone: "0599", whatsapp: "0599" }),
  }),
});

Order.findById = (id) => ({
  select: () => ({
    lean: async () => {
      const orders = {
        [String(orderId)]: mockOrder(orderId, "delivery_handover_complete"),
        [String(orderId2)]: mockOrder(orderId2, "ready_for_driver_pickup"),
      };
      return orders[String(id)] || null;
    },
  }),
});

Order.find = (query) => ({
  select: () => ({
    lean: async () => {
      const ids = (query._id?.$in || []).map(String);
      const all = {
        [String(orderId)]: mockOrder(orderId, "delivery_handover_complete"),
        [String(orderId2)]: mockOrder(orderId2, "ready_for_driver_pickup"),
      };
      return ids.map((id) => all[id]).filter(Boolean);
    },
  }),
});

test("single-order store handover immediately sets session to out_for_delivery", async () => {
  sessions.clear();
  makeSession();

  await syncAfterStoreHandover(mockOrder(orderId, "delivery_handover_complete"));

  const session = sessions.get(String(sessionId));
  assert.equal(session.status, SESSION_STATUSES.OUT_FOR_DELIVERY);
});

test("store handover advances when orders exist only on storeStops (not doc.orders)", async () => {
  sessions.clear();
  makeSession({
    orders: [],
    storeStops: [{ order: orderId, collectionStatus: "pending", orderStatus: "ready_for_driver_pickup" }],
  });

  await syncAfterStoreHandover(mockOrder(orderId, "delivery_handover_complete"));

  const session = sessions.get(String(sessionId));
  assert.equal(session.status, SESSION_STATUSES.OUT_FOR_DELIVERY);
});

test("committed handover order advances session even when DB re-fetch is stale", async () => {
  sessions.clear();
  makeSession();

  Order.findById = () => ({
    select: () => ({
      lean: async () => mockOrder(orderId, "ready_for_driver_pickup"),
    }),
  });

  await syncAfterStoreHandover(mockOrder(orderId, "delivery_handover_complete"));

  const session = sessions.get(String(sessionId));
  assert.equal(session.status, SESSION_STATUSES.OUT_FOR_DELIVERY);
  assert.equal(session.storeStops[0].orderStatus, "delivery_handover_complete");
  assert.equal(session.storeStops[0].collectionStatus, "collected");
});

test("multi-order session stays assigned until every order is handed over", async () => {
  sessions.clear();
  const multiSessionId = new mongoose.Types.ObjectId();
  makeSession({
    id: multiSessionId,
    orders: [orderId, orderId2],
    storeStops: [
      { order: orderId, collectionStatus: "pending", orderStatus: "ready_for_driver_pickup" },
      { order: orderId2, collectionStatus: "pending", orderStatus: "ready_for_driver_pickup" },
    ],
  });

  Order.findById = (id) => ({
    select: () => ({
      lean: async () => {
        if (String(id) === String(orderId)) {
          return mockOrder(orderId, "delivery_handover_complete", multiSessionId);
        }
        if (String(id) === String(orderId2)) {
          return mockOrder(orderId2, "ready_for_driver_pickup", multiSessionId);
        }
        return null;
      },
    }),
  });

  await syncAfterStoreHandover(mockOrder(orderId, "delivery_handover_complete", multiSessionId));

  const session = sessions.get(String(multiSessionId));
  assert.equal(session.status, SESSION_STATUSES.DRIVER_ASSIGNED);
});
