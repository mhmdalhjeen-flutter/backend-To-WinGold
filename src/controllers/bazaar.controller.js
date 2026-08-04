const BazaarListing = require("../models/bazaarListing");
const User = require("../models/user");
const Region = require("../models/region");
const { getDescendantIds } = require("../utils/region.util");
const { normalizeLocalPhone, isValidLocalPhone, LOCAL_PHONE_MESSAGE } = require("../utils/phone.util");
const notificationService = require("../services/notification.service");
const { processDataUrlImages, processOptionalImage } = require("../utils/imageProcess.util");
const {
  assertNoMongoOperators,
  cleanString,
  intInRange,
  numberInRange,
  requireObjectId,
  safeRegex,
} = require("../utils/inputSecurity.util");
const { normalizeCurrency } = require("../utils/currency.util");

const POINTS_COST = BazaarListing.POINTS_COST;
const LISTING_DAYS = BazaarListing.LISTING_DAYS;
const BAZAAR_CATEGORIES = BazaarListing.BAZAAR_CATEGORIES;
const BAZAAR_CONDITIONS = BazaarListing.BAZAAR_CONDITIONS;

const POPULATE_PUBLIC = [
  { path: "seller", select: "name avatar" },
  { path: "regionId", select: "name" },
  { path: "subRegionId", select: "name" },
];

const BAZAAR_LIST_SELECT =
  "seller title condition category price currency description images freeDelivery transactionType keywords contactPhone regionId subRegionId status isVisible expiresAt mainImageIndex views favoritedBy createdAt";

const TRANSACTION_TYPES = ["sell", "buy", "exchange", "custom", "rent"];

const isRequestListingType = (type) => type === "custom";

const normalizeKeywords = (raw) => {
  if (!raw) return [];
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/[,،\s]+/)
        .map((k) => k.trim())
        .filter(Boolean);
  return [...new Set(list.map((k) => k.toLowerCase()))].slice(0, 5);
};

const validateImages = (images, { required = true } = {}) => {
  if (!Array.isArray(images) || images.length === 0) {
    if (required) throw new Error("أضف صورة واحدة على الأقل");
    return;
  }
  if (images.length > 3) throw new Error("3 صور كحد أقصى");
  for (const img of images) {
    if (typeof img !== "string" || img.length > 800_000) {
      throw new Error("صورة غير صالحة أو كبيرة جداً");
    }
  }
};

const parseContactPhone = (contactPhone) => {
  const clean = normalizeLocalPhone(contactPhone);
  if (!isValidLocalPhone(clean)) {
    throw new Error(LOCAL_PHONE_MESSAGE);
  }
  return clean;
};

const parseOptionalContactPhone = (contactPhone) => {
  const raw = contactPhone == null ? "" : String(contactPhone).trim();
  if (!raw) return "";
  return parseContactPhone(raw);
};

const deductPoints = async (userId) => {
  const user = await User.findOneAndUpdate(
    { _id: userId, points: { $gte: POINTS_COST } },
    { $inc: { points: -POINTS_COST } },
    { new: true }
  );
  if (user) return user;

  const current = await User.findById(userId).select("points");
  if (!current) throw new Error("المستخدم غير موجود");
  const err = new Error(`تحتاج ${POINTS_COST} نقاط لنشر الإعلان`);
  err.code = "INSUFFICIENT_POINTS";
  err.needsPoints = true;
  err.pointsRequired = POINTS_COST;
  err.pointsAvailable = current.points || 0;
  throw err;
};

const refundPoints = async (userId) => {
  await User.findByIdAndUpdate(userId, { $inc: { points: POINTS_COST } });
};

const formatListing = (doc, userId) => {
  const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
  if (userId) {
    obj.isFavorited = (obj.favoritedBy || []).some(
      (id) => String(id) === String(userId)
    );
  }
  delete obj.favoritedBy;
  return obj;
};

