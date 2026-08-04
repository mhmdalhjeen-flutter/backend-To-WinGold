const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },

    description: {
        type: String,
    },

    category: { // تصنيف المنتج (مثلاً: ملابس، إلكترونيات، مواد غذائية)
        type: String,
    },

    price: { // سعر البيع للزبون (قطاعي)
        type: Number,
        required: true,
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

    wholesalePrice: { // سعر البيع بالجملة (يظهر لأصحاب المتاجر فقط)
        type: Number,
    },

    isWholesale: { // هل المنتج متاح للبيع بالجملة؟
        type: Boolean,
        default: false,
    },

    minOrderQuantity: { // أقل كمية للطلب بالجملة
        type: Number,
        default: 1,
    },

    image: {
        type: String,
    },

    stock: {
        type: Number,
        default: 0,
    },

    freeDelivery: {
        type: Boolean,
        default: false,
    },

    isFeatured: { // تمييز المنتج في واجهة المحل
        type: Boolean,
        default: false,
    },

    /** أولوية عرض يدوية اختيارية — null = الترتيب التلقائي الحالي */
    displayPriority: { type: Number, default: null },

    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    views: { type: Number, default: 0, min: 0 },

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

    /** quantity = by count/weight unit, price = by money amount, both = customer chooses */
    purchaseMode: {
        type: String,
        enum: ["quantity", "price", "both"],
        default: "quantity",
    },

    isActive: {
        type: Boolean,
        default: true,
    },
    

}, {
    timestamps: true,
});

productSchema.index({ store: 1, isActive: 1, isWholesale: 1, createdAt: -1 });
productSchema.index({ isWholesale: 1, isActive: 1 });

module.exports = mongoose.model("Product", productSchema);
