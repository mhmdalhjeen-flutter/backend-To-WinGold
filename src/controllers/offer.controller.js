const Offer = require("../models/offer");
const Store = require("../models/store");
const User = require("../models/user");
const logActivity = require("../utils/logger");
const notificationService = require("../services/notification.service");
const storeSubscriberNotification = require("../services/storeSubscriberNotification.service");
const { computeOfferFinalPrice, attachPricingToOffer } = require("../services/pricing.service");
const { normalizeCurrency } = require("../utils/currency.util");
const { normalizePurchaseMode } = require("../constants/purchaseMode.constants");
const { normalizeReservationSettings } = require("../utils/reservationSettings.util");
const { resolveNetworkStoreIds } = require("../utils/offerFeed.util");
const { processDataUrlImage } = require("../utils/imageProcess.util");
const { resolveListImageField, resolveStoreMediaFields } = require("../utils/mediaDelivery.util");
const {
    assertNoMongoOperators,
    cleanString,
    intInRange,
    numberInRange,
    requireObjectId,
} = require("../utils/inputSecurity.util");

const OFFER_TYPES = ["discount", "fixed_price", "bogo", "fixed_discount", "free_item", "custom"];
const MAX_OFFER_DAYS = 7;
const OFFER_LIST_SELECT =
    "title description offerType value originalPrice finalPrice freeDelivery currency priceUnit image priority isActive expiresAt autoDeleteAt storeItemCategory purchaseMode reservationSettings store createdAt";

function stripBase64Images(offer) {
    if (!offer || typeof offer !== "object") return offer;
    const plain = resolveListImageField(offer, "offers");
    if (plain.store && typeof plain.store === "object") {
        plain.store = resolveStoreMediaFields(plain.store);
    }
    return plain;
}

function resolveAutoDeleteAt(expiresAt) {
    const now = new Date();
    const maxLife = new Date(now.getTime() + MAX_OFFER_DAYS * 24 * 60 * 60 * 1000);
    if (!expiresAt) return maxLife;
    const exp = new Date(expiresAt);
    return exp < maxLife ? exp : maxLife;
}

function assertExpiresWithinMaxDays(expiresAt, anchorDate = new Date()) {
    const expDate = new Date(expiresAt);
    if (Number.isNaN(expDate.getTime())) {
        throw Object.assign(new Error("تاريخ انتهاء غير صالح"), { status: 400 });
    }
    const now = new Date();
    if (expDate <= now) {
        throw Object.assign(new Error("تاريخ انتهاء العرض يجب أن يكون في المستقبل"), { status: 400 });
    }
    const anchor = anchorDate instanceof Date ? anchorDate : new Date(anchorDate);
    const maxAllowed = new Date(anchor.getTime() + MAX_OFFER_DAYS * 24 * 60 * 60 * 1000);
    if (expDate > maxAllowed) {
        throw Object.assign(
            new Error("تاريخ انتهاء العرض لا يمكن أن يتجاوز 7 أيام من تاريخ البداية"),
            { status: 400 },
        );
    }
    return expDate;
}

