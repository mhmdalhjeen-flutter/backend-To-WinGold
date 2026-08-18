const Store = require("../models/store");
const User = require("../models/user");
const StoreMembership = require("../models/storeMembership");
const { getMembership } = require("./storeMembership.service");

function isBusinessRole(role) {
  return role === "store" || role === "supplier";
}

async function ensureFollowStore(userId, storeId, role) {
  const user = await User.findById(userId).select("followedStores storeNotificationOptOut role");
  if (!user) {
    throw Object.assign(new Error("المستخدم غير موجود"), { status: 401 });
  }

  const storeIdStr = String(storeId);
  const alreadyFollowed = (user.followedStores || []).some(
    (id) => String(id) === storeIdStr,
  );

  if (alreadyFollowed) {
    return { followed: true, alreadyFollowed: true };
  }

  const update = { $addToSet: { followedStores: storeId } };
  if (!isBusinessRole(role || user.role)) {
    update.$pull = { storeNotificationOptOut: storeId };
  }

  await User.updateOne({ _id: userId }, update);
  return { followed: true, alreadyFollowed: false };
}

async function ensureMemberFromQr(userId, storeId) {
  let membership = await StoreMembership.findOne({ user: userId, store: storeId });

  if (membership?.status === "member") {
    return { membership, alreadyMember: true, upgraded: false };
  }

  let created = false;
  if (!membership) {
    try {
      membership = await StoreMembership.create({
        user: userId,
        store: storeId,
        status: "member",
        codesRedeemed: 0,
        memberSince: new Date(),
      });
      created = true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      membership = await StoreMembership.findOne({ user: userId, store: storeId });
      if (membership?.status === "member") {
        return { membership, alreadyMember: true, upgraded: false };
      }
    }
  }

  let upgraded = false;
  if (membership.status !== "member") {
    membership.status = "member";
    membership.memberSince = membership.memberSince || new Date();
    await membership.save();
    upgraded = true;
  }

  if (created || upgraded) {
    await Store.updateOne(
      { _id: storeId },
      { $inc: { customersCount: 1 } },
    );
  }

  return { membership, alreadyMember: false, upgraded: upgraded || created };
}

async function applyStoreQrOnboard({ userId, storeId, role }) {
  const store = await Store.findById(storeId);
  if (!store || store.isActive === false || store.subscriptionActive === false) {
    throw Object.assign(new Error("المتجر غير موجود"), { status: 404 });
  }

  const result = {
    isFollowing: false,
    alreadyFollowed: false,
    membershipStatus: null,
    alreadyMember: false,
    errors: [],
  };

  try {
    const follow = await ensureFollowStore(userId, storeId, role);
    result.isFollowing = follow.followed;
    result.alreadyFollowed = follow.alreadyFollowed;
  } catch (err) {
    result.errors.push("follow");
  }

  try {
    const member = await ensureMemberFromQr(userId, storeId);
    result.membershipStatus = member.membership?.status || null;
    result.alreadyMember = Boolean(member.alreadyMember);
  } catch (err) {
    result.errors.push("membership");
    const existing = await getMembership(userId, storeId);
    result.membershipStatus = existing?.status || null;
  }

  if (!result.isFollowing) {
    try {
      const user = await User.findById(userId).select("followedStores");
      result.isFollowing = Boolean(
        user?.followedStores?.some((id) => String(id) === String(storeId)),
      );
    } catch {
      /* keep false */
    }
  }

  return result;
}

module.exports = {
  ensureFollowStore,
  ensureMemberFromQr,
  applyStoreQrOnboard,
};
