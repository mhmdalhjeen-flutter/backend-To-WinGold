const mongoose = require("mongoose");

const reservationAnswerSchema = new mongoose.Schema({
  fieldId: { type: String, required: true, trim: true, maxlength: 80 },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  type: { type: String, default: "text", maxlength: 20 },
  value: { type: String, default: "", maxlength: 500 },
}, { _id: false });

const reservationVariantSchema = new mongoose.Schema({
  id: { type: String, default: "", maxlength: 80 },
  name: { type: String, default: "", maxlength: 80 },
  values: { type: String, default: "", maxlength: 120 },
}, { _id: false });

const reservationSchema = new mongoose.Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Store",
    required: true,
    index: true,
  },
  item: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: "itemType",
  },
  itemType: {
    type: String,
    enum: ["Product", "Offer"],
    required: true,
  },
  itemName: { type: String, default: "", maxlength: 160 },
  itemImage: { type: String, default: "" },
  customerName: { type: String, default: "", maxlength: 120 },
  customerPhone: { type: String, default: "", maxlength: 40 },
  selectedVariant: { type: reservationVariantSchema, default: undefined },
  answers: { type: [reservationAnswerSchema], default: [] },
  status: {
    type: String,
    enum: ["pending", "accepted", "rejected"],
    default: "pending",
    index: true,
  },
  decisionNote: { type: String, default: "", maxlength: 500 },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

reservationSchema.index({ store: 1, createdAt: -1 });
reservationSchema.index({ store: 1, status: 1, createdAt: -1 });
reservationSchema.index({ customer: 1, createdAt: -1 });

module.exports = mongoose.model("Reservation", reservationSchema);
