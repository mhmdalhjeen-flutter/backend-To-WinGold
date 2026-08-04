const mongoose = require("mongoose");

const dailyPrizeSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
    },
    prizeType: {
        type: String,
        enum: ["discount_code", "product", "points", "entries"],
        required: true
    },
    value: {
        type: mongoose.Schema.Types.Mixed, // القيمة (مثلاً كود الخصم، عدد النقاط، أو اسم المنتج)
        required: true
    },
    store: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Store",
        default: null // يمكن أن تكون الجائزة من المنصة مباشرة أو من متجر
    },
    isActive: {
        type: Boolean,
        default: true
    },
    probability: { // احتمالية الظهور (اختياري للتحكم في الندرة)
        type: Number,
        default: 1 // 1 = عادي، 5 = نادر جداً
    }
}, { timestamps: true });

module.exports = mongoose.model("DailyPrize", dailyPrizeSchema);
