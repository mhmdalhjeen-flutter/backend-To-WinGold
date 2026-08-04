const mongoose = require("mongoose");

const activationCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true
  },

  // 👇 نوع الحساب الحقيقي
  role: {
    type: String,
    enum: ["store", "supplier"],
    required: true
  },

  // بصمة فريدة — تُستخدم لاحقاً لأكواد الكروت بعد تفعيل الحساب
  prefix: {
    type: String,
    lowercase: true,
    trim: true,
    default: null,
    index: true,
  },

  isUsed: {
    type: Boolean,
    default: false
  },

  usedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },

  expiresAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model("ActivationCode", activationCodeSchema);