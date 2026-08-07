const Store = require("../models/store");
const Offer = require("../models/offer");
const Product = require("../models/product");
const User = require("../models/user");
const PromoCode = require("../models/promoCode");
const StoreMemberPrize = require("../models/storeMemberPrize");
const SystemSetting = require("../models/systemSetting");
const logActivity = require("../utils/logger");
const { assignUniqueStorePrefix } = require("../utils/storePrefix");
const { getCustomerVisibleStoreIds } = require("../utils/storeFilter");
const storeDiscovery = require("../services/storeDiscovery.service");
const membershipService = require("../services/storeMembership.service");
const { processDataUrlImage, processOptionalImage } = require("../utils/imageProcess.util");
const { resolveListImageField, resolveStoreMediaFields } = require("../utils/mediaDelivery.util");
const {
  assertNoMongoOperators,
  cleanString,
  requireObjectId,
} = require("../utils/inputSecurity.util");

const {
  normalizeLocalPhone,
  isValidLocalPhone,
  normalizeWhatsApp,
  isValidWhatsApp,
  LOCAL_PHONE_MESSAGE,
  WHATSAPP_MESSAGE,
} = require("../utils/phone.util");
const { getDefaultBrandingForCategory } = require("../utils/defaultStoreBranding.util");
const offerService = require("../services/offer.service");
const paymentMethodService = require("../services/storePaymentMethod.service");
const StoreItemCategory = require("../models/storeItemCategory");
const { resolveMonthlyVisits, incrementStoreVisits } = require("../utils/storeVisits.util");
const { applyProductDisplayPrioritySort } = require("../utils/displayPriority.util");

const OFFER_LIST_SELECT =
  "title description offerType value originalPrice finalPrice freeDelivery currency priceUnit image priority featuredPriority displayPriority views clicks ratingAvg ratingCount isFeatured isExtended store createdAt expiresAt isActive storeItemCategory";
const PRODUCT_LIST_SELECT =
  "name description price currency priceUnit wholesalePrice isWholesale minOrderQuantity image stock freeDelivery ratingAvg ratingCount displayPriority isActive storeItemCategory store createdAt";

function stripBase64Images(offer) {
  if (!offer || typeof offer !== "object") return offer;
  const plain = resolveListImageField(offer, "offers");
  if (plain.store && typeof plain.store === "object") {
    plain.store = resolveStoreMediaFields(plain.store);
  }
  return plain;
}

function stripBase64Image(product) {
  if (!product || typeof product !== "object") return product;
  return resolveListImageField(product, "products");
}

function stripBase64Logo(store) {
  return resolveStoreMediaFields(store);
}

async function attachStorePaymentSettings(storeObj) {
  if (!storeObj?._id) return storeObj;
  const { paymentSettings, enabledPaymentMethods } = await paymentMethodService.buildPaymentSettingsForStore(storeObj);
  return { ...storeObj, paymentSettings, enabledPaymentMethods };
}

