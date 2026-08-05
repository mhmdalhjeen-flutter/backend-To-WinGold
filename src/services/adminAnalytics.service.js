const User = require("../models/user");
const Store = require("../models/store");
const Offer = require("../models/offer");
const Product = require("../models/product");
const Order = require("../models/order");
const PromoCode = require("../models/promoCode");
const UserActivity = require("../models/userActivity");
const Region = require("../models/region");
const { REGION_LABELS } = require("../utils/analyticsPeriod.util");

const ORDER_ACTIVE = { status: { $nin: ["cancelled", "rejected"] } };

function regionLabel(key) {
  return REGION_LABELS[key] || key;
}

async function topProductsByViews(start, end, limit = 10) {
  const rows = await UserActivity.aggregate([
    {
      $match: {
        type: "view_product",
        createdAt: { $gte: start, $lte: end },
        targetId: { $ne: null },
      },
    },
    { $group: { _id: "$targetId", views: { $sum: 1 } } },
    { $sort: { views: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "products",
        localField: "_id",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        views: 1,
        name: "$product.name",
        price: "$product.price",
        totalViews: "$product.views",
        ratingAvg: "$product.ratingAvg",
      },
    },
  ]);

  if (rows.length) return rows;

  return Product.find()
    .sort({ views: -1 })
    .limit(limit)
    .select("name price views ratingAvg")
    .lean()
    .then((items) =>
      items.map((p) => ({
        _id: p._id,
        name: p.name,
        views: p.views || 0,
        price: p.price,
        totalViews: p.views,
        ratingAvg: p.ratingAvg,
        source: "allTime",
      }))
    );
}

async function topProductsByOrders(start, end, limit = 10) {
  return Order.aggregate([
    { $match: { ...ORDER_ACTIVE, createdAt: { $gte: start, $lte: end } } },
    { $unwind: "$items" },
    { $match: { "items.itemType": "Product" } },
    {
      $group: {
        _id: "$items.item",
        orders: { $sum: "$items.quantity" },
        name: { $first: "$items.name" },
        revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
      },
    },
    { $sort: { orders: -1 } },
    { $limit: limit },
  ]);
}

async function topOffersByViews(start, end, limit = 10) {
  const rows = await UserActivity.aggregate([
    {
      $match: {
        type: { $in: ["view_offer", "open_offer"] },
        createdAt: { $gte: start, $lte: end },
        targetId: { $ne: null },
      },
    },
    { $group: { _id: "$targetId", views: { $sum: 1 } } },
    { $sort: { views: -1 } },
    { $limit: limit },
    {
      $lookup: { from: "offers", localField: "_id", foreignField: "_id", as: "offer" },
    },
    { $unwind: { path: "$offer", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        views: 1,
        title: "$offer.title",
        storeViews: "$offer.views",
        ratingAvg: "$offer.ratingAvg",
      },
    },
  ]);

  if (rows.length) return rows;

  return Offer.find()
    .sort({ views: -1 })
    .limit(limit)
    .select("title views ratingAvg")
    .lean()
    .then((items) =>
      items.map((o) => ({
        _id: o._id,
        title: o.title,
        views: o.views || 0,
        source: "allTime",
      }))
    );
}

async function topOffersByOrders(start, end, limit = 10) {
  return Order.aggregate([
    { $match: { ...ORDER_ACTIVE, createdAt: { $gte: start, $lte: end } } },
    { $unwind: "$items" },
    { $match: { "items.itemType": "Offer" } },
    {
      $group: {
        _id: "$items.item",
        orders: { $sum: "$items.quantity" },
        title: { $first: "$items.name" },
        revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
      },
    },
    { $sort: { orders: -1 } },
    { $limit: limit },
  ]);
}

async function topStoresByVisits(start, end, limit = 10) {
  const rows = await UserActivity.aggregate([
    { $match: { type: "visit_store", createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: "$targetId", visits: { $sum: 1 } } },
    { $sort: { visits: -1 } },
    { $limit: limit },
    {
      $lookup: { from: "stores", localField: "_id", foreignField: "_id", as: "store" },
    },
    { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        visits: 1,
        name: "$store.name",
        region: "$store.region",
        totalVisits: "$store.totalVisits",
      },
    },
  ]);

  if (rows.length >= limit) return rows;

  const fallback = await Store.find()
    .sort({ totalVisits: -1 })
    .limit(limit)
    .select("name region totalVisits")
    .lean();

  const seen = new Set(rows.map((r) => String(r._id)));
  fallback.forEach((s) => {
    if (rows.length >= limit || seen.has(String(s._id))) return;
    rows.push({
      _id: s._id,
      visits: 0,
      name: s.name,
      region: s.region,
      totalVisits: s.totalVisits,
    });
  });

  return rows.slice(0, limit);
}

