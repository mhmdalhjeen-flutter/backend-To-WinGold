const mongoose = require("mongoose");
const { PAYMENT_TYPE_IDS } = require("../utils/paymentMethodTypes.util");

const deliveryCompanyPaymentAccountSchema = new mongoose.Schema(
  {
    deliveryCompany: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryCompany",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: PAYMENT_TYPE_IDS,
      required: true,
    },
    accountName: { type: String, required: true, trim: true, maxlength: 120 },
    accountNumber: { type: String, required: true, trim: true, maxlength: 64 },
    iban: { type: String, default: "", trim: true, maxlength: 64 },
    qrCodeUrl: { type: String, default: "" },
    isActive: { type: Boolean, default: false },
  },
  { timestamps: true },
);

deliveryCompanyPaymentAccountSchema.index({ deliveryCompany: 1, type: 1, isActive: 1 });
deliveryCompanyPaymentAccountSchema.index({ deliveryCompany: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model(
  "DeliveryCompanyPaymentAccount",
  deliveryCompanyPaymentAccountSchema,
);
