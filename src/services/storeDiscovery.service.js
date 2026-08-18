const StoreMembership = require("../models/storeMembership");
const Store = require("../models/store");
const PromoCode = require("../models/promoCode");
const UserActivity = require("../models/userActivity");
const Region = require("../models/region");
const { getDescendantIds } = require("../utils/region.util");
const { getCustomerVisibleStoreIds } = require("../utils/storeFilter");
const { bayesianRating, freshnessBoost } = require("../utils/ranking.util");
const { applyDisplayPrioritySort, compareDisplayPriority } = require("../utils/displayPriority.util");
const { expandCategoryIds } = require("../utils/offerFeed.util");
const { getCategoryAndDescendantNames } = require("../controllers/category.controller");
const {
  loadActiveStoreCategories,
  buildCategoryIndex,
  buildDisplaySections,
  groupItemsBySection,
  buildParentGroupsFromSections,
  sectionKey,
} = require("../utils/categoryHierarchy.util");

const { resolveStoreMediaFields } = require("../utils/mediaDelivery.util");

function stripBase64Logo(store) {
  return resolveStoreMediaFields(store);
}

const MAX_DISCOVERY_STORES = 2000;

async function applyCategoryIdFilter(query, categoryId) {
  if (!categoryId) return;
  const expandedIds = await expandCategoryIds([categoryId]);
  const names = await getCategoryAndDescendantNames(categoryId);
  const or = [];
  if (expandedIds.length) or.push({ categoryId: { $in: expandedIds } });
  if (names.length) or.push({ category: { $in: names } });
  if (!or.length) return;
  query.$and = query.$and || [];
  query.$and.push(or.length === 1 ? or[0] : { $or: or });
}

