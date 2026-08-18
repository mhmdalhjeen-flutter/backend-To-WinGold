/**
 * Store QR onboard — run with:
 * node --test --test-force-exit tests/storeQrOnboard.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Store = require("../src/models/store");
const User = require("../src/models/user");
const StoreMembership = require("../src/models/storeMembership");
const {
  ensureFollowStore,
  ensureMemberFromQr,
  applyStoreQrOnboard,
} = require("../src/services/storeQrOnboard.service");

const originalStoreFindById = Store.findById;
const originalStoreUpdateOne = Store.updateOne;
const originalUserFindById = User.findById;
const originalUserUpdateOne = User.updateOne;
const originalMembershipFindOne = StoreMembership.findOne;
const originalMembershipCreate = StoreMembership.create;

function restore() {
  Store.findById = originalStoreFindById;
  Store.updateOne = originalStoreUpdateOne;
  User.findById = originalUserFindById;
  User.updateOne = originalUserUpdateOne;
  StoreMembership.findOne = originalMembershipFindOne;
  StoreMembership.create = originalMembershipCreate;
}

const userId = new mongoose.Types.ObjectId();
const storeId = new mongoose.Types.ObjectId();

test("ensureFollowStore is a no-op when already following", async () => {
  User.findById = () => ({
    select: async () => ({
      followedStores: [storeId],
      storeNotificationOptOut: [],
      role: "customer",
    }),
  });
  let updated = false;
  User.updateOne = async () => {
    updated = true;
  };

  const result = await ensureFollowStore(userId, storeId, "customer");
  assert.equal(result.followed, true);
  assert.equal(result.alreadyFollowed, true);
  assert.equal(updated, false);
  restore();
});

test("ensureFollowStore uses $addToSet and does not toggle unfollow", async () => {
  User.findById = () => ({
    select: async () => ({
      followedStores: [],
      storeNotificationOptOut: [storeId],
      role: "customer",
    }),
  });
  let update = null;
  User.updateOne = async (_query, payload) => {
    update = payload;
  };

  const result = await ensureFollowStore(userId, storeId, "customer");
  assert.equal(result.followed, true);
  assert.equal(result.alreadyFollowed, false);
  assert.ok(update.$addToSet.followedStores);
  assert.equal(String(update.$pull.storeNotificationOptOut), String(storeId));
  restore();
});

test("ensureMemberFromQr does not create a second membership", async () => {
  StoreMembership.findOne = async () => ({
    status: "member",
    user: userId,
    store: storeId,
  });
  let created = false;
  StoreMembership.create = async () => {
    created = true;
  };

  const result = await ensureMemberFromQr(userId, storeId);
  assert.equal(result.alreadyMember, true);
  assert.equal(created, false);
  restore();
});

test("applyStoreQrOnboard rejects missing store", async () => {
  Store.findById = async () => null;
  await assert.rejects(
    () => applyStoreQrOnboard({ userId, storeId, role: "customer" }),
    (err) => err.status === 404,
  );
  restore();
});

test("applyStoreQrOnboard continues when follow fails", async () => {
  Store.findById = async () => ({ _id: storeId, isActive: true, subscriptionActive: true });
  let findCalls = 0;
  User.findById = () => ({
    select: async () => {
      findCalls += 1;
      if (findCalls === 1) throw new Error("follow failed");
      return { followedStores: [] };
    },
  });
  StoreMembership.findOne = async () => ({
    status: "member",
    user: userId,
    store: storeId,
  });

  const result = await applyStoreQrOnboard({ userId, storeId, role: "customer" });
  assert.ok(result.errors.includes("follow"));
  assert.equal(result.membershipStatus, "member");
  restore();
});
