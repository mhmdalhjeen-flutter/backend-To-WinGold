const mongoose = require("mongoose");

/** جوائز/حملات خاصة بأعضاء المتجر. */
const storeMemberPrizeSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    image: { type: String, default: null },
    icon: { type: String, default: "🎁" },
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StoreMemberPrize", storeMemberPrizeSchema);
