const mongoose = require("mongoose");
const { SUBSCRIPTION_PAYMENT_METHOD_TYPES } = require("../constants/storeSubscription.constants");
const { normalizeAccountKind } = require("../utils/paymentMethodTypes.util");

const platformSubscriptionPaymentAccountSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: SUBSCRIPTION_PAYMENT_METHOD_TYPES,
      required: true,
    },
    accountName: { type: String, required: true, trim: true, maxlength: 120 },
    accountNumber: { type: String, required: true, trim: true, maxlength: 64 },
    accountType: {
      type: String,
      enum: ["merchant", "personal"],
      default: "merchant",
      set: normalizeAccountKind,
    },
    iban: { type: String, default: "", trim: true, maxlength: 64 },
    barcodeImage: { type: String, default: "" },
    isEnabled: { type: Boolean, default: true },
    isActive: { type: Boolean, default: false },
  },
  { timestamps: true },
);

platformSubscriptionPaymentAccountSchema.index({ type: 1, isActive: 1 });
platformSubscriptionPaymentAccountSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model(
  "PlatformSubscriptionPaymentAccount",
  platformSubscriptionPaymentAccountSchema,
);
