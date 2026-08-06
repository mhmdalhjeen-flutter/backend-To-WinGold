const mongoose = require("mongoose");
const { PAYMENT_TYPE_IDS } = require("../utils/paymentMethodTypes.util");

const storePaymentMethodSchema = new mongoose.Schema(
  {
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: PAYMENT_TYPE_IDS,
      required: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    accountNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    /** merchant | personal */
    accountType: {
      type: String,
      enum: ["merchant", "personal"],
      default: "merchant",
    },
    iban: {
      type: String,
      default: "",
      trim: true,
      maxlength: 64,
    },
    barcodeImage: {
      type: String,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

storePaymentMethodSchema.index({ store: 1, type: 1, isActive: 1 });
storePaymentMethodSchema.index({ store: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model("StorePaymentMethod", storePaymentMethodSchema);