// ================= إنشاء متجر جديد =================
exports.createStore = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "store");
        const { name, description, phone, whatsapp, address, region, subRegion, category, image } = req.body;

        const existingStore = await Store.findOne({ owner: req.user.id });
        if (existingStore) {
            return res.status(400).json({ message: "لديك متجر مسجل بالفعل." });
        }

        const cleanPhone = normalizeLocalPhone(phone);
        if (!isValidLocalPhone(cleanPhone)) {
            return res.status(400).json({ message: LOCAL_PHONE_MESSAGE });
        }

        const whatsappText = cleanString(whatsapp, { field: "whatsapp", max: 40 });
        let cleanWhatsapp = null;
        if (whatsappText) {
            cleanWhatsapp = normalizeWhatsApp(whatsappText);
            if (!isValidWhatsApp(cleanWhatsapp)) {
                return res.status(400).json({ message: WHATSAPP_MESSAGE });
            }
        }

        const cleanName = cleanString(name, { field: "name", max: 120, required: true });
        const codePrefix = await assignUniqueStorePrefix(cleanName);
        const store = await Store.create({
            name: cleanName,
            description: cleanString(description, { field: "description", max: 1000 }),
            phone: cleanPhone,
            whatsapp: cleanWhatsapp,
            address: cleanString(address, { field: "address", max: 500 }),
            region: cleanString(region, { field: "region", max: 120 }),
            subRegion: cleanString(subRegion, { field: "subRegion", max: 120 }),
            category: cleanString(category, { field: "category", max: 120 }),
            logo: await processOptionalImage(image, { maxWidth: 400, enforceCloudinaryHttps: true }),
            owner: req.user.id,
            isActive: false,
            codePrefix,
        });

        await logActivity({
            action: "إنشاء متجر",
            details: `المستخدم قام بإنشاء طلب لمتجر جديد باسم: ${cleanName}`,
            user: req.user.id,
            store: store._id,
            severity: "warning",
            ipAddress: req.ip
        });

        res.status(201).json({
            message: "تم إنشاء المتجر بنجاح، وهو بانتظار تفعيل الإدارة ليظهر للعامة.",
            store
        });

    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

