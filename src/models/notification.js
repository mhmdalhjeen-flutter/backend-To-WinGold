const mongoose = require("mongoose");

/**
 * إشعار موحّد (AD-008): خدمة إشعارات مركزية لكل أنواع الإشعارات في النظام.
 * type أمثلة: offer_expiring, offer_expired, offer_renewed, general, ...
 * data: حقل مرن لأي بيانات سياقية (offerId, competitionId, url, ...).
 */
const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: { type: String, default: "general" },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

module.exports =
  mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
