const mongoose = require("mongoose");

/** عضوية زبون في متجر — pending حتى إدخال كود، member بعد ذلك. */
const storeMembershipSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true, index: true },
    status: { type: String, enum: ["pending", "member"], default: "pending" },
    codesRedeemed: { type: Number, default: 0, min: 0 },
    memberSince: { type: Date, default: null },
  },
  { timestamps: true }
);

storeMembershipSchema.index({ user: 1, store: 1 }, { unique: true });

module.exports = mongoose.model("StoreMembership", storeMembershipSchema);
