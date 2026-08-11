const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const User = require("../src/models/user");
const StoreMembership = require("../src/models/storeMembership");
const Notification = require("../src/models/notification");

const {
  getStoreSubscriberUserIds,
  notifyStoreNewProduct,
  notifyStoreNewOffer,
  buildProductNotificationContent,
  buildOfferNotificationContent,
} = require("../src/services/storeSubscriberNotification.service");

const { resolvePushTargetApp, resolveCustomerPushUrl } = require("../src/utils/pushTarget.util");

const notificationService = require("../src/services/notification.service");

const originalCreateMany = notificationService.createMany;
const originalUserFind = User.find;
const originalMembershipFind = StoreMembership.find;
const originalNotificationFindOne = Notification.findOne;

let createManyCalls = [];

function installCreateManySpy() {
  createManyCalls = [];
  notificationService.createMany = async (items) => {
    createManyCalls.push(items);
    return items.map((item) => ({
      _id: new mongoose.Types.ObjectId(),
      ...item,
    }));
  };
}

function restoreSpies() {
  notificationService.createMany = originalCreateMany;
  User.find = originalUserFind;
  StoreMembership.find = originalMembershipFind;
  Notification.findOne = originalNotificationFindOne;
}

function mockSubscribers(userIds = [], memberIds = [], optedOutIds = []) {
  User.find = (query) => {
    if (query?.storeNotificationOptOut) {
      return {
        select: () => ({
          lean: async () => optedOutIds.map((id) => ({ _id: id })),
        }),
      };
    }
    return {
      select: () => ({
        lean: async () => userIds.map((id) => ({ _id: id })),
      }),
    };
  };
  StoreMembership.find = () => ({
    select: () => ({
      lean: async () => memberIds.map((id) => ({ user: id })),
    }),
  });
  Notification.findOne = () => ({
    select: () => ({
      lean: async () => null,
    }),
  });
}

test("resolvePushTargetApp routes store subscriber notifications to customer app", () => {
  assert.equal(resolvePushTargetApp("store_new_product"), "customer");
  assert.equal(resolvePushTargetApp("store_new_offer"), "customer");
});

test("resolveCustomerPushUrl builds product and offer deep links", () => {
  assert.equal(
    resolveCustomerPushUrl("store_new_product", { productId: "p1", storeId: "s1" }),
    "/product/p1",
  );
  assert.equal(
    resolveCustomerPushUrl("store_new_offer", { offerId: "o1", storeId: "s1" }),
    "/offer/o1",
  );
});

test("getStoreSubscriberUserIds unions followedStores and active members without duplicates", async () => {
  const storeId = new mongoose.Types.ObjectId();
  const followedOnly = new mongoose.Types.ObjectId();
  const memberOnly = new mongoose.Types.ObjectId();
  const both = new mongoose.Types.ObjectId();
  const optedOutMember = new mongoose.Types.ObjectId();

  User.find = (query) => {
    if (query.followedStores) {
      assert.equal(String(query.followedStores), String(storeId));
      assert.equal(query.role, "customer");
      return {
        select: () => ({
          lean: async () => [{ _id: followedOnly }, { _id: both }],
        }),
      };
    }
    if (query.storeNotificationOptOut) {
      assert.equal(String(query.storeNotificationOptOut), String(storeId));
      return {
        select: () => ({
          lean: async () => [{ _id: optedOutMember }],
        }),
      };
    }
    return {
      select: () => ({
        lean: async () => [],
      }),
    };
  };

  StoreMembership.find = (query) => {
    assert.equal(String(query.store), String(storeId));
    assert.equal(query.status, "member");
    return {
      select: () => ({
        lean: async () => [
          { user: memberOnly },
          { user: both },
          { user: optedOutMember },
        ],
      }),
    };
  };

  const ids = await getStoreSubscriberUserIds(storeId);
  assert.deepEqual(new Set(ids), new Set([
    String(followedOnly),
    String(memberOnly),
    String(both),
  ]));

  restoreSpies();
});