const formatListingForBrowse = (doc, userId) => {
  const obj = formatListing(doc, userId);
  const imgs = obj.images;
  if (Array.isArray(imgs) && imgs.length) {
    const idx = Math.min(obj.mainImageIndex || 0, imgs.length - 1);
    obj.mainImage = imgs[idx];
  }
  delete obj.images;
  obj.hasImages = !!(Array.isArray(imgs) && imgs.length);
  return obj;
};

const publicBrowseFilter = () => ({
  status: "approved",
  isVisible: true,
  expiresAt: { $gt: new Date() },
});

exports.browse = async (req, res) => {
  try {
    const { regionId, subRegionId, keyword, q, transactionType, condition, category } = req.query;
    const filter = publicBrowseFilter();
    const andClauses = [];

    if (regionId) {
      const safeRegionId = requireObjectId(regionId, "regionId");
      const ids = await getDescendantIds(safeRegionId);
      andClauses.push({
        $or: [
          { regionId: { $in: ids } },
          { subRegionId: { $in: ids } },
        ],
      });
    }
    if (subRegionId) {
      const safeSubRegionId = requireObjectId(subRegionId, "subRegionId");
      const ids = await getDescendantIds(safeSubRegionId);
      andClauses.push({
        $or: [
          { regionId: { $in: ids } },
          { subRegionId: { $in: ids } },
        ],
      });
    }
    if (transactionType) {
      const safeTransactionType = cleanString(transactionType, { field: "transactionType", max: 20 });
      if (!TRANSACTION_TYPES.includes(safeTransactionType)) {
        return res.status(400).json({ message: "transactionType غير صالح" });
      }
      filter.transactionType = safeTransactionType;
    }
    if (condition) {
      const safeCondition = cleanString(condition, { field: "condition", max: 20 });
      if (!BAZAAR_CONDITIONS.includes(safeCondition)) {
        return res.status(400).json({ message: "condition غير صالح" });
      }
      filter.condition = safeCondition;
    }
    if (category) {
      const safeCategory = cleanString(category, { field: "category", max: 40 });
      if (!BAZAAR_CATEGORIES.includes(safeCategory)) {
        return res.status(400).json({ message: "category غير صالح" });
      }
      filter.category = safeCategory;
    }

    const search = cleanString(keyword || q || "", { field: "q", max: 80 }).toLowerCase();
    if (search) {
      const rx = safeRegex(search, { field: "q", max: 80 });
      andClauses.push({
        $or: [
          { keywords: search },
          { keywords: rx },
          { title: rx },
          { category: search },
        ],
      });
    }

    if (andClauses.length) filter.$and = andClauses;

    const listings = await BazaarListing.find(filter)
      .select(BAZAAR_LIST_SELECT)
      .populate(POPULATE_PUBLIC)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const userId = req.user?.id;
    res.json({
      listings: listings.map((l) => formatListingForBrowse(l, userId)),
      meta: { pointsCost: POINTS_COST, listingDays: LISTING_DAYS },
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const listingId = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(listingId).populate(POPULATE_PUBLIC);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });

    const isOwner = req.user && String(listing.seller._id || listing.seller) === String(req.user.id);
    const isPublic = listing.status === "approved" && listing.isVisible && listing.expiresAt > new Date();

    if (!isPublic && !isOwner && req.user?.role !== "admin") {
      return res.status(404).json({ message: "الإعلان غير متاح" });
    }

    if (isPublic) {
      listing.views += 1;
      await listing.save();
    }

    res.json({
      listing: formatListing(listing, req.user?.id),
      meta: { pointsCost: POINTS_COST, listingDays: LISTING_DAYS },
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "listing");

    const {
      title,
      condition,
      category,
      price,
      currency,
      description,
      images,
      mainImageIndex,
      freeDelivery,
      transactionType,
      keywords,
      contactPhone,
      regionId,
      subRegionId,
    } = req.body;

    const safeTitle = cleanString(title, { field: "title", max: 120, required: true });
    const safeTransactionType = cleanString(transactionType, { field: "transactionType", max: 20, required: true });
    if (!TRANSACTION_TYPES.includes(safeTransactionType)) {
      return res.status(400).json({ message: "transactionType غير صالح" });
    }
    const isRequest = isRequestListingType(safeTransactionType);
    const safeCondition = condition != null && String(condition).trim()
      ? cleanString(condition, { field: "condition", max: 20, required: true })
      : (isRequest ? "used" : undefined);
    if (!isRequest && !safeCondition) {
      return res.status(400).json({ message: "اختر حالة المنتج" });
    }
    if (safeCondition && !BAZAAR_CONDITIONS.includes(safeCondition)) {
      return res.status(400).json({ message: "condition غير صالح" });
    }
    const safeCategory = category
      ? cleanString(category, { field: "category", max: 40, required: true })
      : undefined;
    if (!isRequest && !safeCategory) {
      return res.status(400).json({ message: "اختر الفئة" });
    }
    if (safeCategory && !BAZAAR_CATEGORIES.includes(safeCategory)) {
      return res.status(400).json({ message: "category غير صالح" });
    }
    validateImages(images, { required: !isRequest });
    const processedImages = isRequest && (!images || images.length === 0)
      ? []
      : await processDataUrlImages(images, { maxBytes: 800_000 });
    const kw = normalizeKeywords(keywords);
    if (!isRequest && kw.length < 2) {
      return res.status(400).json({ message: "أضف 2–5 كلمات مفتاحية" });
    }
    if (isRequest && kw.length > 5) {
      return res.status(400).json({ message: "5 كلمات مفتاحية كحد أقصى" });
    }
    const cleanPhone = parseOptionalContactPhone(contactPhone);
    const safePrice = (isRequest && (price === "" || price == null))
      ? 0
      : numberInRange(price, { field: "price", min: 0, max: 10_000_000, required: !isRequest });
    const safeRegionId = regionId ? requireObjectId(regionId, "regionId") : undefined;
    const safeSubRegionId = subRegionId ? requireObjectId(subRegionId, "subRegionId") : undefined;

    await deductPoints(req.user.id);

    let listing;
    try {
      listing = await BazaarListing.create({
        seller: req.user.id,
        title: safeTitle,
        condition: safeCondition,
        category: safeCategory,
        price: safePrice,
        currency: normalizeCurrency(currency),
        description: cleanString(description, { field: "description", max: 2000 }),
        images: processedImages,
        mainImageIndex: intInRange(mainImageIndex ?? 0, { field: "mainImageIndex", min: 0, max: 2 }),
        freeDelivery: !!freeDelivery,
        transactionType: safeTransactionType,
        keywords: kw,
        contactPhone: cleanPhone,
        regionId: safeRegionId,
        subRegionId: safeSubRegionId,
        status: "pending",
        isVisible: false,
      });
    } catch (createErr) {
      await refundPoints(req.user.id);
      throw createErr;
    }

    const populated = await BazaarListing.findById(listing._id).populate(POPULATE_PUBLIC);
    const user = await User.findById(req.user.id).select("points");

    res.status(201).json({
      message: "تم إرسال الإعلان للمراجعة — سيظهر بعد موافقة الإدارة",
      listing: formatListing(populated, req.user.id),
      pointsRemaining: user?.points ?? 0,
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_POINTS") {
      return res.status(402).json({
        message: err.message,
        needsPoints: true,
        pointsRequired: err.pointsRequired,
        pointsAvailable: err.pointsAvailable,
      });
    }
    res.status(400).json({ message: err.message });
  }
};

exports.myListings = async (req, res) => {
  try {
    const listings = await BazaarListing.find({ seller: req.user.id })
      .populate(POPULATE_PUBLIC)
      .sort({ createdAt: -1 });

    res.json({
      listings: listings.map((l) => formatListing(l, req.user.id)),
      meta: { pointsCost: POINTS_COST, listingDays: LISTING_DAYS },
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "listing");
    const listingId = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(listingId);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });
    if (String(listing.seller) !== String(req.user.id)) {
      return res.status(403).json({ message: "غير مسموح" });
    }

    const fields = [
      "title",
      "condition",
      "category",
      "price",
      "currency",
      "description",
      "images",
      "mainImageIndex",
      "freeDelivery",
      "transactionType",
      "regionId",
      "subRegionId",
    ];
    for (const key of fields) {
      if (req.body[key] === undefined) continue;
      if (key === "images") continue;
      if (key === "title") {
        listing.title = cleanString(req.body.title, { field: "title", max: 120, required: true });
      } else if (key === "description") {
        listing.description = cleanString(req.body.description, { field: "description", max: 2000 });
      } else if (key === "price") {
        const isRequest = isRequestListingType(
          req.body.transactionType !== undefined ? req.body.transactionType : listing.transactionType
        );
        listing.price = (isRequest && (req.body.price === "" || req.body.price == null))
          ? 0
          : numberInRange(req.body.price, { field: "price", min: 0, max: 10_000_000, required: !isRequest });
      } else if (key === "currency") {
        listing.currency = normalizeCurrency(req.body.currency);
      } else if (key === "mainImageIndex") {
        listing.mainImageIndex = intInRange(req.body.mainImageIndex, { field: "mainImageIndex", min: 0, max: 2, required: true });
      } else if (key === "freeDelivery") {
        listing.freeDelivery = !!req.body.freeDelivery;
      } else if (key === "condition") {
        const safeCondition = cleanString(req.body.condition, { field: "condition", max: 20, required: true });
        if (!BAZAAR_CONDITIONS.includes(safeCondition)) return res.status(400).json({ message: "condition غير صالح" });
        listing.condition = safeCondition;
      } else if (key === "category") {
        const safeCategory = cleanString(req.body.category, { field: "category", max: 40, required: true });
        if (!BAZAAR_CATEGORIES.includes(safeCategory)) return res.status(400).json({ message: "category غير صالح" });
        listing.category = safeCategory;
      } else if (key === "transactionType") {
        const safeTransactionType = cleanString(req.body.transactionType, { field: "transactionType", max: 20, required: true });
        if (!TRANSACTION_TYPES.includes(safeTransactionType)) {
          return res.status(400).json({ message: "transactionType غير صالح" });
        }
        listing.transactionType = safeTransactionType;
      } else if (key === "regionId" || key === "subRegionId") {
        listing[key] = req.body[key] ? requireObjectId(req.body[key], key) : undefined;
      }
    }
    if (req.body.images !== undefined) {
      const effectiveType = req.body.transactionType !== undefined
        ? req.body.transactionType
        : listing.transactionType;
      const needsImages = !isRequestListingType(effectiveType);
      if (!Array.isArray(req.body.images) || req.body.images.length === 0) {
        if (needsImages) {
          return res.status(400).json({ message: "أضف صورة واحدة على الأقل" });
        }
        listing.images = [];
      } else {
        validateImages(req.body.images, { required: true });
        listing.images = await processDataUrlImages(req.body.images, { maxBytes: 800_000 });
      }
    }

    if (req.body.contactPhone !== undefined) {
      listing.contactPhone = parseOptionalContactPhone(req.body.contactPhone);
    }
    if (req.body.keywords !== undefined) {
      const kw = normalizeKeywords(req.body.keywords);
      const isRequest = isRequestListingType(
        req.body.transactionType !== undefined ? req.body.transactionType : listing.transactionType
      );
      if (!isRequest && kw.length < 2) return res.status(400).json({ message: "2–5 كلمات مفتاحية" });
      if (isRequest && kw.length > 5) return res.status(400).json({ message: "5 كلمات مفتاحية كحد أقصى" });
      listing.keywords = kw;
    }

    if (listing.status === "rejected") {
      listing.status = "pending";
      listing.adminReview = { note: "" };
    }

    await listing.save();
    const populated = await BazaarListing.findById(listing._id).populate(POPULATE_PUBLIC);
    res.json({ message: "تم تحديث الإعلان", listing: formatListing(populated, req.user.id) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const listingId = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(listingId);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });

    const isOwner = String(listing.seller) === String(req.user.id);
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) return res.status(403).json({ message: "غير مسموح" });

    await listing.deleteOne();
    res.json({ message: "تم حذف الإعلان" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.renew = async (req, res) => {
  try {
    const listingId = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(listingId);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });
    if (String(listing.seller) !== String(req.user.id)) {
      return res.status(403).json({ message: "غير مسموح" });
    }
    if (listing.status !== "approved" && listing.status !== "expired") {
      return res.status(400).json({ message: "لا يمكن تجديد هذا الإعلان حالياً" });
    }

    await deductPoints(req.user.id);

    try {
      const now = new Date();
      listing.expiresAt = new Date(now.getTime() + LISTING_DAYS * 24 * 60 * 60 * 1000);
      listing.status = "approved";
      listing.isVisible = true;
      listing.renewalWarningSent = false;
      await listing.save();
    } catch (saveErr) {
      await refundPoints(req.user.id);
      throw saveErr;
    }

    const user = await User.findById(req.user.id).select("points");
    const populated = await BazaarListing.findById(listing._id).populate(POPULATE_PUBLIC);

    res.json({
      message: "تم تجديد الإعلان لمدة 7 أيام",
      listing: formatListing(populated, req.user.id),
      pointsRemaining: user?.points ?? 0,
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_POINTS") {
      return res.status(402).json({
        message: err.message,
        needsPoints: true,
        pointsRequired: err.pointsRequired,
        pointsAvailable: err.pointsAvailable,
      });
    }
    res.status(400).json({ message: err.message });
  }
};

exports.toggleFavorite = async (req, res) => {
  try {
    const listingId = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(listingId);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });
    if (!(listing.status === "approved" && listing.isVisible && listing.expiresAt > new Date())) {
      return res.status(400).json({ message: "الإعلان غير متاح" });
    }

    const uid = req.user.id;
    const idx = listing.favoritedBy.findIndex((id) => String(id) === String(uid));
    let favorited;
    if (idx >= 0) {
      listing.favoritedBy.splice(idx, 1);
      favorited = false;
    } else {
      listing.favoritedBy.push(uid);
      favorited = true;
    }
    await listing.save();
    res.json({ favorited, message: favorited ? "أُضيف للمفضلة" : "أُزيل من المفضلة" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.myFavorites = async (req, res) => {
  try {
    const listings = await BazaarListing.find({
      favoritedBy: req.user.id,
      ...publicBrowseFilter(),
    })
      .populate(POPULATE_PUBLIC)
      .sort({ updatedAt: -1 });

    res.json({ listings: listings.map((l) => formatListing(l, req.user.id)) });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getRegions = async (_req, res) => {
  try {
    const { buildRegionTree, getAllRegionsActive } = require("../utils/region.util");
    const all = await getAllRegionsActive();
    res.json({ regions: buildRegionTree(all) });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getMeta = async (req, res) => {
  try {
    let pointsAvailable = 0;
    if (req.user) {
      const user = await User.findById(req.user.id).select("points referralCode");
      pointsAvailable = user?.points ?? 0;
    }
    res.json({
      pointsCost: POINTS_COST,
      listingDays: LISTING_DAYS,
      pointsAvailable,
      transactionTypes: [
        { value: "sell", label: "بيع" },
        { value: "buy", label: "شراء" },
        { value: "exchange", label: "بدل" },
        { value: "rent", label: "إيجار" },
        { value: "custom", label: "طلب" },
      ],
      categories: BAZAAR_CATEGORIES,
      conditions: BAZAAR_CONDITIONS,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