async function findAlternateRegionForCategory({ categoryId, excludeRegionId, q } = {}) {
  if (!categoryId) return null;

  const visibleIds = await getCustomerVisibleStoreIds();
  const storeQuery = { _id: { $in: visibleIds }, isActive: true };
  await applyCategoryIdFilter(storeQuery, categoryId);
  if (q?.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    storeQuery.name = rx;
  }

  let excludeSet = new Set();
  if (excludeRegionId) {
    const excludeIds = await getDescendantIds(excludeRegionId);
    excludeSet = new Set(excludeIds.map(String));
  }

  const countByRoot = await Store.aggregate([
    { $match: storeQuery },
    {
      $project: {
        regionId: 1,
        subRegionId: 1,
      },
    },
    ...(excludeRegionId
      ? [{
          $match: {
            regionId: { $ne: null },
            $expr: {
              $and: [
                { $not: { $in: [{ $toString: "$regionId" }, [...excludeSet]] } },
                {
                  $or: [
                    { $eq: ["$subRegionId", null] },
                    { $not: { $in: [{ $toString: "$subRegionId" }, [...excludeSet]] } },
                  ],
                },
              ],
            },
          },
        }]
      : [{ $match: { regionId: { $ne: null } } }]),
    { $group: { _id: "$regionId", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  let entries = countByRoot.map((row) => [String(row._id), row.count]);

  if (!entries.length && excludeRegionId) {
    const fallbackCounts = await Store.aggregate([
      { $match: storeQuery },
      { $match: { regionId: { $ne: null } } },
      { $group: { _id: "$regionId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    entries = fallbackCounts.map((row) => [String(row._id), row.count]);
  }

  if (!entries.length) return null;

  const [regionId, storeCount] = entries[0];
  const region = await Region.findById(regionId).select("name").lean();
  if (!region) return null;

  return {
    region,
    storeCount,
    message: `لا متاجر مطابقة في منطقتك — جرّب «${region.name}» (${storeCount} متجر بنفس النشاط)`,
  };
}

async function getCategoryInterestScores(userId) {
  if (!userId) return {};
  const acts = await UserActivity.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(80)
    .lean();

  const scores = {};
  for (const a of acts) {
    const cat = a.meta?.category;
    if (!cat) continue;
    const w = a.type === "favorite_offer" ? 3 : a.type === "open_offer" || a.type === "visit_store" ? 2 : 1;
    scores[cat] = (scores[cat] || 0) + w;
  }
  return scores;
}

async function getUserPreferredRegion(userId) {
  if (!userId) return null;
  const acts = await UserActivity.find({
    user: userId,
    type: { $in: ["visit_store", "open_offer", "search"] },
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  const regionScore = {};
  for (const a of acts) {
    const r = a.meta?.region;
    if (r) regionScore[r] = (regionScore[r] || 0) + 1;
  }
  const top = Object.entries(regionScore).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function computeStoreScore(store, { interest = {}, preferredRegion = null } = {}) {
  const rating = bayesianRating(store.ratingAvg, store.ratingCount);
  const reviewSignal = Math.log10((store.ratingCount || 0) + 1) * 8;
  const freshness = freshnessBoost(store.createdAt);
  const categoryBoost = (interest[store.category] || 0) * 4;
  const regionBoost = preferredRegion && store.region === preferredRegion ? 12 : 0;
  const activityBoost = Math.log10((store.totalVisits || 0) + (store.codesEntered || 0) + 1) * 3;
  const membersBoost = Math.log10((store.customersCount || 0) + 1) * 2;

  return rating * 22 + reviewSignal + freshness + categoryBoost + regionBoost + activityBoost + membersBoost;
}

async function attachMembershipStatus(stores, userId) {
  if (!userId || !stores.length) {
    return stores.map((s) => ({ ...s, membershipStatus: null }));
  }
  const ids = stores.map((s) => s._id);
  const memberships = await StoreMembership.find({ user: userId, store: { $in: ids } }).lean();
  const map = new Map(memberships.map((m) => [String(m.store), m.status]));
  return stores.map((s) => ({ ...s, membershipStatus: map.get(String(s._id)) || null }));
}

function sortStoresList(stores, ctx) {
  const rankAuto = (list) =>
    [...list].sort((a, b) => {
      const diff = computeStoreScore(b, ctx) - computeStoreScore(a, ctx);
      if (diff !== 0) return diff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

  return applyDisplayPrioritySort(stores, rankAuto);
}

async function browseStores({ userId, region, regionId, category, categoryId, q } = {}) {
  const visibleIds = await getCustomerVisibleStoreIds();
  const query = { _id: { $in: visibleIds }, isActive: true };

  if (regionId) {
    const ids = await getDescendantIds(regionId);
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { regionId: { $in: ids } },
        { subRegionId: { $in: ids } },
      ],
    });
  } else if (region) {
    query.region = region;
  }
  if (categoryId) {
    await applyCategoryIdFilter(query, categoryId);
  } else if (category) {
    query.category = category;
  }
  if (q?.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$and = query.$and || [];
    query.$and.push({ $or: [{ name: rx }, { category: rx }, { description: rx }] });
  }

  const stores = (await Store.find(query)
    .select("name logo region subRegion category categoryId description customersCount ratingAvg ratingCount totalVisits codesEntered createdAt codePrefix regionId subRegionId whatsapp phone address isVerifiedStore displayPriority isOpen")
    .sort({ displayPriority: -1, createdAt: -1 })
    .limit(MAX_DISCOVERY_STORES)
    .lean()).map(stripBase64Logo);

  const interest = await getCategoryInterestScores(userId);
  const preferredRegion = await getUserPreferredRegion(userId);
  const ctx = { interest, preferredRegion };

  const categories = await loadActiveStoreCategories();
  const index = buildCategoryIndex(categories);
  const sections = buildDisplaySections(categories);
  const groupedBySection = groupItemsBySection(
    stores,
    sections,
    index,
    (store) => store
  );

  const sortedStoresBySection = new Map();
  const assignedStoreIds = new Set();
  for (const section of sections) {
    const key = sectionKey(section);
    const sectionStores = groupedBySection.get(key) || [];
    if (!sectionStores.length) continue;
    sectionStores.forEach((store) => assignedStoreIds.add(String(store._id)));
    sortedStoresBySection.set(
      key,
      await attachMembershipStatus(sortStoresList(sectionStores, ctx), userId)
    );
  }

  const uncategorizedStores = stores.filter(
    (store) => !assignedStoreIds.has(String(store._id))
  );
  if (uncategorizedStores.length) {
    sortedStoresBySection.set(
      "uncategorized",
      await attachMembershipStatus(sortStoresList(uncategorizedStores, ctx), userId)
    );
  }

  const parentGroups = buildParentGroupsFromSections(
    sections,
    sortedStoresBySection,
    interest
  ).map((group) => ({
    ...group,
    sections: applyDisplayPrioritySort(
      group.sections,
      (list) => [...list].sort((a, b) => (b.interestScore || 0) - (a.interestScore || 0))
    ),
  }));

  const categoryById = new Map(categories.map((c) => [String(c._id), c]));
  parentGroups.sort((a, b) => {
    const rootA = categoryById.get(String(a.parentCategoryId));
    const rootB = categoryById.get(String(b.parentCategoryId));
    const pri = compareDisplayPriority(rootA || {}, rootB || {});
    if (pri !== 0) return pri;
    return String(a.parentCategory || '').localeCompare(String(b.parentCategory || ''), 'ar');
  });

  if (uncategorizedStores.length) {
    parentGroups.push({
      parentCategoryId: null,
      parentCategory: "أخرى",
      parentCategoryIcon: "",
      sections: [{
        categoryId: null,
        category: "أخرى",
        categoryIcon: "",
        isParentFallback: true,
        interestScore: interest["أخرى"] || 0,
        stores: sortedStoresBySection.get("uncategorized"),
      }],
    });
  }

  const groups = parentGroups.flatMap((group) =>
    group.sections.map((section) => ({
      category: section.category,
      categoryId: section.categoryId,
      parentCategory: group.parentCategory,
      parentCategoryId: group.parentCategoryId,
      isParentFallback: section.isParentFallback,
      interestScore: section.interestScore,
      stores: section.stores,
    }))
  );

  let suggestion = null;
  if (stores.length === 0 && categoryId) {
    suggestion = await findAlternateRegionForCategory({ categoryId, excludeRegionId: regionId, q });
  }

  return { total: stores.length, groups, parentGroups, preferredRegion, suggestion };
}

async function storesByRegions({ q, regionId, categoryId } = {}) {
  const visibleIds = await getCustomerVisibleStoreIds();
  const storeQuery = { _id: { $in: visibleIds }, isActive: true };
  if (q?.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    storeQuery.name = rx;
  }
  if (regionId) {
    const ids = await getDescendantIds(regionId);
    storeQuery.$and = storeQuery.$and || [];
    storeQuery.$and.push({
      $or: [
        { regionId: { $in: ids } },
        { subRegionId: { $in: ids } },
      ],
    });
  }
  if (categoryId) {
    await applyCategoryIdFilter(storeQuery, categoryId);
  }

  const [regions, stores] = await Promise.all([
    Region.find({ isActive: true, parent: null }).sort({ sortOrder: 1, name: 1 }).lean(),
    Store.find(storeQuery)
      .select("name logo region subRegion category ratingAvg ratingCount regionId subRegionId displayPriority createdAt isOpen")
      .sort({ displayPriority: -1, createdAt: -1 })
      .limit(MAX_DISCOVERY_STORES)
      .lean()
      .then((rows) => rows.map(stripBase64Logo)),
  ]);

  const subRegions = await Region.find({ isActive: true, parent: { $ne: null } })
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  const byRegion = regions.map((r) => {
    const mainStores = sortStoresList(
      stores.filter(
        (s) => String(s.regionId) === String(r._id) || s.region === r.name
      ),
      {}
    );
    const subs = subRegions
      .filter((sr) => String(sr.parent) === String(r._id))
      .map((sr) => ({
        region: sr,
        stores: sortStoresList(
          stores.filter(
            (s) => String(s.subRegionId) === String(sr._id) || s.subRegion === sr.name
          ),
          {}
        ),
      }));

    return { region: r, stores: mainStores, subRegions: subs };
  });

  let suggestion = null;
  if (stores.length === 0 && categoryId) {
    suggestion = await findAlternateRegionForCategory({ categoryId, excludeRegionId: regionId, q });
  }

  return { regions: byRegion, total: stores.length, suggestion };
}

/** اقتراح متجر مجاور بنفس التصنيف */
async function suggestNearestStore({ region, category, excludeIds = [] }) {
  const visibleIds = await getCustomerVisibleStoreIds();
  const candidates = (await Store.find({
    _id: { $in: visibleIds.filter((id) => !excludeIds.includes(String(id))) },
    isActive: true,
    category,
  })
    .select("name logo region subRegion category ratingAvg ratingCount isOpen")
    .lean()).map(stripBase64Logo);

  if (!candidates.length) return null;

  const sameRegion = candidates.filter((s) => s.region === region);
  const pool = sameRegion.length ? sameRegion : candidates;
  const ranked = sortStoresList(pool, {});
  return ranked[0];
}

const POINTS_STORE_SELECT =
  "name logo coverImage region subRegion category categoryId description customersCount ratingAvg ratingCount regionId subRegionId isVerifiedStore codePrefix displayPriority createdAt isOpen";

async function getPointsProgramStoreIds() {
  const visibleIds = await getCustomerVisibleStoreIds();
  if (!visibleIds.length) return [];

  const [promoStoreIds, prefixStoreIds] = await Promise.all([
    PromoCode.distinct("store", {
      store: { $in: visibleIds },
      isRegistrationCode: false,
      isActive: true,
      rewardPoints: { $gt: 0 },
    }),
    Store.find({
      _id: { $in: visibleIds },
      isActive: true,
      codePrefix: { $exists: true, $nin: [null, ""] },
    }).distinct("_id"),
  ]);

  const ids = new Set(
    [...promoStoreIds, ...prefixStoreIds]
      .filter(Boolean)
      .map(String)
  );

  return visibleIds.map(String).filter((id) => ids.has(id));
}

async function buildCategoryParentGroupsForStores(stores) {
  if (!stores.length) return [];

  const categories = await loadActiveStoreCategories();
  const index = buildCategoryIndex(categories);
  const sections = buildDisplaySections(categories);
  const groupedBySection = groupItemsBySection(stores, sections, index, (store) => store);
  const sortedStoresBySection = new Map();

  for (const section of sections) {
    const key = sectionKey(section);
    const sectionStores = groupedBySection.get(key) || [];
    if (!sectionStores.length) continue;
    sortedStoresBySection.set(key, sortStoresList(sectionStores, {}));
  }

  return buildParentGroupsFromSections(sections, sortedStoresBySection, {})
    .map((group) => ({
      parentCategoryId: group.parentCategoryId,
      parentCategory: group.parentCategory,
      sections: group.sections
        .filter((section) => (section.stores || []).length > 0)
        .map((section) => ({
          categoryId: section.categoryId,
          categoryName: section.category,
          isParentFallback: section.isParentFallback,
          stores: section.stores,
        })),
    }))
    .filter((group) => group.sections.length > 0 && group.parentCategory !== "أخرى");
}

async function pointsProgramStores({ regionId, q } = {}) {
  const participatingIds = await getPointsProgramStoreIds();
  if (!participatingIds.length) {
    return { total: 0, regions: [] };
  }

  const query = { _id: { $in: participatingIds }, isActive: true };

  if (regionId) {
    const ids = await getDescendantIds(regionId);
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { regionId: { $in: ids } },
        { subRegionId: { $in: ids } },
      ],
    });
  }

  if (q?.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$and = query.$and || [];
    query.$and.push({
      $or: [{ name: rx }, { category: rx }, { description: rx }],
    });
  }

  const stores = (await Store.find(query)
    .select(POINTS_STORE_SELECT)
    .sort({ displayPriority: -1, createdAt: -1 })
    .limit(MAX_DISCOVERY_STORES)
    .lean()).map(stripBase64Logo);

  const rootRegions = await Region.find({ isActive: true, parent: null })
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  const regions = [];
  for (const region of rootRegions) {
    if (regionId) {
      const filterIds = (await getDescendantIds(regionId)).map(String);
      if (!filterIds.includes(String(region._id))) continue;
    }

    const regionStores = stores.filter(
      (store) => String(store.regionId) === String(region._id) || store.region === region.name
    );
    if (!regionStores.length) continue;

    const parentGroups = await buildCategoryParentGroupsForStores(regionStores);
    if (!parentGroups.length) continue;

    regions.push({
      regionId: region._id,
      regionName: region.name,
      parentGroups,
    });
  }

  return { total: stores.length, regions };
}

module.exports = {
  browseStores,
  storesByRegions,
  pointsProgramStores,
  suggestNearestStore,
  findAlternateRegionForCategory,
  computeStoreScore,
  sortStoresList,
};
