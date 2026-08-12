const Offer = require("../models/offer");
const Product = require("../models/product");
const Store = require("../models/store");
const User = require("../models/user");
const UserActivity = require("../models/userActivity");
const OfferViewDedup = require("../models/offerViewDedup");
const pricingService = require("./pricing.service");
const { getCategoryAndDescendantNames, resolveCategoryNamesForSearch } = require("../controllers/category.controller");
const {
  loadActiveStoreCategories,
  buildCategoryIndex,
  buildDisplaySections,
  groupItemsBySection,
  sectionKey,
} = require("../utils/categoryHierarchy.util");
const { restrictOfferQueryToCustomerStores, getCustomerVisibleStoreIds } = require("../utils/storeFilter");
const { resolveNetworkStoreIds } = require("../utils/offerFeed.util");
const { buildUserSignals, sortOffersPersonalized, sortOffersByRank } = require("../utils/personalizedRank.util");
const { getDescendantIds } = require("../utils/region.util");

const LIST_OFFER_SELECT =
  "title description offerType originalPrice value finalPrice currency priceUnit isActive priority featuredPriority displayPriority views shareCount createdAt expiresAt image bogoGetQuantity bogoBuyQuantity freeItemName customLabel store";

const STORE_POPULATE_SELECT =
  "name logo region subRegion category categoryId ratingAvg ratingCount regionId subRegionId isVerifiedStore owner";

const PRODUCT_LIST_SELECT =
  "name description price currency priceUnit image stock freeDelivery ratingAvg ratingCount displayPriority store createdAt";

const { resolveListImageField, resolveStoreMediaFields } = require("../utils/mediaDelivery.util");
const { applyProductDisplayPrioritySort } = require("../utils/displayPriority.util");

/** Matches OfferViewDedup TTL (30 min) — dedupe window for anonymous view counts */
const VIEW_DEDUP_MS = 30 * 60 * 1000;

function applyPublicExpiryFilter(offerQuery) {
  offerQuery.expiresAt = { $gt: new Date() };
  return offerQuery;
}

function isOfferPubliclyVisible(offer) {
  if (!offer || offer.isActive === false) return false;
  if (!offer.expiresAt) return true;
  return new Date(offer.expiresAt) > new Date();
}

function stripHeavyFields(offer) {
  if (!offer || typeof offer !== "object") return offer;
  const o = resolveListImageField(offer, "offers");
  if (o.store && typeof o.store === "object") {
    o.store = resolveStoreMediaFields(o.store);
  }
  return o;
}

function stripProductHeavyFields(product) {
  if (!product || typeof product !== "object") return product;
  const p = resolveListImageField(product, "products");
  if (p.store && typeof p.store === "object") {
    p.store = resolveStoreMediaFields(p.store);
  }
  return p;
}

function attachPricing(offer) {
  return pricingService.attachPricingToOffer(offer);
}

function attachPricingList(offers, { forList = false } = {}) {
  return (offers || []).map((o) => {
    const priced = attachPricing(o);
    return forList ? stripHeavyFields(priced) : priced;
  });
}

async function applyRegionToStoreQuery(storeQuery, regionParam) {
  if (!regionParam) return;
  const ids = await getDescendantIds(regionParam);
  if (ids.length) {
    storeQuery.$or = [
      { regionId: { $in: ids } },
      { subRegionId: { $in: ids } },
      { region: regionParam },
    ];
  }
}

async function applySearchToOfferQuery(offerQuery, q) {
  if (!q || !q.trim()) return;
  const safe = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(safe, "i");
  const categoryNames = await resolveCategoryNamesForSearch(q);
  const storeOr = [{ name: rx }, { category: rx }];
  if (categoryNames.length) {
    storeOr.push({ category: { $in: categoryNames } });
  }
  const matchStores = await Store.find({ $or: storeOr }).select("_id");
  offerQuery.$or = [{ title: rx }, { store: { $in: matchStores.map((s) => s._id) } }];
}

