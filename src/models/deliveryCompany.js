const mongoose = require("mongoose");

const methodToggleSchema = new mongoose.Schema(
  { enabled: { type: Boolean, default: false } },
  { _id: false },
);

const deliveryCompanySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameEn: { type: String, default: "", trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    whatsapp: { type: String, default: "", trim: true, maxlength: 32 },
    address: { type: String, default: "", trim: true, maxlength: 500 },
    description: { type: String, default: "", trim: true, maxlength: 2000 },
    logo: { type: String, default: "" },
    basePrice: { type: Number, required: true, min: 0, default: 0 },
    extraOrderPrice: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: "ILS", trim: true, maxlength: 8 },
    servesAllRegions: { type: Boolean, default: false },
    servedRegionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Region" }],
    paymentMethods: {
      cashOnDelivery: { type: methodToggleSchema, default: () => ({ enabled: true }) },
      agreementWithStore: { type: methodToggleSchema, default: () => ({ enabled: false }) },
      bankPalestine: { type: methodToggleSchema, default: () => ({ enabled: false }) },
      palPay: { type: methodToggleSchema, default: () => ({ enabled: false }) },
      jawwalPay: { type: methodToggleSchema, default: () => ({ enabled: false }) },
    },
    isActive: { type: Boolean, default: true, index: true },
    deletedAt: { type: Date, default: null, index: true },
    /** Hashed shared password for driver self-registration */
    driverRegistrationPasswordHash: { type: String, default: null, select: false },
  },
  { timestamps: true },
);

deliveryCompanySchema.index({ isActive: 1, deletedAt: 1 });

module.exports = mongoose.model("DeliveryCompany", deliveryCompanySchema);
