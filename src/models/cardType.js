const mongoose = require("mongoose");

const cardTypeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    color: {
        type: String,
        default: "#FFD700" // default gold
    },
    pointsValue: {
        type: Number,
        required: true,
        default: 0
    },
    // سعر شراء البطاقة (يستخدمه الفرونت/طلبات الأكواد)
    price: {
        type: Number,
        default: 0
    },
    icon: {
        type: String, // يمكن تخزين اسم أيقونة من Lucide أو رابط صورة
        default: "credit-card"
    },
    description: {
        type: String,
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true }
});

// اسم بديل متوافق مع الفرونت: `points` ⇆ `pointsValue` (الحقل الأساسي)
cardTypeSchema.virtual("points")
    .get(function () { return this.pointsValue; })
    .set(function (v) { this.pointsValue = v; });

module.exports = mongoose.model("CardType", cardTypeSchema);
