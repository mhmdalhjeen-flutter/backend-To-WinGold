const mongoose = require("mongoose");

const treasureBoxSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
    },
    boxType: {
        type: String,
        enum: ["daily", "promotional", "sponsored"],
        default: "daily"
    },
    store: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
        default: null // إذا كان الصندوق مخصصاً لدعاية محل تجاري معين
    },
    // المتطلبات التسويقية لفتح الصندوق
    requirements: {
        requireFollow: { type: Boolean, default: false },
        followLink: { type: String, default: "" }, // رابط صفحة المحل (فيسبوك، انستغرام، الخ)
        requireShare: { type: Boolean, default: false },
        shareCount: { type: Number, default: 0 }, // عدد الأصدقاء المطلوب إرسال الصفحة لهم
        adVideoUrl: { type: String, default: "" } // رابط فيديو إعلاني للمحل يجب مشاهدته
    },
    // المكافآت المحتملة داخل الصندوق ونسبها
    rewards: [{
        cardType: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "CardType",
            required: true
        },
        probability: {
            type: Number, // نسبة مئوية (مثلا 50 تعني 50%، أو وزن نسبي)
            required: true,
            default: 10
        }
    }],
    isActive: {
        type: Boolean,
        default: true
    },
    costInEnergy: { // إذا كان الصندوق يحتاج نقاط طاقة لفتحه (أو 0 إذا كان مجانياً للمهام التسويقية)
        type: Number,
        default: 0
    }
}, { timestamps: true });

module.exports = mongoose.model("TreasureBox", treasureBoxSchema);
