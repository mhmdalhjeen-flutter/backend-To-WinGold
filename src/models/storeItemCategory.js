const mongoose = require("mongoose");

const storeItemCategorySchema = new mongoose.Schema(
  {
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

storeItemCategorySchema.index({ store: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("StoreItemCategory", storeItemCategorySchema);
