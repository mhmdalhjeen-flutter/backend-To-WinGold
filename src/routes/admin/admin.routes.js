const express = require("express");
const router = express.Router();
const adminController = require("../../controllers/admin/admin.controller");
const dashboardController = require("../../controllers/admin/dashboard.controller");
const analyticsController = require("../../controllers/admin/analytics.controller");
const heatmapController = require("../../controllers/admin/heatmap.controller");
const boxAdminController = require("../../controllers/box-admin.controller");
const authMiddleware = require("../../middleware/auth.middleware");
const roleMiddleware = require("../../middleware/role.middleware");
const adminMiddleware = require("../../middleware/admin.middleware");
const { createCodeBusiness, listActivationKeys, deleteActivationKey } = require("../../controllers/admin/activationCodeBusiness.controller");
const {
  generateAdminCodes,
  listAdminCodes,
  deleteAdminCode,
} = require("../../controllers/admin/adminCode.controller");
const Store   = require('../../models/store');
const Product = require('../../models/product');
const Offer   = require('../../models/offer');
const Cart    = require('../../models/Cart');
const User    = require('../../models/user');
const { createStoreActivationCode } = require("../../controllers/activation.controller");
const bazaarAdmin = require("../../controllers/admin/bazaar-admin.controller");
const achievementAdmin = require("../../controllers/admin/achievement-admin.controller");
const displayPriorityAdmin = require("../../controllers/admin/display-priority-admin.controller");
const userCenter = require("../../controllers/user-center.controller");
const usersAdmin = require("../../controllers/admin/users-admin.controller");
const deliveryCompanyAdmin = require("../../controllers/admin/delivery-company-admin.controller");
const deliveryProofAdmin = require("../../controllers/admin/delivery-proof-admin.controller");
const storeSubscriptionAdmin = require("../../controllers/admin/store-subscription-admin.controller");
const deliveryBillingAdmin = require("../../controllers/admin/delivery-billing-admin.controller");
const monthlyCycleSimulationAdmin = require("../../controllers/admin/monthly-cycle-simulation.controller");
const auditController = require("../../controllers/admin/audit.controller");
const adminSensitiveController = require("../../controllers/admin-sensitive.controller");
const adminAuditMiddleware = require("../../middleware/adminAudit.middleware");
const { requireObjectId } = require("../../utils/inputSecurity.util");

const ADMIN_STORE_LIST_SELECT = "name phone whatsapp region subRegion regionId subRegionId category logo isActive isVerifiedStore displayPriority owner cards bypassCards subscriptionActive createdAt";
const ADMIN_PRODUCT_LIST_SELECT = "name description price currency wholesalePrice isWholesale minOrderQuantity image stock freeDelivery isActive displayPriority createdAt";
const ADMIN_OFFER_LIST_SELECT = "title description offerType value originalPrice finalPrice currency image freeDelivery isActive priority featuredPriority displayPriority expiresAt createdAt";

