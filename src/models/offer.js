const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema({
    title: { 
        type: String, 
        required: true 
    },

    description: { 
        type: String 
    },

    offerType: {
        type: String,
        enum: ["discount", "fixed_price", "bogo", "fixed_discount", "free_item", "custom"],
        required: true,
    },

    value: {
        type: Number,
        default: null,
    },

    originalPrice: {
        type: Number,
        default: null,
    },

    finalPrice: {
        type: Number,
        default: null,
    },

    freeDelivery: {
        type: Boolean,
        default: false,
    },

    currency: {
        type: String,
        enum: ["ILS", "JOD", "USD"],
        default: "ILS",
    },

    priceUnit: {
        type: String,
        trim: true,
        maxlength: 40,
    },

    image: {
        type: String,
    },

    priority: { // نظام الترتيب المميز (كلما زاد الرقم ظهر العرض أولاً)
        type: Number,
        default: 0
    },

    isFeatured: { // تمييز العرض كعرض "بطل" أو خاص
        type: Boolean,
        default: false
    },

    /** ترتيب يدوي من الأدمن — null = نظام التوصيات الحالي */
    featuredPriority: {
        type: Number,
        default: null,
    },

    /** أولوية عرض يدوية — null = نظام التوصيات الحالي (يُفضَّل على featuredPriority) */
    displayPriority: {
        type: Number,
        default: null,
    },

    shareCount: {
        type: Number,
        default: 0,
    },

    startDate: { // تاريخ بداية ظهور العرض
        type: Date,
        default: Date.now
    },

    expiresAt: { // تاريخ انتهاء العرض (المحدد من صاحب المحل)
        type: Date,
    },

    autoDeleteAt: { // تاريخ الحذف/الإيقاف التلقائي (المحدد من النظام)
        type: Date
    },

    isExtended: { // هل تم تمديد العرض (مدفوع)
        type: Boolean,
        default: false
    },

    deletionWarningSent: { // تحذير autoDeleteAt (قديم)
        type: Boolean,
        default: false
    },

    expiryWarningSent: { // تحذير قبل expiresAt بـ 24 ساعة
        type: Boolean,
        default: false
    },

    views: { // عدد المشاهدات
        type: Number,
        default: 0
    },

    clicks: { // عدد النقرات (المهتمين)
        type: Number,
        default: 0
    },

    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },

    store: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
        required: true,
    },

    storeItemCategory: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StoreItemCategory",
        default: null,
    },

    relatedProduct: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        default: null,
    },

    isActive: {
        type: Boolean,
        default: true,
    },

    /** quantity = by count/weight unit, price = by money amount, both = customer chooses */
    purchaseMode: {
        type: String,
        enum: ["quantity", "price", "both"],
        default: "quantity",
    },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },

}, {
    timestamps: true,
});

offerSchema.index({ isActive: 1, priority: -1, createdAt: -1 });
offerSchema.index({ store: 1, isActive: 1, priority: -1, createdAt: -1 });
offerSchema.index({ isActive: 1, expiresAt: 1, expiryWarningSent: 1 });
offerSchema.index({ isActive: 1, autoDeleteAt: 1 });

module.exports = mongoose.model("Offer", offerSchema);
