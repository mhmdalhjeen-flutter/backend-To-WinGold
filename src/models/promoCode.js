const mongoose = require("mongoose");

const promoCodeSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },

    store: { // المتجر المرتبط بالكود (اختياري في حال كان كود تسجيل عام)
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
        required: false 
    },

    rewardPoints: { // عدد النقاط التي يمنحها الكود
        type: Number,
        default: 0
    },

    rewardEntries: { // عدد فرص السحب التي يمنحها الكود
        type: Number,
        default: 0
    },

    isRegistrationCode: { // هل هذا كود لتفعيل حساب (صاحب متجر/تاجر)؟
        type: Boolean,
        default: false
    },

    /** دور الحساب عند isRegistrationCode — أولوية على بادئة الكود */
    registrationRole: {
        type: String,
        enum: ["store", "supplier"],
        default: null,
    },

    batchName: { // اسم الدفعة المطبوعة (لأغراض إدارية)
        type: String
    },

    usedBy: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        },
        usedAt: {
            type: Date,
            default: Date.now
        }
    }],

    isActive: {
        type: Boolean,
        default: true
    },

    maxUses: {
        type: Number,
        default: 1
    },

    currentUses: {
        type: Number,
        default: 0
    },

    /** مصدر الكرت — اشتراك شهري أو شراء مستقل */
    cardSource: {
        type: String,
        enum: ["subscription", "independent"],
        default: "independent",
    },

    subscriptionPeriodId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StoreSubscriptionPeriod",
        default: null,
    },

}, { timestamps: true });

promoCodeSchema.index({ createdAt: -1 });
promoCodeSchema.index({ store: 1, isRegistrationCode: 1, currentUses: 1 });
promoCodeSchema.index({ "usedBy.user": 1 });
promoCodeSchema.index({ subscriptionPeriodId: 1, store: 1, cardSource: 1 });

module.exports = mongoose.model("PromoCode", promoCodeSchema);
