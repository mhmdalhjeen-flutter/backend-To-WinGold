const mongoose = require("mongoose");

const deliveryCompanyOrderHandoverSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true,
      index: true,
    },
    deliveryCompany: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryCompany",
      required: true,
      index: true,
    },
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true,
    },
    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    handoverAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    assignedDriverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryCompanyDriver",
      default: null,
      index: true,
    },
    driverConfirmedAt: {
      type: Date,
      default: null,
      index: true,
    },
    driverConfirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryCompanyDriver",
      default: null,
    },
    driverConfirmationReminderSent: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

deliveryCompanyOrderHandoverSchema.index({ deliveryCompany: 1, handoverAt: -1 });

module.exports = mongoose.model(
  "DeliveryCompanyOrderHandover",
  deliveryCompanyOrderHandoverSchema,
);
