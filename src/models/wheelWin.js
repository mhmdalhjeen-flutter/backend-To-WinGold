const mongoose = require("mongoose");

const PURGE_DAYS = 5;

const wheelWinSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    prize: { type: mongoose.Schema.Types.ObjectId, ref: "WheelPrize", required: true },
    spin: { type: mongoose.Schema.Types.ObjectId, ref: "WheelSpin", required: true },
    userName: { type: String, default: "" },
    userPhone: { type: String, default: "" },
    userAddress: { type: String, default: "" },
    prizeName: { type: String, required: true },
    deliveryStatus: {
      type: String,
      enum: ["pending", "contacted", "delivered", "cancelled"],
      default: "pending",
    },
    hiddenFromAdmin: { type: Boolean, default: false, index: true },
    purgeAt: { type: Date, default: null, index: true },
    adminNotes: { type: String, default: "" },
    wonAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

wheelWinSchema.statics.PURGE_DAYS = PURGE_DAYS;

module.exports = mongoose.model("WheelWin", wheelWinSchema);
