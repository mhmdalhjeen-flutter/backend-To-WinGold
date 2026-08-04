const StoreMembership = require("../models/storeMembership");
const Store = require("../models/store");

async function getMembership(userId, storeId) {
  return StoreMembership.findOne({ user: userId, store: storeId }).lean();
}

async function joinPending(userId, storeId) {
  const store = await Store.findById(storeId);
  if (!store?.isActive) throw Object.assign(new Error("المتجر غير متاح"), { status: 404 });

  let m = await StoreMembership.findOne({ user: userId, store: storeId });
  if (m?.status === "member") {
    return { membership: m, message: "أنت عضو فعلي في هذا المتجر" };
  }
  if (m) {
    return { membership: m, message: "طلب الانضمام قيد الانتظار — أدخل كوداً من المتجر" };
  }

  m = await StoreMembership.create({ user: userId, store: storeId, status: "pending" });
  return { membership: m, message: "تم تسجيل طلب الانضمام — أدخل كوداً لتفعيل العضوية" };
}

async function upgradeToMember(userId, storeId) {
  const store = await Store.findById(storeId);
  if (!store) return null;

  let m = await StoreMembership.findOne({ user: userId, store: storeId });
  const wasMember = m?.status === "member";

  if (!m) {
    m = await StoreMembership.create({
      user: userId,
      store: storeId,
      status: "member",
      codesRedeemed: 1,
      memberSince: new Date(),
    });
  } else if (m.status !== "member") {
    m.status = "member";
    m.codesRedeemed = (m.codesRedeemed || 0) + 1;
    m.memberSince = m.memberSince || new Date();
    await m.save();
  } else {
    m.codesRedeemed = (m.codesRedeemed || 0) + 1;
    await m.save();
  }

  if (!wasMember) {
    store.customersCount = (store.customersCount || 0) + 1;
    await store.save();
  }

  return m;
}

async function leaveStore(userId, storeId) {
  const m = await StoreMembership.findOne({ user: userId, store: storeId });
  if (!m) return null;
  if (m.status === "member") {
    const store = await Store.findById(storeId);
    if (store) {
      store.customersCount = Math.max(0, (store.customersCount || 1) - 1);
      await store.save();
    }
  }
  await m.deleteOne();
  return m;
}

module.exports = {
  getMembership,
  joinPending,
  upgradeToMember,
  leaveStore,
};