function buildOfferPayload(body, storeId, userId) {
    assertNoMongoOperators(body, "offer");
    const {
        title,
        description,
        offerType,
        value,
        originalPrice,
        finalPrice: bodyFinalPrice,
        image,
        freeDelivery,
        expiresAt,
        currency,
        priceUnit,
        storeItemCategoryId,
        relatedProductId,
        purchaseMode,
        reservationSettings,
    } = body;

    const safeTitle = cleanString(title, { field: "title", max: 120, required: true });
    const safeOfferType = cleanString(offerType, { field: "offerType", max: 40, required: true });
    const safeImage = cleanString(image, { field: "image", max: 1_000_000, required: true });
    if (!OFFER_TYPES.includes(safeOfferType)) throw Object.assign(new Error("نوع العرض غير صالح"), { status: 400 });
    if (!expiresAt) throw new Error("تاريخ انتهاء العرض مطلوب");

    const expDate = assertExpiresWithinMaxDays(expiresAt);

    const safeValue = value != null && value !== "" ? numberInRange(value, { field: "value", min: 0, max: 10_000_000 }) : null;
    const safeOriginalPrice = originalPrice != null && originalPrice !== ""
        ? numberInRange(originalPrice, { field: "originalPrice", min: 0, max: 10_000_000 })
        : null;
    const safeBodyFinalPrice = bodyFinalPrice != null && bodyFinalPrice !== ""
        ? numberInRange(bodyFinalPrice, { field: "finalPrice", min: 0, max: 10_000_000 })
        : bodyFinalPrice;

    const computedFinal = computeOfferFinalPrice({
        offerType: safeOfferType,
        originalPrice: safeOriginalPrice,
        value: safeValue,
        finalPrice: safeBodyFinalPrice,
    });
    if (computedFinal == null) throw new Error("تعذّر حساب السعر النهائي — تحقق من الحقول");

    return {
        title: safeTitle,
        description: cleanString(description, { field: "description", max: 1000 }),
        offerType: safeOfferType,
        value: safeValue,
        originalPrice: safeOriginalPrice,
        finalPrice: computedFinal,
        image: safeImage,
        freeDelivery: !!freeDelivery,
        currency: normalizeCurrency(currency),
        priceUnit: cleanString(priceUnit, { field: "priceUnit", max: 40 }),
        expiresAt: expDate,
        autoDeleteAt: resolveAutoDeleteAt(expDate),
        store: storeId,
        createdBy: userId,
        storeItemCategory: storeItemCategoryId
          ? requireObjectId(storeItemCategoryId, "storeItemCategoryId")
          : null,
        relatedProduct: relatedProductId
          ? requireObjectId(relatedProductId, "relatedProductId")
          : null,
        purchaseMode: normalizePurchaseMode(purchaseMode),
        reservationSettings: normalizeReservationSettings(reservationSettings),
        expiryWarningSent: false,
        deletionWarningSent: false,
    };
}

exports.createOffer = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) {
            return res.status(404).json({ message: "يجب إنشاء متجر أولاً قبل إضافة عروض" });
        }

        const payload = buildOfferPayload(req.body, store._id, req.user.id);
        payload.image = await processDataUrlImage(payload.image, { enforceCloudinaryHttps: true });
        const offer = await Offer.create(payload);

        await logActivity({
            action: "إنشاء عرض",
            details: `المحل ${store.name} أضاف عرضاً جديداً: ${offer.title}`,
            user: req.user.id,
            store: store._id,
        });

        storeSubscriberNotification.notifyStoreNewOffer(store, offer).catch(() => {});

        res.json({ message: "تم إنشاء العرض بنجاح", offer: attachPricingToOffer(offer) });
    } catch (err) {
        const status = err.message.includes("مطلوب") || err.message.includes("غير") || err.message.includes("تعذّر") ? 400 : 500;
        res.status(status).json({ message: err.message });
    }
};

exports.getOffers = async (req, res) => {
    try {
        const limit = req.query.limit
            ? intInRange(req.query.limit, { field: "limit", min: 1, max: 200 })
            : 200;

        const offers = await Offer.find({ isActive: true })
            .select(OFFER_LIST_SELECT)
            .populate("store", "name logo region subRegion isOpen")
            .sort({ priority: -1, createdAt: -1 })
            .limit(limit)
            .lean();

        res.json({ offers: offers.map(stripBase64Images) });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.getMyOffers = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id }).select("_id").lean();
        if (!store) return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });

        const filter = { store: store._id };
        if (req.query.all !== "true") filter.isActive = true;

        const limit = req.query.limit ? intInRange(req.query.limit, { field: "limit", min: 1, max: 50 }) : undefined;
        let query = Offer.find(filter)
            .select(OFFER_LIST_SELECT)
            .populate("storeItemCategory", "name isActive")
            .populate("relatedProduct", "name price currency priceUnit image")
            .sort({ priority: -1, createdAt: -1 })
            .lean();
        if (limit) query = query.limit(limit);

        const offers = await query;
        res.json({ offers: offers.map(stripBase64Images) });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

