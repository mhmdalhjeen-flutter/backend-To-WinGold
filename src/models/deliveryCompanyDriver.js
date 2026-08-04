const mongoose = require("mongoose");

const deliveryCompanyDriverSchema = new mongoose.Schema(
  {
    deliveryCompany: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeliveryCompany",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    whatsapp: { type: String, default: "", trim: true, maxlength: 32 },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

deliveryCompanyDriverSchema.index({ deliveryCompany: 1, name: 1 });
deliveryCompanyDriverSchema.index({ deliveryCompany: 1, phone: 1 });

module.exports = mongoose.model("DeliveryCompanyDriver", deliveryCompanyDriverSchema);
