const UserActivity = require("../models/userActivity");
const Offer = require("../models/offer");
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
    const offerId = req.params.offerId;
    const existing = await UserActivity.findOne({
      user: req.user.id,
      type: "favorite_offer",
      targetId: offerId,
    });

    if (existing) {
      await existing.deleteOne();
      return res.json({ favorited: false });
    }

    // نخزّن تصنيف/منطقة المتجر في meta لتغذية التوصيات لاحقاً.
    const offer = await Offer.findById(offerId).populate("store", "category region");
    if (!offer) return res.status(404).json({ message: "العرض غير موجود" });

    await UserActivity.create({
      user: req.user.id,
      type: "favorite_offer",
      targetType: "Offer",
      targetId: offerId,
      meta: { category: offer.store?.category, region: offer.store?.region },
    });
    res.json({ favorited: true });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "معرّف العرض غير صحيح" });
    }
    res.status(500).json({ message: err.message });
  }
};

// قائمة المفضّلة (عروض حقيقية فعّالة).
exports.getFavorites = async (req, res) => {
  try {
    const favs = await UserActivity.find({
      user: req.user.id,
      type: "favorite_offer",
    }).sort({ createdAt: -1 });

    const ids = favs.map((f) => f.targetId).filter(Boolean);
    const offers = await Offer.find({ _id: { $in: ids }, isActive: true }).populate(
      "store",
      "name logo region subRegion category"
    );

    // ترتيب حسب أحدث إضافة للمفضّلة.
    const order = new Map(ids.map((id, i) => [String(id), i]));
    offers.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));

    res.json({ favorites: offers, favoriteIds: ids });
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
      const weight = a.type === "favorite_offer" ? 3 : a.type === "open_offer" ? 2 : 1;
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
