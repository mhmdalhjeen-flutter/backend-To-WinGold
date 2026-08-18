const Product = require("../models/product");
const Store = require("../models/store");
const { processDataUrlImage } = require("../utils/imageProcess.util");
const { resolveListImageField } = require("../utils/mediaDelivery.util");
const {
    assertNoMongoOperators,
    cleanString,
    numberInRange,
    requireObjectId,
    safeRegex,
} = require("../utils/inputSecurity.util");
const { applyProductDisplayPrioritySort } = require("../utils/displayPriority.util");
const { normalizeCurrency } = require("../utils/currency.util");

const { normalizePurchaseMode } = require("../constants/purchaseMode.constants");
const { normalizeReservationSettings } = require("../utils/reservationSettings.util");

const PRODUCT_LIST_SELECT =
    "name description price currency priceUnit wholesalePrice isWholesale minOrderQuantity image stock freeDelivery ratingAvg ratingCount displayPriority isActive storeItemCategory purchaseMode reservationSettings store createdAt";

function stripBase64Image(product) {
    if (!product || typeof product !== "object") return product;
    return resolveListImageField(product, "products");
}

// ================= إنشاء منتج جديد =================
exports.createProduct = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "product");

       const store = await Store.findOne({
    owner: req.user.id,
    isActive: true
});
        if (!store) {
            return res.status(404).json({ message: "يجب إنشاء متجر/مستودع أولاً قبل إضافة منتجات" });
        }
        const {
            name,
            description,
            price,
            currency,
            priceUnit,
            image,
            isWholesale,
            freeDelivery,
            storeItemCategoryId,
            purchaseMode,
            reservationSettings,
        } = req.body;
        if (!name || price == null) {
            return res.status(400).json({
                message: "اسم المنتج والسعر مطلوبان",
            });
        }
        if (!image?.trim()) {
            return res.status(400).json({ message: "صورة المنتج مطلوبة" });
        }

    const product = await Product.create({
            name: cleanString(name, { field: "name", max: 120, required: true }),
            description: cleanString(description, { field: "description", max: 1000 }),
            price: numberInRange(price, { field: "price", min: 0, max: 10_000_000, required: true }),
            currency: normalizeCurrency(currency),
            priceUnit: cleanString(priceUnit, { field: "priceUnit", max: 40 }),
            image: await processDataUrlImage(image.trim(), { enforceCloudinaryHttps: true }),
            isWholesale: !!isWholesale,
            freeDelivery: !!freeDelivery,
            store: store._id,
            storeItemCategory: storeItemCategoryId
              ? requireObjectId(storeItemCategoryId, "storeItemCategoryId")
              : null,
            purchaseMode: normalizePurchaseMode(purchaseMode),
            reservationSettings: normalizeReservationSettings(reservationSettings),
        });

        const storeSubscriberNotification = require("../services/storeSubscriberNotification.service");
        storeSubscriberNotification.notifyStoreNewProduct(store, product).catch(() => {});

        res.json({ message: "تم إنشاء المنتج بنجاح", product });

    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ================= جلب منتجات متجر معين (للزبائن) =================
exports.getStoreProducts = async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findById(storeId).select("subscriptionActive isActive").lean();
        if (!store || !store.isActive || store.subscriptionActive === false) {
            return res.json({ products: [] });
        }
        const products = await Product.find({ 
            store: storeId,
            isActive: true,
            isWholesale: false // عرض المنتجات العادية فقط للزبائن
        })
            .select(PRODUCT_LIST_SELECT)
            .lean();
        const sorted = applyProductDisplayPrioritySort(products);
        res.json({ products: sorted.map(stripBase64Image) });

    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};

