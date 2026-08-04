const mongoose = require("mongoose");

const ratingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetType: { type: String, enum: ["store", "offer", "product"], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    stars: { type: Number, required: true, min: 1, max: 5 },
  },
  { timestamps: true }
);

ratingSchema.index({ user: 1, targetType: 1, targetId: 1 }, { unique: true });
ratingSchema.index({ targetType: 1, targetId: 1 });

module.exports = mongoose.model("Rating", ratingSchema);