async function topStoresByOrders(start, end, limit = 10) {
  return Order.aggregate([
    { $match: { ...ORDER_ACTIVE, createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: "$store",
        orders: { $sum: 1 },
        revenue: { $sum: "$total" },
        itemsSold: { $sum: { $size: "$items" } },
      },
    },
    { $sort: { orders: -1 } },
    { $limit: limit },
    {
      $lookup: { from: "stores", localField: "_id", foreignField: "_id", as: "store" },
    },
    { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        orders: 1,
        revenue: 1,
        itemsSold: 1,
        name: "$store.name",
        region: "$store.region",
      },
    },
  ]);
}

async function topStoresByPromoCodes(start, end, limit = 10) {
  return PromoCode.aggregate([
    { $match: { store: { $ne: null }, isRegistrationCode: { $ne: true } } },
    { $unwind: "$usedBy" },
    { $match: { "usedBy.usedAt": { $gte: start, $lte: end } } },
    { $group: { _id: "$store", redemptions: { $sum: 1 } } },
    { $sort: { redemptions: -1 } },
    { $limit: limit },
    {
      $lookup: { from: "stores", localField: "_id", foreignField: "_id", as: "store" },
    },
    { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        redemptions: 1,
        name: "$store.name",
        region: "$store.region",
      },
    },
  ]);
}

async function topRatedProducts(limit = 10) {
  return Product.find({ ratingCount: { $gte: 1 }, isActive: { $ne: false } })
    .sort({ ratingAvg: -1, ratingCount: -1 })
    .limit(limit)
    .select("name price ratingAvg ratingCount views store")
    .populate("store", "name region")
    .lean()
    .then((items) =>
      items.map((p) => ({
        _id: p._id,
        name: p.name,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        storeName: p.store?.name,
        region: p.store?.region,
      }))
    );
}

async function topRatedOffers(limit = 10) {
  return Offer.find({ ratingCount: { $gte: 1 }, isActive: { $ne: false } })
    .sort({ ratingAvg: -1, ratingCount: -1 })
    .limit(limit)
    .select("title ratingAvg ratingCount views store")
    .populate("store", "name region")
    .lean()
    .then((items) =>
      items.map((o) => ({
        _id: o._id,
        title: o.title,
        ratingAvg: o.ratingAvg,
        ratingCount: o.ratingCount,
        storeName: o.store?.name,
        region: o.store?.region,
      }))
    );
}

async function ordersByRegion(start, end) {
  return Order.aggregate([
    { $match: { ...ORDER_ACTIVE, createdAt: { $gte: start, $lte: end } } },
    {
      $lookup: { from: "stores", localField: "store", foreignField: "_id", as: "storeDoc" },
    },
    { $unwind: { path: "$storeDoc", preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: "$storeDoc.region",
        orders: { $sum: 1 },
        revenue: { $sum: "$total" },
        label: { $first: "$storeDoc.region" },
      },
    },
    { $sort: { orders: -1 } },
  ]).then((rows) =>
    rows.map((r) => ({
      key: r._id,
      label: regionLabel(r._id) || r._id,
      orders: r.orders,
      revenue: r.revenue,
    }))
  );
}

async function prizeWinsByRegion(_start, _end) {
  return [];
}

async function regionUsageScores(start, end) {
  const scores = {};

  const bump = (key, label, n = 1) => {
    if (!key) return;
    if (!scores[key]) scores[key] = { key, label: label || key, usageCount: 0 };
    scores[key].usageCount += n;
  };

  const [newUsers, visitActs] = await Promise.all([
    User.aggregate([
      { $match: { role: "customer", createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: "$preferences.regionId", count: { $sum: 1 } } },
    ]),
    UserActivity.aggregate([
      {
        $match: {
          type: { $in: ["visit_store", "view_offer", "open_offer", "view_product", "search"] },
          createdAt: { $gte: start, $lte: end },
        },
      },
      { $group: { _id: "$type", count: { $sum: 1 } } },
    ]),
  ]);

  const regionIds = newUsers.map((u) => u._id).filter(Boolean);
  const regionDocs = regionIds.length
    ? await Region.find({ _id: { $in: regionIds } }).lean()
    : [];
  const nameMap = Object.fromEntries(regionDocs.map((r) => [String(r._id), r.name]));

  newUsers.forEach((u) => {
    if (u._id) bump(String(u._id), nameMap[String(u._id)], u.count);
  });

  Object.entries(REGION_LABELS).forEach(([key, label]) => bump(key, label, 0));

  const totalActivity = visitActs.reduce((s, r) => s + r.count, 0);
  return {
    regions: Object.values(scores).sort((a, b) => b.usageCount - a.usageCount),
    totalActivity,
  };
}