// ================= جلب منتجات الجملة (حصرياً لأصحاب المحلات) =================
exports.getWholesaleProducts = async (req, res) => {
    try {
        const products = await Product.find({ 
            isWholesale: true,
            isActive: true 
        })
            .select(PRODUCT_LIST_SELECT)
            .populate("store", "name phone whatsapp region isOpen")
            .lean();

        res.json({
            count: products.length,
            products: products.map(stripBase64Image)
        });

    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

// ================= البحث عن المنتجات =================
exports.searchProducts = async (req, res) => {
    try {
        const q = cleanString(req.query.q, { field: "q", max: 80 });

        if (!q || q.trim().length < 2) {
            return res.status(400).json({
                message: "يجب إدخال حرفين على الأقل للبحث"
            });
        }
        const rx = safeRegex(q, { field: "q", max: 80 });

        const products = await Product.find({
            name: rx,
            isActive: true,
            isWholesale: false
        })
            .select(PRODUCT_LIST_SELECT)
            .limit(50)
            .lean();

        const sorted = applyProductDisplayPrioritySort(products);

        res.json({
            count: sorted.length,
            products: sorted.map(stripBase64Image)
        });

    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

// ================= حذف منتج نهائياً =================
exports.deleteProduct = async (req, res) => {
    try {
        const productId = requireObjectId(req.params.id, "id");
        const product = await Product.findById(productId);

        if (!product) {
            return res.status(404).json({ message: "المنتج غير موجود" });
        }

        await Product.findByIdAndDelete(productId);

        res.json({ message: "تم حذف المنتج نهائياً", deleted: true });

    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};

// ================= إيقاف / تفعيل منتج =================
exports.toggleProductActive = async (req, res) => {
    try {
        const productId = requireObjectId(req.params.id, "id");
        const product = await Product.findById(productId);

        if (!product) {
            return res.status(404).json({ message: "المنتج غير موجود" });
        }

        product.isActive = !product.isActive;
        await product.save();

        res.json({
            message: product.isActive ? "تم تفعيل المنتج" : "تم إيقاف المنتج",
            product: stripBase64Image(product.toObject()),
        });

    } catch (error) {
        res.status(error.status || 500).json({ message: error.message });
    }
};
// ================= جلب منتجات المتجر الخاص بصاحب الحساب =================
exports.getMyProducts = async (req, res) => {
    try {
        const store = await Store.findOne({ owner: req.user.id, isActive: true });
        if (!store) return res.status(404).json({ message:  "لا يوجد متجر مرتبط بحسابك راجع الادارة" });
                


        const filter = { store: store._id };
        if (req.query.all !== "true") filter.isActive = true;

        const products = await Product.find(filter)
            .select(PRODUCT_LIST_SELECT)
            .populate("storeItemCategory", "name isActive")
            .sort({ createdAt: -1 })
            .lean();

        res.json({ products: products.map(stripBase64Image) });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};
// product.Controller.js    تعديل المنتج
exports.updateProduct = async (req, res) => {
    try {
        assertNoMongoOperators(req.body, "product");
        const productId = requireObjectId(req.params.id, "id");
        const product = await Product.findById(productId);
        if (!product) return res.status(404).json({ message: "المنتج غير موجود" });

        const allowed = ["name", "description", "price", "currency", "priceUnit", "image", "isWholesale", "storeItemCategoryId", "freeDelivery", "isActive", "purchaseMode", "reservationSettings"];
        for (const field of allowed) {
            if (req.body[field] === undefined) continue;
            if (field === "storeItemCategoryId") {
                product.storeItemCategory = req.body.storeItemCategoryId
                  ? requireObjectId(req.body.storeItemCategoryId, "storeItemCategoryId")
                  : null;
            } else if (field === "image" && typeof req.body.image === "string" && req.body.image.trim()) {
                product.image = await processDataUrlImage(req.body.image.trim(), {
                    enforceCloudinaryHttps: true,
                    previousValue: product.image,
                });
            } else if (field === "price") {
                product.price = numberInRange(req.body.price, { field: "price", min: 0, max: 10_000_000, required: true });
            } else if (field === "currency") {
                product.currency = normalizeCurrency(req.body.currency);
            } else if (field === "name") {
                product.name = cleanString(req.body.name, { field: "name", max: 120, required: true });
            } else if (field === "description") {
                product.description = cleanString(req.body.description, { field: "description", max: 1000 });
            } else if (field === "isWholesale") {
                product.isWholesale = !!req.body.isWholesale;
            } else if (field === "freeDelivery") {
                product.freeDelivery = !!req.body.freeDelivery;
            } else if (field === "isActive") {
                product.isActive = !!req.body.isActive;
            } else if (field === "purchaseMode") {
                product.purchaseMode = normalizePurchaseMode(req.body.purchaseMode);
            } else if (field === "reservationSettings") {
                product.reservationSettings = normalizeReservationSettings(req.body.reservationSettings);
            } else if (field === "priceUnit") {
                product.priceUnit = cleanString(req.body.priceUnit, { field: "priceUnit", max: 40 });
            } else {
                product[field] = req.body[field];
            }
        }
        await product.save();
        res.json({ message: "تم التحديث", product });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
};


