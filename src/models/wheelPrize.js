const mongoose = require("mongoose");

/**
 * جائزة عجلة الحظ.
 * displayWeight = حجم القطاع على العجلة (نسبة الظهور).
 * winWeight = احتمال الفوز الفعلي (0 = تظهر لكن لا تُفوز بها).
 */
const wheelPrizeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    icon: { type: String, default: "🎁" },
    image: { type: String, default: null },
    color: { type: String, required: true, default: "#6366f1" },
    minPoints: { type: Number, default: 0, min: 0 },
    displayWeight: { type: Number, required: true, min: 0, default: 10 },
    winWeight: { type: Number, required: true, min: 0, default: 0 },
    prizeType: {
      type: String,
      enum: ["none", "points", "entries", "item"],
      default: "item",
    },
    prizeValue: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

wheelPrizeSchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("WheelPrize", wheelPrizeSchema);
