const mongoose = require("mongoose");

const deliveryCompanyBillingSimulationSchema = new mongoose.Schema(
  {
    deliveryCompany: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryCompany",
      required: true,
      index: true,
    },
    active: { type: Boolean, default: true, index: true },
    closedMonthKey: { type: String, required: true, trim: true },
    countingMonthKey: { type: String, required: true, trim: true },
    startedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

deliveryCompanyBillingSimulationSchema.index(
  { deliveryCompany: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

module.exports = mongoose.model(
  "DeliveryCompanyBillingSimulation",
  deliveryCompanyBillingSimulationSchema,
);
