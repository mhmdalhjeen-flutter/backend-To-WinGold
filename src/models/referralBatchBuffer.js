const mongoose = require("mongoose");

/**
 * مخزن مؤقت لتجميع مكافآت الإحالة قبل إرسال إشعار واحد للمستخدم.
 * يُفرَّغ بعد فترة debounce قصيرة.
 */
const referralBatchBufferSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    count: { type: Number, default: 0 },
    totalPoints: { type: Number, default: 0 },
  },
  { timestamps: true }
);

referralBatchBufferSchema.index({ updatedAt: 1 });

module.exports =
  mongoose.models.ReferralBatchBuffer ||
  mongoose.model("ReferralBatchBuffer", referralBatchBufferSchema);
