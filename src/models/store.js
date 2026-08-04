const mongoose = require("mongoose");

const storeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },

    description: {
        type: String,
    },

    phone: {
        type: String,
        required: true,
    },

    whatsapp: {
        type: String,
    },

    region: {
        type: String,
        required: true,
    },

    regionId: { type: mongoose.Schema.Types.ObjectId, ref: "Region", default: null },
    subRegionId: { type: mongoose.Schema.Types.ObjectId, ref: "Region", default: null },

    subRegion: {
        type: String,
        required: true,
    },

    address: {
        type: String,
    },

    category: {
        type: String,
        required: true,
    },

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },

    logo: {
        type: String,
    },

    coverImage: {
        type: String,
    },

    /** هل شاهد صاحب المتجر نافذة ترحيب الصورة/الغلاف */
    brandingWelcomeSeen: {
        type: Boolean,
        default: false,
    },

    isActive: {
        type: Boolean,
        default: false,
    },

    activationCode: {
        type: String,
    },

    // --- نظام التحكم في الميزات (Feature Toggling) ---
    features: {
        aiTools: { type: Boolean, default: false }, // مساعد الذكاء الاصطناعي
        priorityOffers: { type: Boolean, default: false }, // العروض المميزة
        advancedAnalytics: { type: Boolean, default: false }, // إحصائيات متقدمة
        gamification: { type: Boolean, default: false } // نظام الألعاب والمكافآت
    },

    // --- إحصائيات الاستخدام للتحكم الإداري والمالي ---
    usageStats: {
        aiContentGenerated: { type: Number, default: 0 },
        aiImagesImproved: { type: Number, default: 0 },
        priorityOffersUsed: { type: Number, default: 0 }
    },

    // أقصى مدة مسموحة لبقاء العرض فعالاً (بالأيام)
    maxOfferDays: {
        type: Number,
        default: 30
    },

    totalVisits: {
        type: Number,
        default: 0
    },

    todayVisits: {
        type: Number,
        default: 0
    },

    /** Visits during the current calendar month (resets when month changes). */
    monthlyVisits: {
        type: Number,
        default: 0,
    },

    /** Month bucket for monthlyVisits, e.g. 2026-07 */
    monthlyVisitsKey: {
        type: String,
        default: "",
    },

    customersCount: {
        type: Number,
        default: 0
    },

    codesEntered: {
        type: Number,
        default: 0
    },

    /** بصمة فريدة لأكواد الكروت — تُولَّد عند إنشاء المتجر */
    codePrefix: {
        type: String,
        unique: true,
        sparse: true,
        uppercase: true,
        trim: true,
    },

    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },

    cards: {
    type: Number,
    default: 0,          // عدد الكروت المتاحة
    },

    bypassCards: {
        type: Boolean,
        default: false,      // الأدمن يفعّلها ليتخطى شرط الكروت
    },

    /** متجر موثّق — يُعدّل من الأدمن فقط */
    isVerifiedStore: {
        type: Boolean,
        default: false,
    },

    /** اشتراك المتجر — عند false يُخفى المتجر ويُمنع صاحبه من لوحة التحكم */
    subscriptionActive: {
        type: Boolean,
        default: true,
    },

    /** أولوية عرض يدوية داخل التصنيف — null = نظام التوصيات الحالي */
    displayPriority: { type: Number, default: null },

    address: { type: String, default: "" },

    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },

    /** Currency acceptance preferences for checkout display */
    currencyPreferences: {
        acceptsWornCurrency: { type: Boolean, default: true },
        acceptsOldCurrency: { type: Boolean, default: false },
        acceptsAllCurrencyTypes: { type: Boolean, default: false },
    },
}, {
    timestamps: true,
});

storeSchema.index({ owner: 1 });
storeSchema.index({ isActive: 1, createdAt: -1 });
storeSchema.index({ isActive: 1, regionId: 1 });
storeSchema.index({ isActive: 1, subRegionId: 1 });
storeSchema.index({ isActive: 1, categoryId: 1 });

module.exports = mongoose.model("Store", storeSchema);
