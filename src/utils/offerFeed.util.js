const User = require("../models/user");
const Store = require("../models/store");
const Category = require("../models/category");

async function getCategoryDescendantIds(categoryId) {
  const all = await Category.find().select("_id parent").lean();
  const ids = [];
  const collect = (id) => {
    ids.push(String(id));
    all
      .filter((c) => String(c.parent || "") === String(id))
      .forEach((child) => collect(child._id));
  };
  collect(categoryId);
  return ids;
}

async function expandCategoryIds(categoryIds) {
  const expanded = new Set();
  for (const id of categoryIds || []) {
    const descendants = await getCategoryDescendantIds(id);
    descendants.forEach((d) => expanded.add(d));
  }
  return [...expanded];
}

/** معرّفات متاجر الشبكة التي يرى مستخدمها عروضاً (حسب الدور والتفضيلات). */
async function resolveNetworkStoreIds(user, myStoreId = null) {
  const role = user.role;
  const followed = (user.followedStores || []).map(String);
  const excludeOwn = myStoreId ? String(myStoreId) : null;

  if (role === "store") {
    if (!followed.length) return [];

    const supplierOwnerIds = await User.find({ role: "supplier" }).distinct("_id");
    const warehouses = await Store.find({
      _id: { $in: followed },
      owner: { $in: supplierOwnerIds },
      isActive: true,
    }).select("_id");

    return warehouses
      .map((s) => String(s._id))
      .filter((id) => id !== excludeOwn);
  }

  if (role === "supplier") {
    const storeOwnerIds = await User.find({ role: "store" }).distinct("_id");
    const or = [];

    if (followed.length) {
      or.push({ _id: { $in: followed } });
    }

    const networkCategoryIds = user.preferences?.networkCategoryIds || [];
    if (networkCategoryIds.length) {
      const expandedIds = await expandCategoryIds(networkCategoryIds);
      if (expandedIds.length) {
        or.push({ categoryId: { $in: expandedIds } });
      }
    }

    if (!or.length) return [];

    const stores = await Store.find({
      owner: { $in: storeOwnerIds },
      isActive: true,
      $or: or,
    }).select("_id");

    return stores
      .map((s) => String(s._id))
      .filter((id) => id !== excludeOwn);
  }

  return [];
}

module.exports = {
  getCategoryDescendantIds,
  expandCategoryIds,
  resolveNetworkStoreIds,
};
