const mongoose = require("mongoose");
const { PAYMENT_STATUSES } = require("../../constants/deliverySession.constants");

const transferInfoSchema = new mongoose.Schema({
  senderName: { type: String, default: "" },
  contactNumber: { type: String, default: "" },
  referenceNumber: { type: String, default: "" },
  note: { type: String, default: "" },
}, { _id: false });

/** Independent delivery payment — separate from store order payments */
const deliveryPaymentSchema = new mongoose.Schema({
  method: { type: String, default: "" },
  status: {
    type: String,
    enum: Object.values(PAYMENT_STATUSES),
    default: PAYMENT_STATUSES.PENDING,
  },
  receiptImage: { type: String, default: "" },
  senderName: { type: String, default: "" },
  senderPhone: { type: String, default: "" },
  transferDetails: { type: transferInfoSchema, default: () => ({}) },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date, default: null },
  notes: { type: String, default: "" },
}, { _id: false });

module.exports = {
  deliveryPaymentSchema,
  transferInfoSchema,
};