/** Heatmap metric by dimension */
async function regionMetricCounts(start, end, dimension = "all") {
  const counts = {};

  const bump = (regionKey, n = 1) => {
    if (!regionKey) return;
    counts[regionKey] = (counts[regionKey] || 0) + n;
  };

  if (dimension === "all" || dimension === "stores") {
    const visits = await UserActivity.find({
      type: "visit_store",
      createdAt: { $gte: start, $lte: end },
    })
      .select("targetId")
      .lean();
    const storeIds = [...new Set(visits.map((v) => String(v.targetId)).filter(Boolean))];
    const stores = storeIds.length
      ? await Store.find({ _id: { $in: storeIds } }).select("region").lean()
      : [];
    const map = Object.fromEntries(stores.map((s) => [String(s._id), s.region]));
    visits.forEach((v) => bump(map[String(v.targetId)], 1));
  }

  if (dimension === "all" || dimension === "offers") {
    const acts = await UserActivity.find({
      type: { $in: ["view_offer", "open_offer", "favorite_offer"] },
      createdAt: { $gte: start, $lte: end },
    })
      .select("targetId")
      .lean();
    const offerIds = [...new Set(acts.map((a) => String(a.targetId)).filter(Boolean))];
    const offers = offerIds.length
      ? await Offer.find({ _id: { $in: offerIds } }).populate("store", "region").lean()
      : [];
    const map = Object.fromEntries(offers.map((o) => [String(o._id), o.store?.region]));
    acts.forEach((a) => bump(map[String(a.targetId)], 1));
  }

  if (dimension === "all" || dimension === "products") {
    const acts = await UserActivity.find({
      type: "view_product",
      createdAt: { $gte: start, $lte: end },
    })
      .select("targetId meta")
      .lean();
    const productIds = [...new Set(acts.map((a) => String(a.targetId)).filter(Boolean))];
    const products = productIds.length
      ? await Product.find({ _id: { $in: productIds } }).populate("store", "region").lean()
      : [];
    const map = Object.fromEntries(
      products.map((p) => [String(p._id), p.store?.region || acts.find((a) => String(a.targetId) === String(p._id))?.meta?.region])
    );
    acts.forEach((a) => bump(map[String(a.targetId)] || a.meta?.region, 1));
  }

  if (dimension === "all" || dimension === "orders") {
    const orderRegions = await ordersByRegion(start, end);
    orderRegions.forEach((r) => bump(r.key, r.orders));
  }

  if (dimension === "all" || dimension === "prizes") {
    const prizeRegions = await prizeWinsByRegion(start, end);
    const dbRegions = await Region.find({
      _id: { $in: prizeRegions.map((p) => p.key).filter((k) => k !== "unknown") },
    }).lean();
    const idToName = Object.fromEntries(dbRegions.map((r) => [String(r._id), r.name]));
    prizeRegions.forEach((p) => {
      const storeRegionKey = Object.entries(REGION_LABELS).find(([, label]) => label === p.label)?.[0];
      bump(storeRegionKey || idToName[p.key] || p.label, p.prizes);
    });
  }

  return counts;
}

async function buildUserPrizeStatsMap(userIds) {
  if (!userIds.length) return {};

  const objIds = userIds.filter(Boolean);
  const [compJoined, drawTotal, honorTotal] = await Promise.all([
    require("../models/competition").aggregate([
      { $unwind: "$participants" },
      { $match: { "participants.user": { $in: objIds } } },
      { $group: { _id: { user: "$participants.user", comp: "$_id" } } },
      { $group: { _id: "$_id.user", count: { $sum: 1 } } },
    ]),
    require("../models/drawBatch").aggregate([
      { $unwind: "$winners" },
      { $match: { "winners.user": { $in: objIds } } },
      { $group: { _id: "$winners.user", count: { $sum: 1 } } },
    ]),
    require("../models/honorBoard").aggregate([
      { $match: { user: { $in: objIds } } },
      { $group: { _id: "$user", count: { $sum: 1 } } },
    ]),
  ]);

  const map = {};
  const ensure = (id) => {
    const key = String(id);
    if (!map[key]) {
      map[key] = {
        competitionsJoined: 0,
        totalPrizesCount: 0,
        hasCompetitionHistory: false,
      };
    }
    return map[key];
  };

  compJoined.forEach((r) => {
    const s = ensure(r._id);
    s.competitionsJoined = r.count;
    s.hasCompetitionHistory = r.count > 0;
  });

  drawTotal.forEach((r) => {
    const s = ensure(r._id);
    s.totalPrizesCount += r.count;
  });

  honorTotal.forEach((r) => {
    const s = ensure(r._id);
    s.totalPrizesCount += r.count;
  });

  return map;
}

module.exports = {
  topProductsByViews,
  topProductsByOrders,
  topOffersByViews,
  topOffersByOrders,
  topStoresByVisits,
  topStoresByOrders,
  topStoresByPromoCodes,
  topRatedProducts,
  topRatedOffers,
  ordersByRegion,
  prizeWinsByRegion,
  regionUsageScores,
  regionMetricCounts,
  buildUserPrizeStatsMap,
  regionLabel,
};