test("notifyStoreNewProduct sends only to subscribers with correct app payload data", async () => {
  installCreateManySpy();
  const subscriberId = new mongoose.Types.ObjectId();
  mockSubscribers([subscriberId], []);

  const store = { _id: new mongoose.Types.ObjectId(), name: "متجر أ" };
  const product = {
    _id: new mongoose.Types.ObjectId(),
    name: "منتج 1",
    store: store._id,
    isActive: true,
    isWholesale: false,
  };

  const result = await notifyStoreNewProduct(store, product);

  assert.equal(result.sent, 1);
  assert.equal(createManyCalls.length, 1);
  assert.equal(createManyCalls[0].length, 1);
  assert.equal(String(createManyCalls[0][0].user), String(subscriberId));
  assert.equal(createManyCalls[0][0].type, "store_new_product");
  assert.equal(createManyCalls[0][0].data.productId, String(product._id));
  assert.equal(createManyCalls[0][0].data.url, `/product/${product._id}`);
  assert.match(createManyCalls[0][0].title, /متجر أ/);

  restoreSpies();
});

test("notifyStoreNewProduct skips when no subscribers", async () => {
  installCreateManySpy();
  mockSubscribers([], []);

  const result = await notifyStoreNewProduct(
    { _id: new mongoose.Types.ObjectId(), name: "S" },
    { _id: new mongoose.Types.ObjectId(), name: "P", isActive: true, isWholesale: false },
  );

  assert.equal(result.reason, "no_subscribers");
  assert.equal(createManyCalls.length, 0);

  restoreSpies();
});

test("notifyStoreNewProduct skips wholesale and inactive products", async () => {
  installCreateManySpy();
  mockSubscribers([new mongoose.Types.ObjectId()], []);

  const store = { _id: new mongoose.Types.ObjectId(), name: "S" };
  const wholesale = await notifyStoreNewProduct(store, {
    _id: new mongoose.Types.ObjectId(),
    name: "W",
    isActive: true,
    isWholesale: true,
  });
  const inactive = await notifyStoreNewProduct(store, {
    _id: new mongoose.Types.ObjectId(),
    name: "I",
    isActive: false,
    isWholesale: false,
  });

  assert.equal(wholesale.reason, "wholesale");
  assert.equal(inactive.reason, "not_active");
  assert.equal(createManyCalls.length, 0);

  restoreSpies();
});

test("notifyStoreNewOffer deduplicates by offerId", async () => {
  installCreateManySpy();
  mockSubscribers([new mongoose.Types.ObjectId()], []);

  Notification.findOne = () => ({
    select: () => ({
      lean: async () => ({ _id: new mongoose.Types.ObjectId() }),
    }),
  });

  const result = await notifyStoreNewOffer(
    { _id: new mongoose.Types.ObjectId(), name: "متجر ب" },
    { _id: new mongoose.Types.ObjectId(), title: "عرض 1", isActive: true },
  );

  assert.equal(result.reason, "already_notified");
  assert.equal(createManyCalls.length, 0);

  restoreSpies();
});

test("notifyStoreNewOffer sends with correct type and deep link", async () => {
  installCreateManySpy();
  const subscriberId = new mongoose.Types.ObjectId();
  mockSubscribers([subscriberId], []);

  const store = { _id: new mongoose.Types.ObjectId(), name: "Shop" };
  const offer = { _id: new mongoose.Types.ObjectId(), title: "Deal", isActive: true };

  await notifyStoreNewOffer(store, offer);

  assert.equal(createManyCalls[0][0].type, "store_new_offer");
  assert.equal(createManyCalls[0][0].data.url, `/offer/${offer._id}`);

  restoreSpies();
});

test("buildOfferNotificationContent uses customer routes", () => {
  const content = buildOfferNotificationContent(
    { _id: "s1", name: "Shop" },
    { _id: "o1", title: "Deal" },
  );
  assert.equal(content.data.type, "store_new_offer");
  assert.equal(content.data.url, "/offer/o1");
});

test("buildProductNotificationContent uses customer routes", () => {
  const content = buildProductNotificationContent(
    { _id: "s1", name: "Shop" },
    { _id: "p1", name: "Item" },
  );
  assert.equal(content.data.type, "store_new_product");
  assert.equal(content.data.url, "/product/p1");
});