// ================= نظام الانضمام للمتجر (Store Following) =================
exports.followStore = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const userId = req.user.id;

        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: "المتجر غير موجود" });

        const user = await User.findById(userId);
        const isBusiness = ["store", "supplier"].includes(req.user.role);
        const storeIdStr = storeId.toString();

        const isFollowing = user.followedStores.some(
            (id) => id.toString() === storeIdStr
        );

        if (isFollowing) {
            user.followedStores = user.followedStores.filter(
                (id) => id.toString() !== storeIdStr
            );
            if (!isBusiness) {
                store.customersCount = Math.max(0, store.customersCount - 1);
                await store.save();
            }
            await user.save();
            return res.status(200).json({
                message: isBusiness ? "تم إلغاء المتابعة" : "تم إلغاء الانضمام للمتجر",
                isFollowing: false,
            });
        }

        user.followedStores.push(storeId);
        if (!isBusiness) {
            store.customersCount += 1;
            await store.save();
            await logActivity({
                action: "انضمام لمتجر",
                details: `الزبون ${user.name} انضم لقائمة زبائن متجر ${store.name}`,
                user: userId,
                store: storeId,
            });
        }
        await user.save();

        return res.status(200).json({
            message: isBusiness ? "تمت المتابعة بنجاح" : "تم الانضمام لزبائن المتجر بنجاح",
            isFollowing: true,
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

// ================= جلب زبائن المتجر (للتاجر والأدمن) =================
exports.getStoreCustomers = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        
        // التأكد أن الطلب من صاحب المتجر أو الأدمن
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: "المتجر غير موجود" });
        
        if (req.user.role !== 'admin' && store.owner.toString() !== req.user.id) {
            return res.status(403).json({ message: "غير مسموح لك برؤية قائمة الزبائن" });
        }

        const customers = await User.find({ followedStores: storeId })
            .select("name phone rank codesUsed")
            .lean();
        
        res.json({
            count: customers.length,
            customers
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

// ================= جلب بيانات متجر بالتفصيل =================
exports.getStoreById = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.id, "id");
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: "المتجر غير موجود" });
        if (store.subscriptionActive === false) {
            return res.status(404).json({ message: "المتجر غير متاح" });
        }

        incrementStoreVisits(store);
        await store.save();

        const storePlain = store.toObject();
        const [offers, products, itemCategories] = await Promise.all([
            Offer.find({ store: store._id })
                .select(OFFER_LIST_SELECT)
                .populate("storeItemCategory", "name isActive")
                .lean(),
            Product.find({ store: store._id, isWholesale: { $ne: true } })
                .select(PRODUCT_LIST_SELECT)
                .populate("storeItemCategory", "name isActive")
                .lean(),
            StoreItemCategory.find({ store: store._id, isActive: true })
                .sort({ order: 1, name: 1 })
                .select("name isActive order")
                .lean(),
        ]);

        const activeOffers = offers.filter((o) => o.isActive !== false);
        const inactiveOffers = offers.filter((o) => o.isActive === false);
        const offersWithStore = activeOffers.map((offer) => ({ ...offer, store: storePlain }));
        const rankedOffers = await offerService.rankOffers(offersWithStore, req.user?.id, { forList: false });
        const allStoreOffers = [
            ...rankedOffers,
            ...inactiveOffers.map((offer) => ({ ...offer, store: storePlain })),
        ];
        const sortedProducts = applyProductDisplayPrioritySort(products);

        let membership = null;
        let isFollowingNetwork = false;
        if (req.user?.id) {
            membership = await membershipService.getMembership(req.user.id, store._id);
            const user = await User.findById(req.user.id).select("followedStores role");
            if (user && ["store", "supplier"].includes(user.role)) {
                isFollowingNetwork = user.followedStores.some(
                    (id) => id.toString() === store._id.toString()
                );
            }
        }

        const storeCompetitions = await SystemSetting.findOne({ key: "store_competitions_enabled" });
        const competitionsEnabled = storeCompetitions?.value?.enabled !== false;

        res.json({
            store: await attachStorePaymentSettings(resolveStoreMediaFields(store.toObject())),
            offers: allStoreOffers.map(stripBase64Images),
            products: sortedProducts.map(stripBase64Image),
            itemCategories,
            isFollowing: isFollowingNetwork || membership?.status === "member" || membership?.status === "pending",
            membershipStatus: membership?.status || null,
            storeCompetitionsEnabled: competitionsEnabled,
        });

    } catch (error) {
        console.error("[GET /api/stores/:id] getStoreById failed:", error?.stack || error);
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.getAllStores = async (req, res) => {
    try {
        const visibleIds = await getCustomerVisibleStoreIds();
        const { region, category } = req.query;
        const query = { _id: { $in: visibleIds }, isActive: true };
        if (region) query.region = cleanString(region, { field: "region", max: 120 });
        if (category) query.category = cleanString(category, { field: "category", max: 120 });
        const stores = await Store.find(query)
            .select("name logo region subRegion category description customersCount ratingAvg ratingCount codePrefix createdAt")
            .sort({ createdAt: -1 })
            .lean();
        res.json({ count: stores.length, stores: stores.map(stripBase64Logo) });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.browseStores = async (req, res) => {
    try {
        const userId = req.user?.id;
        const data = await storeDiscovery.browseStores({
            userId,
            region: cleanString(req.query.region, { field: "region", max: 120 }),
            regionId: req.query.regionId ? requireObjectId(req.query.regionId, "regionId") : undefined,
            category: cleanString(req.query.category, { field: "category", max: 120 }),
            categoryId: req.query.categoryId ? requireObjectId(req.query.categoryId, "categoryId") : undefined,
            q: cleanString(req.query.q, { field: "q", max: 80 }),
        });
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.storesByRegions = async (req, res) => {
    try {
        const data = await storeDiscovery.storesByRegions({
            q: cleanString(req.query.q, { field: "q", max: 80 }),
            regionId: req.query.regionId ? requireObjectId(req.query.regionId, "regionId") : undefined,
            categoryId: req.query.categoryId ? requireObjectId(req.query.categoryId, "categoryId") : undefined,
        });
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.pointsProgramStores = async (req, res) => {
    try {
        const data = await storeDiscovery.pointsProgramStores({
            q: cleanString(req.query.q, { field: "q", max: 80 }),
            regionId: req.query.regionId ? requireObjectId(req.query.regionId, "regionId") : undefined,
        });
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.suggestStore = async (req, res) => {
    try {
        const store = await storeDiscovery.suggestNearestStore({
            region: cleanString(req.query.region, { field: "region", max: 120 }),
            category: cleanString(req.query.category, { field: "category", max: 120 }),
            excludeIds: cleanString(req.query.exclude || "", { field: "exclude", max: 1000 }).split(",").filter(Boolean),
        });
        res.json({ store });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.joinStore = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const result = await membershipService.joinPending(req.user.id, storeId);
        res.json({
            message: result.message,
            membership: {
                status: result.membership.status,
                store: result.membership.store,
            },
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.leaveStore = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        await membershipService.leaveStore(req.user.id, storeId);
        res.json({ message: "تم إلغاء الانضمام" });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.getMyStoreCodeStats = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر" });

        const [issued, used] = await Promise.all([
            PromoCode.countDocuments({ store: store._id, isRegistrationCode: false }),
            PromoCode.countDocuments({ store: store._id, isRegistrationCode: false, currentUses: { $gt: 0 } }),
        ]);

        res.json({
            codePrefix: store.codePrefix,
            storeName: store.name,
            codesIssued: issued,
            codesUsed: used,
            codesEntered: store.codesEntered || 0,
            qrPayload: store.codePrefix ? `STORE:${store.codePrefix}` : null,
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.getStoreMemberPrizes = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const membership = req.user
            ? await membershipService.getMembership(req.user.id, storeId)
            : null;

        const prizes = await StoreMemberPrize.find({
            store: storeId,
            isActive: true,
            $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
        }).sort({ createdAt: -1 });

        res.json({
            prizes: membership?.status === "member" ? prizes : [],
            membershipStatus: membership?.status || null,
            locked: membership?.status !== "member",
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.getStoreCompetitionsEnabled = async (req, res) => {
    try {
        const s = await SystemSetting.findOne({ key: "store_competitions_enabled" });
        res.json({ enabled: s?.value?.enabled !== false });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.createMemberPrize = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "memberPrize");
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر" });
        const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
        if (expiresAt && Number.isNaN(expiresAt.getTime())) {
            return res.status(400).json({ message: "expiresAt غير صالح" });
        }
        const prize = await StoreMemberPrize.create({
            title: cleanString(req.body.title, { field: "title", max: 120, required: true }),
            description: cleanString(req.body.description, { field: "description", max: 1000 }),
            image: req.body.image ? await processOptionalImage(req.body.image, { maxWidth: 800 }) : null,
            icon: cleanString(req.body.icon || "🎁", { field: "icon", max: 20 }),
            isActive: req.body.isActive === undefined ? true : !!req.body.isActive,
            expiresAt,
            store: store._id,
            createdBy: req.user.id,
        });
        res.status(201).json({ prize });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.listMyMemberPrizes = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر" });
        const prizes = await StoreMemberPrize.find({ store: store._id }).sort({ createdAt: -1 });
        res.json({ prizes });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

// ================= متجر المالك (ملف شخصي) =================
exports.getMyStore = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });

        const suggestedDefaults = getDefaultBrandingForCategory(store.category);
        const needsWelcome = !store.brandingWelcomeSeen && (!store.logo || !store.coverImage);

        const storePayload = await attachStorePaymentSettings(
            resolveStoreMediaFields(store.toObject()),
        );
        storePayload.monthlyVisits = resolveMonthlyVisits(store);

        res.json({ store: storePayload, suggestedDefaults, needsWelcome });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.updateMyStore = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "store");
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });

        const { logo, coverImage, name, description, phone, whatsapp, address, brandingWelcomeSeen, currencyPreferences, receivingMethods } = req.body;

        const nameText = cleanString(name, { field: "name", max: 120 });
        if (nameText) store.name = nameText;
        if (description !== undefined) store.description = cleanString(description, { field: "description", max: 1000 });
        if (address !== undefined) store.address = cleanString(address, { field: "address", max: 500 });
        if (logo !== undefined) {
            store.logo = await processOptionalImage(logo, {
                maxWidth: 400,
                enforceCloudinaryHttps: true,
                previousValue: store.logo,
            });
        }
        if (coverImage !== undefined) {
            store.coverImage = await processOptionalImage(coverImage, {
                maxWidth: 1200,
                enforceCloudinaryHttps: true,
                previousValue: store.coverImage,
            });
        }
        if (brandingWelcomeSeen !== undefined) store.brandingWelcomeSeen = !!brandingWelcomeSeen;

        if (phone !== undefined) {
            const cleanPhone = normalizeLocalPhone(phone);
            if (!isValidLocalPhone(cleanPhone)) {
                return res.status(400).json({ message: LOCAL_PHONE_MESSAGE });
            }
            store.phone = cleanPhone;
        }

        if (whatsapp !== undefined) {
            const whatsappText = cleanString(whatsapp, { field: "whatsapp", max: 40 });
            if (!whatsappText) {
                store.whatsapp = undefined;
            } else {
                const cleanWhatsapp = normalizeWhatsApp(whatsappText);
                if (!isValidWhatsApp(cleanWhatsapp)) {
                    return res.status(400).json({ message: WHATSAPP_MESSAGE });
                }
                store.whatsapp = cleanWhatsapp;
            }
        }

        if (store.logo && store.coverImage) {
            store.brandingWelcomeSeen = true;
        }

        if (currencyPreferences !== undefined && typeof currencyPreferences === "object") {
            assertNoMongoOperators(currencyPreferences, "currencyPreferences");
            if (currencyPreferences.acceptsWornCurrency !== undefined) {
                store.currencyPreferences.acceptsWornCurrency = !!currencyPreferences.acceptsWornCurrency;
            }
            if (currencyPreferences.acceptsOldCurrency !== undefined) {
                store.currencyPreferences.acceptsOldCurrency = !!currencyPreferences.acceptsOldCurrency;
            }
            if (currencyPreferences.acceptsAllCurrencyTypes !== undefined) {
                store.currencyPreferences.acceptsAllCurrencyTypes = !!currencyPreferences.acceptsAllCurrencyTypes;
            }
        }

        if (receivingMethods !== undefined && typeof receivingMethods === "object") {
            assertNoMongoOperators(receivingMethods, "receivingMethods");
            if (!store.receivingMethods) store.receivingMethods = {};
            if (receivingMethods.freeNearbyDelivery?.enabled !== undefined) {
                store.receivingMethods.freeNearbyDelivery = {
                    enabled: Boolean(receivingMethods.freeNearbyDelivery.enabled),
                };
            }
            if (receivingMethods.storePickup?.enabled !== undefined) {
                store.receivingMethods.storePickup = {
                    enabled: Boolean(receivingMethods.storePickup.enabled),
                };
            }
            if (typeof store.markModified === "function") {
                store.markModified("receivingMethods");
            }
        }

        await store.save();
        const storeOut = await attachStorePaymentSettings(resolveStoreMediaFields(store.toObject()));
        res.json({ message: "تم تحديث بيانات المتجر", store: storeOut });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.applyDefaultBranding = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });

        const defaults = getDefaultBrandingForCategory(store.category);
        if (!store.logo) store.logo = defaults.logo;
        if (!store.coverImage) store.coverImage = defaults.cover;
        store.brandingWelcomeSeen = true;

        await store.save();
        res.json({
            message: `تم تعيين صورة افتراضية (${defaults.label}) — يمكنك تغييرها من الملف الشخصي`,
            store,
            applied: defaults,
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

exports.dismissBrandingWelcome = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id });
        if (!store) return res.status(404).json({ message: "لا يوجد متجر مرتبط بحسابك" });
        store.brandingWelcomeSeen = true;
        await store.save();
        res.json({ message: "تم التحديث", store });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};
// ملاحظة: نسخة تفعيل المتجر المعتمدة موجودة في activation.controller.js (وهي الموصولة بالمسار).
// أُزيلت نسخة مكرّرة معطوبة كانت هنا (تستخدم حقل `type` غير الموجود و`ActivationCode` غير مستورد).
