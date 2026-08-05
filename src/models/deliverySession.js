const mongoose = require("mongoose");
const { SESSION_STATUS_VALUES, SESSION_STATUSES } = require("../constants/deliverySession.constants");
const { deliveryPaymentSchema, transferInfoSchema } = require("./schemas/deliveryPayment.schema");

/** All statuses including legacy values stored in older documents */
const STORED_STATUS_ENUM = [
  ...SESSION_STATUS_VALUES,
  "waiting_for_acceptance",
  "driver_assigned",
  "collecting_orders",
  "on_delivery",
  "on_the_way",
  "delivered",
];

const statusTimelineSchema = new mongoose.Schema({
  status: { type: String, required: true },
  at: { type: Date, default: Date.now },
  note: { type: String, default: "" },
}, { _id: false });

const storeStopSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true },
  storeOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  storeName: { type: String, default: "" },
  storePhone: { type: String, default: "" },
  storeWhatsapp: { type: String, default: "" },
  storeAddress: { type: String, default: "" },
  orderNumber: { type: String, default: "" },
  verificationCode: { type: String, default: "" },
  orderStatus: { type: String, default: "pending" },
  collectionStatus: {
    type: String,
    enum: ["pending", "collected"],
    default: "pending",
  },
  collectedAt: { type: Date, default: null },
}, { _id: false });

const feeBreakdownSchema = new mongoose.Schema({
  basePrice: { type: Number, default: 0, min: 0 },
  extraOrderPrice: { type: Number, default: 0, min: 0 },
  orderCount: { type: Number, default: 0, min: 0 },
  extraOrderCount: { type: Number, default: 0, min: 0 },
  totalFee: { type: Number, default: 0, min: 0 },
}, { _id: false });

const assignedDriverSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: "DeliveryCompanyDriver", default: null },
  name: { type: String, default: "" },
  phone: { type: String, default: "" },
  whatsapp: { type: String, default: "" },
  note: { type: String, default: "" },
  assignedAt: { type: Date, default: null },
}, { _id: false });

const deliverySessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, default: "", index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    deliveryCompany: { type: mongoose.Schema.Types.ObjectId, ref: "DeliveryCompany", required: true, index: true },
    /** @deprecated legacy User driver ref — use assignedDriver */
    driver: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    assignedDriver: { type: assignedDriverSchema, default: null },
    orders: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
    storeStops: [storeStopSchema],
    status: {
      type: String,
      enum: STORED_STATUS_ENUM,
      default: SESSION_STATUSES.WAITING,
      index: true,
    },
    statusTimeline: [statusTimelineSchema],
    deliveryAddress: { type: String, default: "" },
    deliveryArea: { type: String, default: "" },
    deliveryLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    regionId: { type: mongoose.Schema.Types.ObjectId, ref: "Region", default: null },
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    customerWhatsapp: { type: String, default: "" },
    deliveryFee: { type: Number, default: 0, min: 0 },
    feeBreakdown: { type: feeBreakdownSchema, default: () => ({}) },
    currency: { type: String, default: "ILS" },
    payment: { type: deliveryPaymentSchema, default: () => ({}) },
    /** @deprecated use payment.* — kept for backward compatibility */
    paymentMethod: { type: String, default: "" },
    paymentStatus: { type: String, default: "pending" },
    paymentVerified: { type: Boolean, default: false },
    paymentVerifiedAt: { type: Date, default: null },
    paymentNotes: { type: String, default: "" },
    paymentProof: { type: String, default: "" },
    transferInformation: { type: transferInfoSchema, default: () => ({}) },
    submittedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
    rejectionReason: { type: String, default: "" },
    driverDeliveryProof: { type: String, default: "" },
    driverDeliveryNote: { type: String, default: "", maxlength: 1000 },
    driverDeliveredAt: { type: Date, default: null },
    driverCompletionSyncId: { type: String, default: "", index: true, sparse: true },
  },
  { timestamps: true },
);

deliverySessionSchema.index({ deliveryCompany: 1, status: 1, createdAt: -1 });
deliverySessionSchema.index({ driver: 1, status: 1, createdAt: -1 });
deliverySessionSchema.index({ customer: 1, status: 1, createdAt: -1 });
deliverySessionSchema.index({ customer: 1, sessionId: 1 }, { unique: true, sparse: true });

const COLLECTION = "deliverygroups";

const DeliverySession =
  mongoose.models.DeliverySession ||
  mongoose.model("DeliverySession", deliverySessionSchema, COLLECTION);

module.exports = DeliverySession;
module.exports.deliverySessionSchema = deliverySessionSchema;
module.exports.STORED_STATUS_ENUM = STORED_STATUS_ENUM;
