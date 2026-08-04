const mongoose = require("mongoose");

/** منع تكرار المشاهدات للزوار غير المسجّلين خلال نافذة زمنية */
const offerViewDedupSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: true, index: true },
  },
  { timestamps: true }
);

offerViewDedupSchema.index({ clientId: 1, offerId: 1, createdAt: -1 });
offerViewDedupSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 60 });

module.exports =
  mongoose.models.OfferViewDedup ||
  mongoose.model("OfferViewDedup", offerViewDedupSchema);
