const mongoose = require("mongoose");

const honorBoardSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    title: {
        type: String,
        required: true, // مثال: بطل الأسبوع، صائد الجوائز
    },
    message: {
        type: String,
        required: true, // مثال: فاز بآيفون 15 بعد إدخال 50 كود!
    },
    awardImage: {
        type: String, // صورة الجائزة
        default: null
    },
    winnerImage: {
        type: String, // صورة الفائز (اختياري — يُستخدم avatar المستخدم إن غاب)
        default: null
    },
    prizeName: {
        type: String, // اسم الجائزة
        default: "",
    },
    receivedAt: {
        type: Date, // تاريخ الاستلام
        default: null,
    },
    competitionLink: {
        type: String, // رابط المسابقة إن وجد
        default: null,
    },
    isPrimary: {
        type: Boolean, // فائز رئيسي vs فرعي
        default: false,
    },
    displayUntil: {
        type: Date,
        required: true, // الوقت الذي تختفي فيه البطاقة تلقائياً
    },
    priority: {
        type: Number,
        default: 0, // لترتيب الظهور (الأعلى يظهر أولاً)
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// index to automatically find active/unexpired items
honorBoardSchema.index({ displayUntil: 1, isActive: 1 });

module.exports = mongoose.model("HonorBoard", honorBoardSchema);
