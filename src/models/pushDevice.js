const mongoose = require("mongoose");

/**
 * Web Push subscription for a user device (PWA browser).
 * Stored separately from User — no tokens on the user document.
 */
const pushDeviceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    app: {
      type: String,
      enum: ["customer", "store"],
      required: true,
    },
    platform: {
      type: String,
      enum: ["web"],
      default: "web",
    },
    subscription: {
      endpoint: { type: String, required: true },
      expirationTime: { type: Number, default: null },
      keys: {
        p256dh: { type: String, required: true },
        auth: { type: String, required: true },
      },
    },
  },
  { timestamps: true }
);

pushDeviceSchema.index({ "subscription.endpoint": 1 }, { unique: true });
pushDeviceSchema.index({ userId: 1, app: 1 });

module.exports =
  mongoose.models.PushDevice ||
  mongoose.model("PushDevice", pushDeviceSchema);
