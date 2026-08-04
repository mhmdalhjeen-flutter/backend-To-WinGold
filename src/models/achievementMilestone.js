const mongoose = require("mongoose");

const achievementMilestoneSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    icon: { type: String, default: "🏆" },
    image: { type: String, default: "" },
    pointsRequired: { type: Number, required: true, min: 0, index: true },
    sortOrder: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AchievementMilestone", achievementMilestoneSchema);
