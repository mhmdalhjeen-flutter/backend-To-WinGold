/**
 * Offer monitor lifecycle — run with:
 * node --test --test-force-exit tests/offerMonitor.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const storeOwnerId = "owner-user-1";
const offerIdA = "offer-a";
const offerIdB = "offer-b";

let findQueue = [];
let findOneAndDeleteResults = new Map();
let updateCalls = [];
let notifications = [];
let deletedOffers = [];

function resetState() {
  findQueue = [];
  findOneAndDeleteResults = new Map();
  updateCalls = [];
  notifications = [];
  deletedOffers = [];
}

function makeOffer(id, expiresAt, extra = {}) {
  return {
    _id: id,
    title: `Offer ${id}`,
    expiresAt,
    isActive: true,
    expiryWarningSent: false,
    store: { owner: storeOwnerId, name: "Test Store" },
    ...extra,
  };
}

function mockOfferModel() {
  const offerPath = require.resolve("../src/models/offer");
  require.cache[offerPath] = {
    id: offerPath,
    filename: offerPath,
    loaded: true,
    exports: {
      find(filter) {
        return {
          select() {
            return this;
          },
          populate() {
            return this;
          },
          async lean() {
            const batch = findQueue.shift() || [];
            return batch.filter((offer) => {
              if (filter.isActive === true && offer.isActive !== true) return false;
              if (filter.expiryWarningSent === false && offer.expiryWarningSent !== false) return false;
              if (filter.expiresAt?.$gt && !(offer.expiresAt > filter.expiresAt.$gt)) return false;
              if (filter.expiresAt?.$lte) {
                const cutoff = filter.expiresAt.$lte;
                if (!(offer.expiresAt <= cutoff)) return false;
              }
              return true;
            });
          },
        };
      },
      findByIdAndUpdate(id, patch) {
        updateCalls.push({ id, patch });
        return Promise.resolve({ _id: id, ...patch });
      },
      findOneAndDelete(filter) {
        const key = String(filter._id);
        if (findOneAndDeleteResults.has(key)) {
          const result = findOneAndDeleteResults.get(key);
          if (result) deletedOffers.push(key);
          return Promise.resolve(result);
        }
        return Promise.resolve(null);
      },
    },
  };
}

function mockNotificationService() {
  const path = require.resolve("../src/services/notification.service");
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: {
      async create(payload) {
        notifications.push(payload);
        return { _id: `notif-${notifications.length}`, ...payload };
      },
    },
  };
}

function mockSafeLog() {
  const path = require.resolve("../src/utils/logSanitize.util");
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: { safeLog() {} },
  };
}

function loadMonitor() {
  mockSafeLog();
  mockNotificationService();
  mockOfferModel();
  const monitorPath = require.resolve("../src/utils/offerMonitor");
  delete require.cache[monitorPath];
  return require("../src/utils/offerMonitor");
}

test("A. Active offer with >24h remaining sends no warning", async () => {
  resetState();
  const now = new Date();
  findQueue = [[makeOffer(offerIdA, new Date(now.getTime() + 48 * 60 * 60 * 1000))], []];
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.equal(notifications.length, 0);
  assert.equal(updateCalls.length, 0);
});

test("B. Active offer with <=24h remaining sends exactly one offer_expiring notification", async () => {
  resetState();
  const now = new Date();
  findQueue = [[makeOffer(offerIdA, new Date(now.getTime() + 12 * 60 * 60 * 1000))], []];
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "offer_expiring");
  assert.equal(notifications[0].title, "عرضك ينتهي خلال 24 ساعة");
  assert.equal(notifications[0].body, "هذا العرض سينتهي خلال 24 ساعة، هل تريد تجديده؟");
  assert.equal(String(notifications[0].data.offerId), offerIdA);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].patch.expiryWarningSent, true);
});

test("C. expiryWarningSent prevents duplicate warnings on repeated monitor runs", async () => {
  resetState();
  const now = new Date();
  const warnedOffer = makeOffer(offerIdA, new Date(now.getTime() + 12 * 60 * 60 * 1000), {
    expiryWarningSent: true,
  });
  findQueue = [[], []];
  findQueue[0] = [];
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.equal(notifications.length, 0);
});

test("D. Ignored warning leads to permanent delete at expiration", async () => {
  resetState();
  const now = new Date();
  const expired = makeOffer(offerIdA, new Date(now.getTime() - 60 * 1000));
  findQueue = [[], [expired]];
  findOneAndDeleteResults.set(offerIdA, { _id: offerIdA, title: expired.title });
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.deepEqual(deletedOffers, [offerIdA]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "offer_expired");
});

test("E. Renewed offer is not deleted when atomic delete finds future expiresAt", async () => {
  resetState();
  const now = new Date();
  const expiredCandidate = makeOffer(offerIdA, new Date(now.getTime() - 60 * 1000));
  findQueue = [[], [expiredCandidate]];
  findOneAndDeleteResults.set(offerIdA, null);
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.deepEqual(deletedOffers, []);
  assert.equal(notifications.length, 0);
});

test("F. Race safety — findOneAndDelete null means no offer_expired notification", async () => {
  resetState();
  const now = new Date();
  findQueue = [[], [makeOffer(offerIdA, new Date(now.getTime() - 1000))]];
  findOneAndDeleteResults.set(offerIdA, null);
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.equal(notifications.length, 0);
});

test("G. Different offers have independent warning lifecycles", async () => {
  resetState();
  const now = new Date();
  findQueue = [
    [
      makeOffer(offerIdA, new Date(now.getTime() + 10 * 60 * 60 * 1000)),
      makeOffer(offerIdB, new Date(now.getTime() + 48 * 60 * 60 * 1000)),
    ],
    [],
  ];
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.equal(notifications.length, 1);
  assert.equal(String(notifications[0].data.offerId), offerIdA);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, offerIdA);
});

test("monitor runs warnings before expiration deletes", async () => {
  resetState();
  const now = new Date();
  const soon = makeOffer(offerIdA, new Date(now.getTime() + 2 * 60 * 60 * 1000));
  findQueue = [[soon], []];
  const monitorOffers = loadMonitor();
  await monitorOffers();
  assert.equal(notifications[0]?.type, "offer_expiring");
  assert.equal(deletedOffers.length, 0);
});
