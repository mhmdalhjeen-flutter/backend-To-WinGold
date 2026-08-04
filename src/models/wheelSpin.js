const mongoose = require("mongoose");

/** سجل تدقيق كل دوران — للأمان ومنع الغش. */
const wheelSpinSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    prize: { type: mongoose.Schema.Types.ObjectId, ref: "WheelPrize", default: null },
    outcome: {
      type: String,
      enum: ["win", "no_win", "locked"],
      required: true,
    },
    pointsCost: { type: Number, default: 0 },
    pointsBefore: { type: Number, default: 0 },
    pointsAfter: { type: Number, default: 0 },
    segmentIndex: { type: Number, default: 0 },
    idempotencyKey: { type: String, default: null },
    ip: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

wheelSpinSchema.index({ user: 1, createdAt: -1 });
wheelSpinSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("WheelSpin", wheelSpinSchema);
