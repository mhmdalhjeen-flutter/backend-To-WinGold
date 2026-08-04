const mongoose = require("mongoose");

const regionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: "Region", default: null },
    sortOrder: { type: Number, default: 0, index: true },
    /** @deprecated — استخدم parent/sub-regions documents */
    subRegions: [{ type: String, trim: true }],
    isActive: { type: Boolean, default: true },
    /** إحداثيات مركز المنطقة — لخرائط Heat Map مستقبلية */
    centerLat: { type: Number, default: null },
    centerLng: { type: Number, default: null },
  },
  { timestamps: true }
);

regionSchema.index({ parent: 1, sortOrder: 1 });
regionSchema.index({ name: 1, parent: 1 }, { unique: true });

module.exports = mongoose.model("Region", regionSchema);
