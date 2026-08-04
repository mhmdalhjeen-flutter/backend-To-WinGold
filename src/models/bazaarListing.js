const mongoose = require("mongoose");

const LISTING_DAYS = 7;
const POINTS_COST = 3;

const BAZAAR_CATEGORIES = [
  "cars", "bikes", "phones", "tablets", "computers", "electronics",
  "home_appliances", "furniture", "furnishings", "real_estate", "land",
  "clothing", "shoes", "bags", "watches", "jewelry", "kids_toys",
  "kids_supplies", "sports", "professional", "animals", "books",
  "collectibles", "building_materials", "garden", "other",
];

const BAZAAR_CONDITIONS = ["new", "like_new", "good", "used"];

const bazaarListingSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    condition: {
      type: String,
      enum: BAZAAR_CONDITIONS,
      required: function requiredCondition() {
        return this.transactionType !== "custom";
      },
      default: "used",
    },
    category: {
      type: String,
      enum: BAZAAR_CATEGORIES,
      index: true,
    },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ["ILS", "JOD", "USD"], default: "ILS" },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    images: { type: [String], default: [], validate: [(v) => v.length <= 3, "3 صور كحد أقصى"] },
    mainImageIndex: { type: Number, default: 0, min: 0 },
    freeDelivery: { type: Boolean, default: false },
    transactionType: {
      type: String,
      enum: ["sell", "buy", "exchange", "custom", "rent"],
      required: true,
    },
    keywords: {
      type: [String],
      validate: {
        validator(value) {
          const list = value || [];
          if (this.transactionType === "custom") return list.length <= 5;
          return list.length >= 2 && list.length <= 5;
        },
        message: "2–5 كلمات مفتاحية (أو بدون كلمات لإعلانات الطلب)",
      },
    },
    contactPhone: { type: String, trim: true, default: "" },
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: "Region", index: true },
    subRegionId: { type: mongoose.Schema.Types.ObjectId, ref: "Region" },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "expired"],
      default: "pending",
      index: true,
    },
    isVisible: { type: Boolean, default: false, index: true },
    adminReview: {
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      reviewedAt: Date,
      note: { type: String, default: "" },
    },
    expiresAt: { type: Date, index: true },
    renewalWarningSent: { type: Boolean, default: false },
    favoritedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);

bazaarListingSchema.index({ keywords: 1 });
bazaarListingSchema.index({ title: "text", keywords: "text", description: "text" });
bazaarListingSchema.index({ status: 1, isVisible: 1, expiresAt: 1, createdAt: -1 });
bazaarListingSchema.index({ status: 1, isVisible: 1, regionId: 1, createdAt: -1 });

bazaarListingSchema.virtual("mainImage").get(function mainImage() {
  if (!this.images?.length) return null;
  const idx = Math.min(this.mainImageIndex || 0, this.images.length - 1);
  return this.images[idx];
});

bazaarListingSchema.set("toJSON", { virtuals: true });
bazaarListingSchema.set("toObject", { virtuals: true });

bazaarListingSchema.statics.LISTING_DAYS = LISTING_DAYS;
bazaarListingSchema.statics.POINTS_COST = POINTS_COST;
bazaarListingSchema.statics.BAZAAR_CATEGORIES = BAZAAR_CATEGORIES;
bazaarListingSchema.statics.BAZAAR_CONDITIONS = BAZAAR_CONDITIONS;

module.exports = mongoose.model("BazaarListing", bazaarListingSchema);