function stripBase64ListImage(row, field = "image") {
    if (!row || typeof row !== "object") return row;
    const plain = { ...row };
    if (typeof plain[field] === "string" && plain[field].startsWith("data:")) {
        plain[field] = null;
        plain[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`] = true;
    }
    return plain;
}

// ─── حماية مشتركة ────────────────────────────────────────────────────────────
// كل مسارات الأدمن تتطلب تسجيل دخول + دور admin (إغلاق ثغرة تصعيد الصلاحيات)
router.use(authMiddleware);
router.use(roleMiddleware(["admin"]));

router.use(async (req, res, next) => {
    if (req.user?.id) {
        req.userDoc = await User.findById(req.user.id).select("name email role").lean();
    }
    next();
});

router.use(adminAuditMiddleware);

// ─── كلمة مرور الصفحات الحساسة (SensitiveGate) ───────────────────────────────
router.get("/sensitive/status", adminSensitiveController.getStatus);
router.post("/sensitive/setup", adminSensitiveController.setupPassword);
router.post("/sensitive/verify", adminSensitiveController.verifyPassword);
router.post("/sensitive/change", adminSensitiveController.changePassword);
router.post("/sensitive/revoke", adminSensitiveController.revokeSensitiveSession);

// ─── سجل التدقيق والأمان ─────────────────────────────────────────────────────
router.get("/audit/activity", auditController.getActivityLogs);
router.get("/audit/login", auditController.getLoginLogs);
router.get("/audit/security", auditController.getSecurityLogs);
router.get("/audit/filters", auditController.getAuditFilters);
router.get("/audit/export", auditController.exportLogs);
router.get("/audit/:id", auditController.getLogById);
router.get("/activity-logs", auditController.getActivityLogs);
router.get("/security-logs", auditController.getSecurityLogs);

// ─── أكواد التفعيل ───────────────────────────────────────────────────────────
router.post("/create-code",          roleMiddleware(["admin"]), createStoreActivationCode);
router.post("/create-code-business", roleMiddleware(["admin"]), createCodeBusiness);
router.get("/activation-keys",       listActivationKeys);
router.delete("/activation-keys/:id", adminMiddleware, deleteActivationKey);

// ─── أكواد الأدمن (نقاط — بدون متجر) ───────────────────────────────────────
router.post("/admin-codes/generate", roleMiddleware(["admin"]), generateAdminCodes);
router.get("/admin-codes", listAdminCodes);
router.delete("/admin-codes/:id", adminMiddleware, deleteAdminCode);

// ─── إعدادات النظام ──────────────────────────────────────────────────────────
router.post("/settings/home-video", adminController.updateSystemSettings);
router.post("/settings",             adminController.updateSystemSettings);
router.get("/settings",             adminController.getSystemSettings);

// ─── إدارة البطاقات والصناديق ────────────────────────────────────────────────
router.post("/cards",          boxAdminController.createCardType);
router.get("/cards",           boxAdminController.getCardTypes);
router.post("/treasure-boxes", boxAdminController.createTreasureBox);
router.get("/treasure-boxes",  boxAdminController.getTreasureBoxes);

// ─── إحصائيات وتنبيهات ───────────────────────────────────────────────────────
router.get("/dashboard/summary", dashboardController.getDashboardSummary);
router.get("/dashboard", dashboardController.getDashboard);
router.get("/dashboard/users-by-region", dashboardController.getUsersByRegion);
router.get("/dashboard/stores-by-region", dashboardController.getStoresByRegion);
router.get("/dashboard/orders-daily", dashboardController.getOrdersDaily);
router.get("/stats", dashboardController.getStats);
router.get("/analytics", analyticsController.getAnalytics);
router.get("/heatmaps", heatmapController.getHeatMaps);
router.get("/security-alerts", adminController.getSecurityAlerts);

// ─── إدارة المستخدمين ────────────────────────────────────────────────────────
router.get("/users/search",          adminController.searchUsers);
router.get("/users/options",         usersAdmin.getFilterOptions);
router.get("/users/count",           adminController.getUsersCount);
router.patch("/users/update-manual", adminController.updateUserManually);
router.get("/users",                 usersAdmin.listUsers);
router.get("/users/:id",             usersAdmin.getUserDetail);
router.delete("/users/:id",          adminMiddleware, adminController.deleteUser);
router.patch("/users/:id/ban",       adminMiddleware, adminController.banUser);

// ─── أكواد التفعيل ───────────────────────────────────────────────────────────
router.post("/activation-code",       adminController.generateBulkCodes);
router.post("/generate-bulk-codes",   adminController.generateBulkCodes);
router.post("/codes/generate",        adminController.generateBulkCodes);
router.get("/codes",                  adminController.getAllCodes);
router.get("/check-code/:code",       adminController.checkCode);
router.get("/code",                   adminController.getCodes);
router.delete("/codes/:id",           adminMiddleware, adminController.deleteCode);
router.post("/codes/delete-bulk",     adminMiddleware, adminController.deleteBulkCodes);

// ─── التصنيفات ───────────────────────────────────────────────────────────────
router.get("/categories",  adminController.getCategories);
router.post("/categories", adminController.addCategory);

// ─── السحوبات ────────────────────────────────────────────────────────────────
router.get("/draws",                adminController.getAllDraws);
router.post("/draws",               adminController.createDraw);
router.patch("/draws/:drawId/approve", adminController.approveDraw);
router.post("/draws/:drawId/draw-winners", adminController.drawWinners);

// ─── سجل النشاطات ────────────────────────────────────────────────────────────
router.get("/activity-logs", adminController.getActivityLogs);

// =============================================================================
// من هنا: endpoints الأدمن الجديدة (تطبق adminMiddleware على كل ما يليها)
// =============================================================================
router.use(adminMiddleware);

// ─── GET /admin/stores ───────────────────────────────────────────────────────
// جلب جميع المتاجر والمستودعات مع role المالك
// الفرونت يفرق بين store وsupplier عبر owner.role
router.get('/stores', async (req, res) => {
    try {
        const { type } = req.query; // type=store | type=supplier | فارغ = الكل

        // populate المالك مع role لأنه الأساس في التمييز بين متجر ومستودع
        let stores = await Store.find()
            .select(ADMIN_STORE_LIST_SELECT)
            .populate('owner', 'name email phone role')
            .sort({ createdAt: -1 })
            .lean();

        // فلترة حسب نوع الحساب إذا طُلب
        if (type === 'supplier' || type === 'store') {
            stores = stores.filter(s => s.owner?.role === type);
        }

        res.json(stores.map((s) => stripBase64ListImage(s, "logo")));
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/stores/:storeId/subscription ───────────────────────────────
router.patch('/stores/:storeId/subscription', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: 'المتجر غير موجود' });

        if (typeof req.body?.subscriptionActive === 'boolean') {
            store.subscriptionActive = req.body.subscriptionActive;
        } else {
            store.subscriptionActive = store.subscriptionActive === false;
        }
        await store.save();
        res.json({
            message: store.subscriptionActive ? 'تم تفعيل اشتراك المتجر' : 'تم إيقاف اشتراك المتجر',
            subscriptionActive: store.subscriptionActive,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/stores/:storeId/toggle ─────────────────────────────────────
router.patch('/stores/:storeId/toggle', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: 'المتجر غير موجود' });
        store.isActive = !store.isActive;
        await store.save();
        res.json({ message: store.isActive ? 'تم تفعيل المتجر' : 'تم إيقاف المتجر', isActive: store.isActive });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// تطابق مع الروت القديم toggle-status
router.patch('/stores/:storeId/toggle-status', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: 'المتجر غير موجود' });
        store.isActive = !store.isActive;
        await store.save();
        res.json({ message: store.isActive ? 'تم تفعيل المتجر' : 'تم إيقاف المتجر', isActive: store.isActive });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── DELETE /admin/stores/:storeId ───────────────────────────────────────────
router.delete('/stores/:storeId', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findByIdAndDelete(storeId);
        if (!store) return res.status(404).json({ message: 'المتجر غير موجود' });
        await Product.deleteMany({ store: storeId });
        await Offer.deleteMany({ store: storeId });
        res.json({ message: 'تم حذف المتجر وجميع بياناته' });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── GET /admin/stores/:storeId/products ─────────────────────────────────────
// جلب منتجات متجر معين (للأدمن)
router.get('/stores/:storeId/products', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const products = await Product.find({ store: storeId })
            .select(ADMIN_PRODUCT_LIST_SELECT)
            .sort({ createdAt: -1 })
            .lean();
        res.json(products.map((p) => stripBase64ListImage(p, "image")));
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── GET /admin/stores/:storeId/offers ───────────────────────────────────────
// جلب عروض متجر معين (للأدمن)
router.get('/stores/:storeId/offers', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const offers = await Offer.find({ store: storeId })
            .select(ADMIN_OFFER_LIST_SELECT)
            .sort({ createdAt: -1 })
            .lean();
        res.json(offers.map((o) => stripBase64ListImage(o, "image")));
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/stores/:storeId/verify ─────────────────────────────────────
router.patch('/stores/:storeId/verify', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: 'المتجر غير موجود' });

        if (typeof req.body?.isVerifiedStore === 'boolean') {
            store.isVerifiedStore = req.body.isVerifiedStore;
        } else {
            store.isVerifiedStore = !store.isVerifiedStore;
        }
        await store.save();
        res.json({
            message: store.isVerifiedStore ? 'تم توثيق المتجر' : 'تم إلغاء توثيق المتجر',
            isVerifiedStore: store.isVerifiedStore,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/stores/:storeId/display-priority ───────────────────────────
router.patch('/stores/:storeId/display-priority', async (req, res) => {
    try {
        const storeId = requireObjectId(req.params.storeId, "storeId");
        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ message: 'المتجر غير موجود' });

        const raw = req.body?.displayPriority;
        if (raw === null || raw === '' || raw === undefined) {
            store.displayPriority = null;
        } else {
            const num = parseInt(raw, 10);
            if (!Number.isFinite(num) || num < 1) {
                return res.status(400).json({ message: 'أولوية العرض يجب أن تكون رقماً موجباً أو فارغة' });
            }
            store.displayPriority = num;
        }
        await store.save();
        res.json({
            message: 'تم تحديث أولوية عرض المتجر',
            displayPriority: store.displayPriority,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/offers/:offerId/featured-priority ──────────────────────────
router.patch('/offers/:offerId/featured-priority', async (req, res) => {
    try {
        const offerId = requireObjectId(req.params.offerId, "offerId");
        const offer = await Offer.findById(offerId);
        if (!offer) return res.status(404).json({ message: 'العرض غير موجود' });

        const raw = req.body?.displayPriority ?? req.body?.featuredPriority;
        if (raw === null || raw === '' || raw === undefined) {
            offer.displayPriority = null;
            offer.featuredPriority = null;
        } else {
            const num = parseInt(raw, 10);
            if (!Number.isFinite(num) || num < 1) {
                return res.status(400).json({ message: 'أولوية العرض يجب أن تكون رقماً موجباً أو فارغة' });
            }
            offer.displayPriority = num;
            offer.featuredPriority = num;
        }
        await offer.save();
        res.json({
            message: 'تم تحديث أولوية عرض العرض',
            displayPriority: offer.displayPriority,
            featuredPriority: offer.featuredPriority,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/offers/:offerId/display-priority ───────────────────────────
router.patch('/offers/:offerId/display-priority', async (req, res) => {
    try {
        const offerId = requireObjectId(req.params.offerId, "offerId");
        const offer = await Offer.findById(offerId);
        if (!offer) return res.status(404).json({ message: 'العرض غير موجود' });

        const raw = req.body?.displayPriority;
        if (raw === null || raw === '' || raw === undefined) {
            offer.displayPriority = null;
            offer.featuredPriority = null;
        } else {
            const num = parseInt(raw, 10);
            if (!Number.isFinite(num) || num < 1) {
                return res.status(400).json({ message: 'أولوية العرض يجب أن تكون رقماً موجباً أو فارغة' });
            }
            offer.displayPriority = num;
            offer.featuredPriority = num;
        }
        await offer.save();
        res.json({
            message: 'تم تحديث أولوية عرض العرض',
            displayPriority: offer.displayPriority,
            featuredPriority: offer.featuredPriority,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/products/:productId/toggle ─────────────────────────────────
router.patch('/products/:productId/toggle', async (req, res) => {
    try {
        const productId = requireObjectId(req.params.productId, "productId");
        const product = await Product.findById(productId);
        if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });
        product.isActive = !product.isActive;
        await product.save();
        res.json({ message: product.isActive ? 'تم إظهار المنتج' : 'تم إخفاء المنتج', isActive: product.isActive });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/products/:productId/display-priority ───────────────────────
router.patch('/products/:productId/display-priority', async (req, res) => {
    try {
        const productId = requireObjectId(req.params.productId, "productId");
        const product = await Product.findById(productId);
        if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });

        const raw = req.body?.displayPriority;
        if (raw === null || raw === '' || raw === undefined) {
            product.displayPriority = null;
        } else {
            const num = parseInt(raw, 10);
            if (!Number.isFinite(num) || num < 1) {
                return res.status(400).json({ message: 'أولوية العرض يجب أن تكون رقماً موجباً أو فارغة' });
            }
            product.displayPriority = num;
        }
        await product.save();
        res.json({
            message: 'تم تحديث أولوية عرض المنتج',
            displayPriority: product.displayPriority,
        });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── DELETE /admin/products/:productId ───────────────────────────────────────
router.delete('/products/:productId', async (req, res) => {
    try {
        const productId = requireObjectId(req.params.productId, "productId");
        const product = await Product.findByIdAndDelete(productId);
        if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });
        res.json({ message: 'تم حذف المنتج' });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── PATCH /admin/offers/:offerId/toggle ─────────────────────────────────────
router.patch('/offers/:offerId/toggle', async (req, res) => {
    try {
        const offerId = requireObjectId(req.params.offerId, "offerId");
        const offer = await Offer.findById(offerId);
        if (!offer) return res.status(404).json({ message: 'العرض غير موجود' });
        offer.isActive = !offer.isActive;
        await offer.save();
        res.json({ message: offer.isActive ? 'تم إظهار العرض' : 'تم إخفاء العرض', isActive: offer.isActive });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── DELETE /admin/offers/:offerId ───────────────────────────────────────────
router.delete('/offers/:offerId', async (req, res) => {
    try {
        const offerId = requireObjectId(req.params.offerId, "offerId");
        const offer = await Offer.findByIdAndDelete(offerId);
        if (!offer) return res.status(404).json({ message: 'العرض غير موجود' });
        res.json({ message: 'تم حذف العرض' });
    } catch (err) {
        res.status(err.status || 500).json({ message: err.message });
    }
});

// ─── BazaarX — موافقة إعلانات سوق الأفراد ───────────────────────────────────
router.get("/bazaar", bazaarAdmin.list);
router.get("/bazaar/:id", bazaarAdmin.getOne);
router.patch("/bazaar/:id/approve", bazaarAdmin.approve);
router.patch("/bazaar/:id/reject", bazaarAdmin.reject);
router.delete("/bazaar/:id", bazaarAdmin.remove);

router.get("/achievements", achievementAdmin.list);
router.post("/achievements", achievementAdmin.create);
router.put("/achievements/:id", achievementAdmin.update);
router.delete("/achievements/:id", achievementAdmin.remove);
router.patch("/achievements/reorder", achievementAdmin.reorder);

// ─── إدارة أولويات العرض (سحب وإفلات) ───────────────────────────────────────
router.get("/display-priority/main-categories", displayPriorityAdmin.listMainCategories);
router.get("/display-priority/second-levels", displayPriorityAdmin.listSecondLevels);
router.get("/display-priority/stores", displayPriorityAdmin.listStores);
router.get("/display-priority/stores/:storeId/catalog", displayPriorityAdmin.listCatalog);
router.patch("/display-priority/categories/reorder", displayPriorityAdmin.reorderCategories);
router.patch("/display-priority/stores/reorder", displayPriorityAdmin.reorderStores);
router.patch("/display-priority/offers/reorder", displayPriorityAdmin.reorderOffers);
router.patch("/display-priority/products/reorder", displayPriorityAdmin.reorderProducts);

router.get("/suggestions", userCenter.listSuggestionsAdmin);
router.patch("/suggestions/:id", userCenter.updateSuggestionAdmin);

// ─── شركات الدلفري ───────────────────────────────────────────────────────────
router.get("/delivery-companies", deliveryCompanyAdmin.list);
router.post("/delivery-companies", deliveryCompanyAdmin.create);
router.put("/delivery-companies/:id", deliveryCompanyAdmin.update);
router.patch("/delivery-companies/:id/toggle", deliveryCompanyAdmin.toggle);
router.delete("/delivery-companies/:id", deliveryCompanyAdmin.remove);
router.patch("/delivery-companies/:id/areas", deliveryCompanyAdmin.updateAreas);
router.patch("/delivery-companies/:id/payment-methods", deliveryCompanyAdmin.updatePaymentMethods);
router.get("/delivery-companies/:id/payment-accounts", deliveryCompanyAdmin.listPaymentAccounts);
router.post("/delivery-companies/:id/payment-accounts", deliveryCompanyAdmin.createPaymentAccount);
router.put("/delivery-companies/:id/payment-accounts/:accountId", deliveryCompanyAdmin.updatePaymentAccount);
router.delete("/delivery-companies/:id/payment-accounts/:accountId", deliveryCompanyAdmin.deletePaymentAccount);
router.post("/delivery-companies/:id/portal-account", deliveryCompanyAdmin.createPortalAccount);
router.put("/delivery-companies/:id/portal-account", deliveryCompanyAdmin.updatePortalAccount);

router.get("/delivery-proofs", deliveryProofAdmin.list);
router.get("/delivery-proofs/orders", deliveryProofAdmin.listOrders);
router.get("/delivery-proofs/filter-options", deliveryProofAdmin.filterOptions);
router.get("/delivery-proofs/:sessionId/orders/:orderId", deliveryProofAdmin.getOrderDetail);
router.get("/delivery-proofs/:id", deliveryProofAdmin.getOne);

// ─── اشتراك المتاجر الشهري ───────────────────────────────────────────────────
router.get("/store-subscriptions", storeSubscriptionAdmin.listSubscriptionCards);
router.patch("/store-subscriptions/periods/:periodId/approve", storeSubscriptionAdmin.approveSubscriptionPayment);
router.patch("/store-subscriptions/periods/:periodId/reject", storeSubscriptionAdmin.rejectSubscriptionPayment);
router.patch("/store-subscriptions/stores/:storeId/exempt", storeSubscriptionAdmin.exemptStoreSubscription);
router.post("/store-subscriptions/exempt-all-except", storeSubscriptionAdmin.exemptAllExcept);
router.patch("/store-subscriptions/stores/:storeId/card-quantities", storeSubscriptionAdmin.setStoreCardQuantities);
router.get("/store-subscriptions/periods/:periodId/export-paper-codes", storeSubscriptionAdmin.exportSubscriptionPaperCodes);
router.get("/store-subscriptions/stores/:storeId/contact", storeSubscriptionAdmin.getStoreOwnerContact);

router.get("/subscription-payment-methods", storeSubscriptionAdmin.listPlatformPaymentAccounts);
router.post("/subscription-payment-methods", storeSubscriptionAdmin.createPlatformPaymentAccount);
router.patch("/subscription-payment-methods/:accountId", storeSubscriptionAdmin.updatePlatformPaymentAccount);
router.patch("/subscription-payment-methods/:accountId/activate", storeSubscriptionAdmin.activatePlatformPaymentAccount);
router.delete("/subscription-payment-methods/:accountId", storeSubscriptionAdmin.deletePlatformPaymentAccount);

// ─── اشتراك شركات التوصيل الشهري ─────────────────────────────────────────────
router.get("/delivery-subscriptions", deliveryBillingAdmin.listBillingCards);
router.patch("/delivery-subscriptions/periods/:periodId/approve", deliveryBillingAdmin.approveBillingPayment);
router.patch("/delivery-subscriptions/periods/:periodId/reject", deliveryBillingAdmin.rejectBillingPayment);
router.patch("/delivery-subscriptions/periods/:periodId/exempt", deliveryBillingAdmin.exemptBillingPeriod);
router.patch("/delivery-subscriptions/companies/:companyId/price-per-order", deliveryBillingAdmin.setPricePerOrder);
router.get("/delivery-subscriptions/companies/:companyId/history", deliveryBillingAdmin.getCompanyBillingHistory);
router.get("/delivery-subscriptions/companies/:companyId/handovers", deliveryBillingAdmin.getCompanyHandovers);

// ─── محاكاة دورة شهرية (اختبار — أدمن فقط) ─────────────────────────────────
router.get("/monthly-cycle-simulation/status", monthlyCycleSimulationAdmin.getSimulationStatus);
router.post("/monthly-cycle-simulation/run", monthlyCycleSimulationAdmin.runMonthlyCycleSimulation);

module.exports = router;