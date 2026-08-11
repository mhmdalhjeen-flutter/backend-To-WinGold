const UserActivity = require("../models/userActivity");
const Offer = require("../models/offer");
const Product = require("../models/product");
const Store = require("../models/store");
const activityService = require("../services/activity.service");
const { getCustomerVisibleStoreIds } = require("../utils/storeFilter");
const { computeOfferRankScore } = require("../utils/ranking.util");
const { applyOfferDisplayPrioritySort } = require("../utils/displayPriority.util");

const LOGGABLE = ["view_offer", "open_offer", "view_product", "visit_store", "search"];

// تسجيل نشاط (مشاهدة/فتح/زيارة/بحث). المفضّلة عبر مسار منفصل.
exports.logActivity = async (req, res) => {
  try {
    const { type, targetType, targetId, meta } = req.body;
    if (!LOGGABLE.includes(type)) {
      return res.status(400).json({ message: "نوع النشاط غير مدعوم" });
    }
    await activityService.log({ user: req.user.id, type, targetType, targetId, meta });
    res.status(201).json({ message: "تم التسجيل" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// نشاطي الأخير.
exports.getMyActivity = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const activities = await UserActivity.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json({ activities });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// تبديل مفضّلة عرض (إضافة/إزالة).
exports.toggleFavorite = async (req, res) => {
  try {
    const result = await toggleSavedInternal(req.user.id, "Offer", req.params.offerId);
    res.json({
      favorited: result.saved,
      saved: result.saved,
      savedKey: result.savedKey,
      message: result.saved ? "تم الحفظ في المحفوظات" : "تمت الإزالة من المحفوظات",
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف العرض غير صحيح" });
    }
    res.status(500).json({ message: err.message });
  }
};

async function toggleSavedInternal(userId, targetType, targetId) {
  const normalizedType = String(targetType || "").trim();
  const isProduct = normalizedType === "Product";
  const activityType = isProduct ? "favorite_product" : "favorite_offer";

  const existing = await UserActivity.findOne({
    user: userId,
    type: activityType,
    targetId,
  });

  if (existing) {
    await existing.deleteOne();
    return { saved: false, savedKey: `${isProduct ? "product" : "offer"}:${String(targetId)}` };
  }

  if (isProduct) {
    const product = await Product.findById(targetId).populate("store", "category region");
    if (!product || product.isActive === false) {
      const err = new Error("المنتج غير موجود");
      err.status = 404;
      throw err;
    }
    await UserActivity.create({
      user: userId,
      type: activityType,
      targetType: "Product",
      targetId,
      meta: { category: product.store?.category, region: product.store?.region },
    });
  } else {
    const offer = await Offer.findById(targetId).populate("store", "category region");
    if (!offer) {
      const err = new Error("العرض غير موجود");
      err.status = 404;
      throw err;
    }
    await UserActivity.create({
      user: userId,
      type: activityType,
      targetType: "Offer",
      targetId,
      meta: { category: offer.store?.category, region: offer.store?.region },
    });
  }

  return { saved: true, savedKey: `${isProduct ? "product" : "offer"}:${String(targetId)}` };
}

exports.toggleSaved = async (req, res) => {
  try {
    const targetType = req.body?.targetType;
    const targetId = req.body?.targetId;
    if (!targetType || !targetId) {
      return res.status(400).json({ message: "نوع العنصر والمعرّف مطلوبان" });
    }
    const result = await toggleSavedInternal(req.user.id, targetType, targetId);
    res.json({
      ...result,
      favorited: result.saved,
      message: result.saved ? "تم الحفظ في المحفوظات" : "تمت الإزالة من المحفوظات",
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف غير صحيح" });
    }
    res.status(500).json({ message: err.message });
  }
};

// قائمة المحفوظات (منتجات + عروض فعّالة).
exports.getFavorites = async (req, res) => {
  try {
    const favs = await UserActivity.find({
      user: req.user.id,
      type: { $in: ["favorite_offer", "favorite_product"] },
    }).sort({ createdAt: -1 });

    const offerIds = [];
    const productIds = [];
    const order = [];

    for (const fav of favs) {
      if (fav.type === "favorite_product") {
        productIds.push(fav.targetId);
        order.push({ kind: "product", id: String(fav.targetId) });
      } else {
        offerIds.push(fav.targetId);
        order.push({ kind: "offer", id: String(fav.targetId) });
      }
    }

    const [offers, products] = await Promise.all([
      offerIds.length
        ? Offer.find({ _id: { $in: offerIds }, isActive: true }).populate(
          "store",
          "name logo region subRegion category",
        ).lean()
        : [],
      productIds.length
        ? Product.find({ _id: { $in: productIds }, isActive: { $ne: false } }).populate(
          "store",
          "name logo region subRegion category",
        ).lean()
        : [],
    ]);

    const offerMap = new Map(offers.map((o) => [String(o._id), { ...o, __itemType: "offer" }]));
    const productMap = new Map(products.map((p) => [String(p._id), { ...p, __itemType: "product" }]));

    const items = order
      .map((entry) => (entry.kind === "product"
        ? productMap.get(entry.id)
        : offerMap.get(entry.id)))
      .filter(Boolean);

    const savedKeys = items.map((item) => (
      item.__itemType === "product"
        ? `product:${String(item._id)}`
        : `offer:${String(item._id)}`
    ));

    res.json({
      items,
      savedKeys,
      favorites: offers,
      favoriteIds: offerIds,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// توصيات قائمة على القواعد (AD-004): تعتمد على التصنيفات/المناطق المهتمّ بها
// المستخدم (من نشاطه ومفضّلته)، مع fallback لأحدث العروض.
exports.getRecommendations = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 30);

    // 1. إشارات الاهتمام من آخر 80 نشاط.
    const activities = await UserActivity.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    const categoryScore = {};
    const regionScore = {};
    const searchTerms = [];
    const seenOfferIds = new Set();

    for (const a of activities) {
      const cat = a.meta?.category;
      const reg = a.meta?.region;
      const weight = a.type === "favorite_offer" || a.type === "favorite_product" ? 3 : a.type === "open_offer" ? 2 : 1;
      if (cat) categoryScore[cat] = (categoryScore[cat] || 0) + weight;
      if (reg) regionScore[reg] = (regionScore[reg] || 0) + weight;
      if (a.type === "search" && a.meta?.query) searchTerms.push(String(a.meta.query));
      if (a.targetType === "Offer" && a.targetId) seenOfferIds.add(String(a.targetId));
    }

    const categories = Object.keys(categoryScore);
    const regions = Object.keys(regionScore);

    // 2. لا إشارات → fallback: أحدث العروض.
    if (categories.length === 0 && regions.length === 0 && searchTerms.length === 0) {
      const latest = await Offer.find({ isActive: true })
        .populate("store", "name logo region subRegion category")
        .sort({ createdAt: -1 })
        .limit(limit);
      return res.json({ recommendations: latest, basedOn: { categories: [], regions: [], fallback: true } });
    }

    // 3. المتاجر المطابقة للتصنيفات/المناطق المهتمّ بها.
    const storeOr = [];
    if (categories.length) storeOr.push({ category: { $in: categories } });
    if (regions.length) storeOr.push({ region: { $in: regions } });
    let candidateOffers = [];
    if (storeOr.length) {
      const visibleIds = await getCustomerVisibleStoreIds();
      const stores = await Store.find({ $or: storeOr, _id: { $in: visibleIds } }).select("_id category region");
      const storeMap = new Map(stores.map((s) => [String(s._id), s]));
      const storeIds = stores.map((s) => s._id);
      candidateOffers = await Offer.find({ isActive: true, store: { $in: storeIds } })
        .populate("store", "name logo region subRegion category")
        .limit(60)
        .lean();

      // تجاهل العروض التي رآها/فتحها سابقاً (نوصي بالجديد) — مع إبقائها كاحتياطي.
      candidateOffers.forEach((o) => {
        const cat = o.store?.category;
        const reg = o.store?.region;
        let score = 0;
        if (cat && categoryScore[cat]) score += categoryScore[cat] * 3;
        if (reg && regionScore[reg]) score += regionScore[reg] * 2;
        if (searchTerms.some((t) => o.title && o.title.includes(t))) score += 2;
        if (seenOfferIds.has(String(o._id))) score -= 1;
        score += computeOfferRankScore(o, o.store) * 0.15;
        o.__score = score;
      });
      candidateOffers = applyOfferDisplayPrioritySort(
        candidateOffers,
        (list) => [...list].sort((a, b) => b.__score - a.__score)
      );
    }

    let recommendations = candidateOffers.slice(0, limit);

    // 4. إن لم تكفِ، نكمل بأحدث العروض (دون تكرار).
    if (recommendations.length < limit) {
      const have = new Set(recommendations.map((o) => String(o._id)));
      const filler = await Offer.find({ isActive: true })
        .populate("store", "name logo region subRegion category")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      for (const o of filler) {
        if (recommendations.length >= limit) break;
        if (!have.has(String(o._id))) {
          recommendations.push(o);
          have.add(String(o._id));
        }
      }
    }

    res.json({ recommendations, basedOn: { categories, regions, fallback: false } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
