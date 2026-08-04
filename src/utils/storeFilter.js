const User = require("../models/user");
const Store = require("../models/store");

/** معرّفات أصحاب المحلات (role=store) — يُستبعد role=supplier. */
async function getStoreOwnerIds() {
  return User.find({ role: "store" }).distinct("_id");
}

/** متاجر مرئية للزبون (أصحاب محلات نشطون فقط). */
async function getCustomerVisibleStoreIds(extraQuery = {}) {
  const ownerIds = await getStoreOwnerIds();
  const stores = await Store.find({
    owner: { $in: ownerIds },
    isActive: true,
    subscriptionActive: { $ne: false },
    ...extraQuery,
  }).select("_id");
  return stores.map((s) => s._id);
}

/** يقيّد offerQuery.store لمتاجر الزبون فقط (مع تقاطع أي فلتر سابق). */
async function restrictOfferQueryToCustomerStores(offerQuery, storeQuery = {}) {
  const storeIds = await getCustomerVisibleStoreIds(storeQuery);
  const allowed = storeIds.length ? storeIds : ["__none__"];

  if (offerQuery.store?.$in) {
    const set = new Set(allowed.map(String));
    const intersected = offerQuery.store.$in.filter((id) => set.has(String(id)));
    offerQuery.store.$in = intersected.length ? intersected : ["__none__"];
  } else {
    offerQuery.store = { $in: allowed };
  }
  return offerQuery;
}

module.exports = {
  getStoreOwnerIds,
  getCustomerVisibleStoreIds,
  restrictOfferQueryToCustomerStores,
};