async function buildPublicOfferQuery(query) {
  const { category, region, subRegion } = query;
  const offerQuery = { isActive: true };
  applyPublicExpiryFilter(offerQuery);
  const storeQuery = {};

  if (category) {
    const names = await getCategoryAndDescendantNames(category);
    storeQuery.category = { $in: names.length ? names : ["__none__"] };
  }
  if (region) await applyRegionToStoreQuery(storeQuery, region);
  if (subRegion) await applyRegionToStoreQuery(storeQuery, subRegion);

  if (Object.keys(storeQuery).length > 0) {
    const stores = await Store.find(storeQuery).select("_id");
    offerQuery.store = { $in: stores.map((s) => s._id) };
  }

  await restrictOfferQueryToCustomerStores(offerQuery);
  return offerQuery;
}

async function rankOffers(offers, userId, { forList = true } = {}) {
  const plain = offers.map((o) => (o.toObject ? o.toObject() : o));
  const signals = userId ? await buildUserSignals(userId) : null;
  const ranked = signals
    ? sortOffersPersonalized(plain, signals)
    : sortOffersByRank(plain);
  return attachPricingList(ranked, { forList });
}

async function listActiveOffers(query, userId) {
  const offerQuery = await buildPublicOfferQuery(query);
  const offers = await Offer.find(offerQuery)
    .select(LIST_OFFER_SELECT)
    .populate("store", STORE_POPULATE_SELECT)
    .limit(200)
    .lean();
  return rankOffers(offers, userId);
}

async function listOfferFeed(query, userId) {
  const { q, category, region, subRegion, cursor } = query;
  const limit = Math.min(parseInt(query.limit, 10) || 12, 50);

  const offerQuery = { isActive: true };
  applyPublicExpiryFilter(offerQuery);
  const storeQuery = {};
  if (category) {
    const names = await getCategoryAndDescendantNames(category);
    storeQuery.category = { $in: names.length ? names : ["__none__"] };
  }
  const regionFilter = subRegion || region;
  if (regionFilter) await applyRegionToStoreQuery(storeQuery, regionFilter);
  if (Object.keys(storeQuery).length > 0) {
    const stores = await Store.find(storeQuery).select("_id");
    offerQuery.store = { $in: stores.map((s) => s._id) };
  }

  await restrictOfferQueryToCustomerStores(offerQuery);
  await applySearchToOfferQuery(offerQuery, q);

  const fetchLimit = Math.min(limit * 4, 200);
  const docs = await Offer.find(offerQuery)
    .select(LIST_OFFER_SELECT)
    .populate("store", STORE_POPULATE_SELECT)
    .limit(fetchLimit)
    .lean();

  const ranked = await rankOffers(docs, userId);

  let page = ranked;
  if (cursor) {
    const idx = ranked.findIndex((o) => String(o._id) === String(cursor));
    page = idx >= 0 ? ranked.slice(idx + 1) : ranked;
  }

  const items = page.slice(0, limit);
  const nextCursor = page.length > limit ? items[items.length - 1]?._id || null : null;

  return { items, nextCursor };
}

async function shouldCountView(offerId, { userId, clientId } = {}) {
  const since = new Date(Date.now() - VIEW_DEDUP_MS);

  if (userId) {
    const existing = await UserActivity.findOne({
      user: userId,
      type: "view_offer",
      targetId: offerId,
      createdAt: { $gte: since },
    }).select("_id");
    if (existing) return false;
  } else if (clientId) {
    const existing = await OfferViewDedup.findOne({
      clientId,
      offerId,
      createdAt: { $gte: since },
    }).select("_id");
    if (existing) return false;
  }

  return true;
}

