const mongoose = require("mongoose");
const { SUBSCRIPTION_STATUSES, DEFAULT_SUBSCRIPTION_CARD_CONFIG } = require("../constants/storeSubscription.constants");
const { PAYMENT_TYPE_IDS } = require("../utils/paymentMethodTypes.util");

const transferInfoSchema = new mongoose.Schema({
  senderName: { type: String, default: "" },
  contactNumber: { type: String, default: "" },
  referenceNumber: { type: String, default: "" },
  note: { type: String, default: "" },
}, { _id: false });

const cardConfigSchema = new mongoose.Schema({
  quantity: { type: Number, min: 0, default: 0 },
  pointsPerCard: { type: Number, min: 1, default: 1 },
}, { _id: false });

const storeSubscriptionPeriodSchema = new mongoose.Schema({
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Store",
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
    enum: Object.values(SUBSCRIPTION_STATUSES),
    required: true,
  },
  paymentMethod: {
    type: String,
    enum: PAYMENT_TYPE_IDS,
  },
  transferInformation: { type: transferInfoSchema, default: () => ({}) },
  paymentProof: { type: String, default: "" },
  paymentProofImage: { type: String, default: "" },
  rejectionReason: { type: String, default: "" },
  cardConfig: {
    digital: {
      type: cardConfigSchema,
      default: () => ({ ...DEFAULT_SUBSCRIPTION_CARD_CONFIG.digital }),
    },
    paper: {
      type: cardConfigSchema,
      default: () => ({ ...DEFAULT_SUBSCRIPTION_CARD_CONFIG.paper }),
    },
  },
  digitalCardsIssued: { type: Number, default: 0, min: 0 },
  paperCardsIssued: { type: Number, default: 0, min: 0 },
  paperCodeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "PromoCode" }],
  cardsIssuedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  exemptedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  exemptedAt: { type: Date, default: null },
  expiredAt: { type: Date, default: null },
}, { timestamps: true });

storeSubscriptionPeriodSchema.index({ store: 1, monthKey: 1 }, { unique: true });
storeSubscriptionPeriodSchema.index({ monthKey: 1, status: 1 });

module.exports = mongoose.model("StoreSubscriptionPeriod", storeSubscriptionPeriodSchema);