/** عروض لوحة التحكم: عروضي + عروض الشبكة (مستودعات/متاجر مرتبطة بالمستخدم). */
exports.getDashboardOffers = async (req, res) => {
    try {
        const ownLimit = intInRange(req.query.ownLimit ?? 3, { field: "ownLimit", min: 1, max: 20 });
        const networkLimit = intInRange(req.query.networkLimit ?? 3, { field: "networkLimit", min: 1, max: 20 });

        const [user, myStore] = await Promise.all([
            User.findById(req.user.id).select("role followedStores preferences").lean(),
            Store.findOne({ owner: req.user.id }).select("_id").lean(),
        ]);

        if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

        let ownOffers = [];
        if (myStore) {
            ownOffers = await Offer.find({ store: myStore._id, isActive: true })
                .select(OFFER_LIST_SELECT)
                .sort({ priority: -1, createdAt: -1 })
                .limit(ownLimit)
                .lean();
        }

        const networkStoreIds = await resolveNetworkStoreIds(user, myStore?._id);
        let networkOffers = [];

        if (networkStoreIds.length) {
            networkOffers = await Offer.find({
                store: { $in: networkStoreIds },
                isActive: true,
            })
                .select(OFFER_LIST_SELECT)
                .populate("store", "name logo category region subRegion isOpen")
                .sort({ priority: -1, createdAt: -1 })
                .limit(networkLimit)
                .lean();
        }

        res.json({
            ownOffers: ownOffers.map(stripBase64Images),
            networkOffers: networkOffers.map(stripBase64Images),
            myStoreId: myStore?._id || null,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.renewOffer = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "renewOffer");
        const offerId = requireObjectId(req.params.id, "id");
        const offer = await Offer.findById(offerId);
        if (!offer) return res.status(404).json({ message: "العرض غير موجود" });

        const renewalDays = req.body.days
            ? intInRange(req.body.days, { field: "days", min: 1, max: MAX_OFFER_DAYS })
            : MAX_OFFER_DAYS;
        const now = new Date();
        if (req.body.expiresAt) {
            const expDate = assertExpiresWithinMaxDays(req.body.expiresAt, now);
            offer.expiresAt = expDate;
            offer.autoDeleteAt = resolveAutoDeleteAt(expDate);
        } else {
            const newExpiresAt = assertExpiresWithinMaxDays(
                new Date(now.getTime() + renewalDays * 24 * 60 * 60 * 1000),
                now,
            );
            offer.expiresAt = newExpiresAt;
            offer.autoDeleteAt = resolveAutoDeleteAt(newExpiresAt);
        }
        offer.isActive = true;
        offer.isExtended = true;
        offer.deletionWarningSent = false;
        offer.expiryWarningSent = false;
        await offer.save();

        await notificationService.create({
            user: req.user.id,
            type: "offer_renewed",
            title: "تم تجديد العرض",
            body: `تم تجديد العرض "${offer.title}".`,
            data: { offerId: offer._id },
        });

        res.json({ message: "تم تجديد العرض بنجاح", offer: attachPricingToOffer(offer) });
    } catch (err) {
        if (err.name === "CastError") {
            return res.status(400).json({ message: "معرّف العرض غير صحيح" });
        }
        res.status(err.status || 500).json({ message: err.message });
    }
};

exports.deleteOffer = async (req, res) => {
    try {
        const offerId = requireObjectId(req.params.id, "id");
        const offer = await Offer.findById(offerId);
        if (!offer) return res.status(404).json({ message: "العرض غير موجود" });

        await Offer.findByIdAndDelete(offerId);
        res.json({ message: "تم حذف العرض نهائياً", deleted: true });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

exports.toggleOfferActive = async (req, res) => {
    try {
        const offerId = requireObjectId(req.params.id, "id");
        const offer = await Offer.findById(offerId);
        if (!offer) return res.status(404).json({ message: "العرض غير موجود" });

        offer.isActive = !offer.isActive;
        await offer.save();

        res.json({
            message: offer.isActive ? "تم تفعيل العرض" : "تم إيقاف العرض",
            offer: attachPricingToOffer(offer),
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

exports.updateOffer = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "offer");
        const offerId = requireObjectId(req.params.id, "id");
        const offer = await Offer.findById(offerId);
        if (!offer) return res.status(404).json({ message: "العرض غير موجود" });

        const patch = { ...req.body };
        const offerType = patch.offerType ? cleanString(patch.offerType, { field: "offerType", max: 40 }) : offer.offerType;
        if (!OFFER_TYPES.includes(offerType)) return res.status(400).json({ message: "نوع العرض غير صالح" });
        const computed = computeOfferFinalPrice({
            offerType,
            originalPrice: patch.originalPrice != null ? numberInRange(patch.originalPrice, { field: "originalPrice", min: 0, max: 10_000_000 }) : offer.originalPrice,
            value: patch.value != null ? numberInRange(patch.value, { field: "value", min: 0, max: 10_000_000 }) : offer.value,
            finalPrice: patch.finalPrice != null ? numberInRange(patch.finalPrice, { field: "finalPrice", min: 0, max: 10_000_000 }) : offer.finalPrice,
        });
        if (computed != null) patch.finalPrice = computed;

        const allowed = [
            "title", "description", "offerType", "value", "originalPrice",
            "finalPrice", "image", "freeDelivery", "expiresAt", "currency", "priceUnit",
            "storeItemCategoryId", "relatedProductId", "isActive", "purchaseMode", "reservationSettings",
        ];
        for (const field of allowed) {
            if (field === "storeItemCategoryId") {
                if (patch.storeItemCategoryId === null || patch.storeItemCategoryId === "") {
                    offer.storeItemCategory = null;
                } else if (patch.storeItemCategoryId !== undefined) {
                    offer.storeItemCategory = requireObjectId(patch.storeItemCategoryId, "storeItemCategoryId");
                }
                continue;
            }
            if (field === "relatedProductId") {
                if (patch.relatedProductId === null || patch.relatedProductId === "") {
                    offer.relatedProduct = null;
                } else if (patch.relatedProductId !== undefined) {
                    offer.relatedProduct = requireObjectId(patch.relatedProductId, "relatedProductId");
                }
                continue;
            }
            if (field === "image") {
                const nextImage = patch.image;
                if (typeof nextImage === "string" && nextImage.trim()) {
                    offer.image = await processDataUrlImage(nextImage.trim(), {
                        enforceCloudinaryHttps: true,
                        previousValue: offer.image,
                    });
                }
                continue;
            }
            if (patch[field] === undefined) continue;
            if (field === "title") offer.title = cleanString(patch.title, { field: "title", max: 120, required: true });
            else if (field === "description") offer.description = cleanString(patch.description, { field: "description", max: 1000 });
            else if (field === "offerType") offer.offerType = offerType;
            else if (field === "value") offer.value = numberInRange(patch.value, { field: "value", min: 0, max: 10_000_000 });
            else if (field === "originalPrice") offer.originalPrice = numberInRange(patch.originalPrice, { field: "originalPrice", min: 0, max: 10_000_000 });
            else if (field === "finalPrice") offer.finalPrice = patch.finalPrice;
            else if (field === "freeDelivery") offer.freeDelivery = !!patch.freeDelivery;
            else if (field === "isActive") offer.isActive = !!patch.isActive;
            else if (field === "currency") offer.currency = normalizeCurrency(patch.currency);
            else if (field === "priceUnit") offer.priceUnit = cleanString(patch.priceUnit, { field: "priceUnit", max: 40 });
            else if (field === "purchaseMode") offer.purchaseMode = normalizePurchaseMode(patch.purchaseMode);
            else if (field === "reservationSettings") offer.reservationSettings = normalizeReservationSettings(patch.reservationSettings);
            else if (field === "expiresAt") {
                const anchor = offer.createdAt || new Date();
                offer.expiresAt = assertExpiresWithinMaxDays(patch.expiresAt, anchor);
            }
        }
        if (patch.expiresAt) {
            offer.autoDeleteAt = resolveAutoDeleteAt(offer.expiresAt);
            offer.expiryWarningSent = false;
        }
        await offer.save();
        res.json({ message: "تم التحديث", offer: attachPricingToOffer(offer) });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};