async function recordMeaningfulView(offerId, { userId, clientId } = {}) {
  const offer = await Offer.findById(offerId).populate("store", "category region");
  if (!offer || !offer.isActive) {
    const err = new Error("العرض غير موجود");
    err.status = 404;
    throw err;
  }

  const count = await shouldCountView(offerId, { userId, clientId });
  if (!count) {
    return { counted: false, views: offer.views || 0 };
  }

  await Offer.findByIdAndUpdate(offerId, { $inc: { views: 1 } });

  if (userId) {
    const activityService = require("./activity.service");
    await activityService.log({
      user: userId,
      type: "view_offer",
      targetType: "Offer",
      targetId: offerId,
      meta: {
        category: offer.store?.category,
        region: offer.store?.region,
      },
    });
  } else if (clientId) {
    await OfferViewDedup.create({ clientId, offerId });
  }

  return { counted: true, views: (offer.views || 0) + 1 };
}

async function recordOfferShare(offerId) {
  const offer = await Offer.findByIdAndUpdate(
    offerId,
    { $inc: { shareCount: 1 } },
    { new: true }
  ).select("shareCount isActive");

  if (!offer || !offer.isActive) {
    const err = new Error("العرض غير موجود");
    err.status = 404;
    throw err;
  }

  return { shareCount: offer.shareCount };
}

async function getOfferById(offerId, { incrementViews = false, userId, clientId } = {}) {
  const offer = await Offer.findById(offerId).populate(
    "store",
    "name phone whatsapp region subRegion logo category owner isVerifiedStore ratingAvg ratingCount"
  );

  if (!offer || !isOfferPubliclyVisible(offer)) {
    const err = new Error("العرض غير موجود");
    err.status = 404;
    throw err;
  }

  if (incrementViews && offer.isActive !== false) {
    const result = await recordMeaningfulView(offerId, { userId, clientId });
    if (result.counted) offer.views = result.views;
  }

  return attachPricing(offer);
}

async function listCategoryReels(query, userId) {
  const { region, subRegion } = query;
  const perReel = Math.min(parseInt(query.limit, 10) || 20, 40);

  const categories = await loadActiveStoreCategories();
  const index = buildCategoryIndex(categories);
  const sections = buildDisplaySections(categories);

  const offerQuery = { isActive: true };
  applyPublicExpiryFilter(offerQuery);
  const storeQuery = {};
  const regionFilter = subRegion || region;
  if (regionFilter) await applyRegionToStoreQuery(storeQuery, regionFilter);
  if (Object.keys(storeQuery).length > 0) {
    const stores = await Store.find(storeQuery).select("_id");
    offerQuery.store = { $in: stores.map((s) => s._id) };
  }

  await restrictOfferQueryToCustomerStores(offerQuery);

  const docs = await Offer.find(offerQuery)
    .select(LIST_OFFER_SELECT)
    .populate("store", STORE_POPULATE_SELECT)
    .limit(400)
    .lean();

  const ranked = await rankOffers(docs, userId);

  const visibleStoreIds = await getCustomerVisibleStoreIds(storeQuery);
  const allowedStoreIds = visibleStoreIds.length ? visibleStoreIds : ["__none__"];

  const categoryProductsByStore = await Product.find({
    store: { $in: allowedStoreIds },
    isActive: true,
    isWholesale: false,
  })
    .select(PRODUCT_LIST_SELECT)
    .populate("store", STORE_POPULATE_SELECT)
    .limit(400)
    .lean();

  const sortedProducts = applyProductDisplayPrioritySort(categoryProductsByStore);

  const offersBySection = groupItemsBySection(
    ranked,
    sections,
    index,
    (offer) => offer.store
  );
  const productsBySection = groupItemsBySection(
    sortedProducts,
    sections,
    index,
    (product) => product.store
  );

  const reels = [];
  const assignedOfferIds = new Set();

  for (const section of sections) {
    const key = sectionKey(section);
    const categoryOffers = offersBySection.get(key) || [];
    const categoryProducts = productsBySection.get(key) || [];
    if (!categoryOffers.length && !categoryProducts.length) continue;

    categoryOffers.forEach((o) => assignedOfferIds.add(String(o._id)));

    reels.push({
      categoryId: section.categoryId,
      categoryName: section.categoryName,
      categoryIcon: section.categoryIcon || "",
      parentCategoryId: section.parentCategoryId,
      parentCategoryName: section.parentCategoryName,
      isParentFallback: section.isParentFallback,
      offers: categoryOffers.slice(0, perReel),
      products: categoryProducts.slice(0, perReel).map(stripProductHeavyFields),
    });
  }

  const uncategorized = ranked.filter((o) => !assignedOfferIds.has(String(o._id)));
  if (uncategorized.length) {
    reels.push({
      categoryId: null,
      categoryName: "عروض متنوعة",
      categoryIcon: "✨",
      parentCategoryId: null,
      parentCategoryName: null,
      isParentFallback: false,
      offers: uncategorized.slice(0, perReel),
      products: [],
    });
  }

  return { reels };
}

