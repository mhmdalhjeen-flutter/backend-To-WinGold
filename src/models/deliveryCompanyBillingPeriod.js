const mongoose = require("mongoose");
const { BILLING_STATUSES, DEFAULT_PRICE_PER_ORDER } = require("../constants/deliveryBilling.constants");
const { PAYMENT_TYPE_IDS } = require("../utils/paymentMethodTypes.util");

const transferInfoSchema = new mongoose.Schema({
  senderName: { type: String, default: "" },
  contactNumber: { type: String, default: "" },
  referenceNumber: { type: String, default: "" },
  note: { type: String, default: "" },
}, { _id: false });

const deliveryCompanyBillingPeriodSchema = new mongoose.Schema({
  deliveryCompany: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DeliveryCompany",
    required: true,
    index: true,
  },
  monthKey: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  status: {
    type: String,
    enum: Object.values(BILLING_STATUSES),
    required: true,
  },
  deliveredOrderCount: { type: Number, default: 0, min: 0 },
  pricePerOrder: { type: Number, default: DEFAULT_PRICE_PER_ORDER, min: 0 },
  amountDue: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: "ILS", trim: true, maxlength: 8 },
  paymentMethod: {
    type: String,
    enum: PAYMENT_TYPE_IDS,
  },
  transferInformation: { type: transferInfoSchema, default: () => ({}) },
  paymentProof: { type: String, default: "" },
  paymentProofImage: { type: String, default: "" },
  rejectionReason: { type: String, default: "" },
  billingFinalizedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  exemptedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  exemptedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  /** null = real production billing; set during isolated billing simulations only */
  simulationSessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DeliveryCompanyBillingSimulation",
    default: null,
    index: true,
  },
}, { timestamps: true });

deliveryCompanyBillingPeriodSchema.index(
  { deliveryCompany: 1, monthKey: 1, simulationSessionId: 1 },
  { unique: true },
);
deliveryCompanyBillingPeriodSchema.index({ monthKey: 1, status: 1 });
deliveryCompanyBillingPeriodSchema.index({ deliveryCompany: 1, status: 1, closedAt: 1 });

module.exports = mongoose.model("DeliveryCompanyBillingPeriod", deliveryCompanyBillingPeriodSchema);