async function getMyOffers(ownerId, query = {}) {
  const store = await Store.findOne({ owner: ownerId });
  if (!store) {
    const err = new Error("لا يوجد متجر مرتبط بحسابك");
    err.status = 404;
    throw err;
  }

  const filter = { store: store._id };
  if (query.all !== "true") filter.isActive = true;

  const limit = Math.min(parseInt(query.limit, 10) || 0, 50) || undefined;
  let dbQuery = Offer.find(filter).sort({ priority: -1, createdAt: -1 });
  if (limit) dbQuery = dbQuery.limit(limit);

  const offers = await dbQuery.select(LIST_OFFER_SELECT).lean();
  return attachPricingList(offers, { forList: false });
}

async function getDashboardOffers(user, query = {}) {
  const ownLimit = Math.min(parseInt(query.ownLimit, 10) || 3, 20);
  const networkLimit = Math.min(parseInt(query.networkLimit, 10) || 3, 20);

  const [dbUser, myStore] = await Promise.all([
    User.findById(user.id),
    Store.findOne({ owner: user.id }),
  ]);

  if (!dbUser) {
    const err = new Error("المستخدم غير موجود");
    err.status = 404;
    throw err;
  }

  let ownOffers = [];
  if (myStore) {
    ownOffers = await Offer.find({ store: myStore._id, isActive: true, expiresAt: { $gt: new Date() } })
      .select(LIST_OFFER_SELECT)
      .sort({ priority: -1, createdAt: -1 })
      .limit(ownLimit)
      .lean();
  }

  const networkStoreIds = await resolveNetworkStoreIds(dbUser, myStore?._id);
  let networkOffers = [];

  if (networkStoreIds.length) {
    networkOffers = await Offer.find({
      store: { $in: networkStoreIds },
      isActive: true,
      expiresAt: { $gt: new Date() },
    })
      .select(LIST_OFFER_SELECT)
      .populate("store", "name logo category region subRegion isVerifiedStore")
      .sort({ priority: -1, createdAt: -1 })
      .limit(networkLimit)
      .lean();
  }

  return {
    ownOffers: attachPricingList(ownOffers, { forList: false }),
    networkOffers: attachPricingList(networkOffers, { forList: true }),
    myStoreId: myStore?._id || null,
  };
}

function previewPricing(body) {
  const { offerType, originalPrice, value, finalPrice } = body || {};
  const computed = pricingService.computeOfferFinalPrice({
    offerType,
    originalPrice,
    value,
    finalPrice,
  });

  if (computed == null) {
    return {
      valid: false,
      pricing: null,
      message: "تعذّر حساب السعر — تحقق من حقول نوع العرض",
    };
  }

  const previewOffer = {
    offerType,
    originalPrice,
    value,
    finalPrice: computed,
    currency: body?.currency,
  };

  return {
    valid: true,
    pricing: pricingService.buildOfferPricingDTO(previewOffer),
  };
}

module.exports = {
  attachPricing,
  attachPricingList,
  rankOffers,
  listActiveOffers,
  listOfferFeed,
  listCategoryReels,
  getOfferById,
  recordMeaningfulView,
  recordOfferShare,
  getMyOffers,
  getDashboardOffers,
  previewPricing,
};
